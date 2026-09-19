import React, { useEffect, useRef, useState } from 'react';
import Editor, { Monaco } from '@monaco-editor/react';
import type { languages, Position, editor as monacoEditor } from 'monaco-editor';
import { ProjectSymbol, findUnknownReferences } from '../../services/latexSymbols';
import {
  CompletionItemKindKey,
  EMPTY_COMPLETION_SOURCES,
  LatexCompletion,
  ProjectCompletionSources,
  completionsAt,
  mathWindow
} from '../../services/latexCompletions';
import { isInsideMath } from '../../services/symbolPalette';
import { WordCount, countWords } from '../../services/textStats';
import { EditorStatusBar } from './EditorStatusBar';

export interface EditorInsertion {
  text: string;
  /** Wrap in $...$ when the caret is not already inside maths. */
  math?: boolean;
  nonce: number;
}

interface LaTeXEditorProps {
  content: string;
  onChange: (value: string | undefined) => void;
  fileName: string;
  /**
   * URI for this file's Monaco model. Every file used to share one model and
   * therefore one undo stack, so Ctrl+Z after switching files replaced the
   * current file's buffer with the previous file's text — which was then saved
   * and pushed to Overleaf. Must be unique per project *and* per file.
   */
  modelPath: string;
  /** Citation keys from the project's .bib files. */
  citations?: ProjectSymbol[];
  /** \label targets from the project's sources. */
  labels?: ProjectSymbol[];
  /** Environments, file names, figures and packages this project already has. */
  sources?: ProjectCompletionSources;
  /** Set to jump the caret somewhere, e.g. from a compiler error. */
  revealLine?: { line: number; nonce: number } | null;
  /** Set to type something in at the caret, e.g. a symbol or a figure block. */
  insertion?: EditorInsertion | null;
  /** Stores a pasted image and returns the path it was given, or null. */
  onPasteImage?: (blob: Blob) => Promise<string | null>;
  wordCount: WordCount;
  onOpenWordDetails: () => void;
}

/**
 * Monaco ships no LaTeX language, so `defaultLanguage="latex"` was quietly
 * falling back to plaintext: no highlighting, and completion providers
 * registered for 'latex' were never consulted. Registering it fixes both.
 */
const registerLatexLanguage = (monaco: Monaco) => {
  if (monaco.languages.getLanguages().some((language: any) => language.id === 'latex')) return;

  monaco.languages.register({ id: 'latex', extensions: ['.tex', '.sty', '.cls', '.bib'] });

  monaco.languages.setMonarchTokensProvider('latex', {
    defaultToken: '',
    tokenizer: {
      root: [
        [/%.*$/, 'comment'],
        [/\\(?:begin|end)\s*\{[^}]*\}/, 'keyword'],
        [/\\[a-zA-Z@]+\*?/, 'type'],
        [/\\[^a-zA-Z]/, 'type'],
        [/\$\$/, { token: 'string', next: '@displayMath' }],
        [/\$/, { token: 'string', next: '@inlineMath' }],
        [/[{}]/, 'delimiter.bracket'],
        [/[[\]]/, 'delimiter.square']
      ],
      displayMath: [
        [/\$\$/, { token: 'string', next: '@pop' }],
        [/[^$]+/, 'string'],
        [/\$/, 'string']
      ],
      inlineMath: [
        [/\$/, { token: 'string', next: '@pop' }],
        [/[^$]+/, 'string']
      ]
    }
  });

  // No `wordPattern` override on purpose: Monaco filters a suggestion against
  // the text from that item's own range.startColumn, not against the word
  // pattern, so widening it would buy nothing and would silently change
  // double-click selection and Ctrl+arrow motion everywhere.
  monaco.languages.setLanguageConfiguration('latex', {
    comments: { lineComment: '%' },
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')']
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '$', close: '$' }
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '$', close: '$' }
    ]
  });
};

/**
 * Hoisted out of the JSX because `@monaco-editor/react` re-runs
 * `editor.updateOptions(options)` whenever the object's identity changes — an
 * inline literal meant every keystroke reconfigured the whole editor.
 *
 * Annotated rather than `as const`: the options interface has readonly-array
 * fields, and a frozen literal stops assigning to them the moment one is used.
 */
const EDITOR_OPTIONS: monacoEditor.IStandaloneEditorConstructionOptions = {
  fontSize: 14,
  fontFamily: "'Fira Code', monospace",
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  wordWrap: 'on',
  lineNumbers: 'on',
  automaticLayout: true,
  tabSize: 2,

  // Tab did nothing but indent because `tabCompletion` sat at its 'off'
  // default, which leaves Monaco's `insertBestCompletion` command permanently
  // unbound. Turning it on is the whole fix — and it is only safe alongside
  // the three things below, because Tab now runs a suggest round trip at the
  // end of every word:
  //   * `wordBasedSuggestions: 'off'` and `suggest.showWords: false` stop the
  //     scraped-document-words noise that made the old list useless;
  //   * the provider returns nothing at all in prose, so Tab there falls
  //     through to the `tab` command and still indents;
  //   * every item carries an explicit range, without which Tab would insert
  //     a second backslash on top of the one already typed.
  // No custom Tab keybinding is registered: Monaco already binds Tab three
  // ways, gated on the context keys `suggestWidgetVisible` (accept the
  // selected suggestion), `inSnippetMode` (jump to the next tab stop) and
  // neither (`insertBestCompletion`, which declares `fallback: 'tab'` so plain
  // indentation survives). A keybinding added here would outrank all three and
  // would have to reimplement them.
  tabCompletion: 'on',
  // Kept explicit: the backslash trigger character below depends on it.
  suggestOnTriggerCharacters: true,
  suggestSelection: 'first',
  snippetSuggestions: 'inline',
  wordBasedSuggestions: 'off',
  // `strings: 'on'` is load-bearing: the Monarch grammar above tokenises
  // `$...$` as `string`, and the default is 'off', so nothing ever opened
  // inside maths — where a symbol list is most wanted.
  quickSuggestions: { other: 'on', comments: 'off', strings: 'on' },
  suggest: {
    // Tab is bound to accept-suggestion at a higher weight than
    // jump-to-next-placeholder, so a widget opened by quick suggestions inside
    // a snippet placeholder steals Tab from the tab stops. The few items that
    // land the caret in a brace worth completing ask for the list back
    // explicitly instead — see `command` in `toSuggestion`.
    snippetsPreventQuickSuggestions: true,
    // The default 'insert' ignores the replace half of each item's range, so
    // completing in the middle of `\begin{fig|ure}` would double the word.
    insertMode: 'replace',
    // Lets `\alph` reach `\alpha` through a synonym folded into filterText.
    matchOnWordStartOnly: false,
    filterGraceful: true,
    selectionMode: 'always',
    showWords: false
  }
};

export const LaTeXEditor: React.FC<LaTeXEditorProps> = ({
  content,
  onChange,
  fileName,
  modelPath,
  citations = [],
  labels = [],
  sources = EMPTY_COMPLETION_SOURCES,
  revealLine = null,
  insertion = null,
  onPasteImage,
  wordCount,
  onOpenWordDetails
}) => {
  // The completion provider is registered once, but the lists change as files
  // are edited, so it reads them through a ref rather than closing over a copy.
  const sourcesRef = useRef({ citations, labels, sources });
  sourcesRef.current = { citations, labels, sources };

  const registration = useRef<{ dispose: () => void } | null>(null);
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const pasteHandler = useRef<((event: ClipboardEvent) => void) | null>(null);
  const pasteTarget = useRef<HTMLElement | null>(null);
  // The listener is attached once at mount, so it must reach the current
  // handler rather than the one that existed back then.
  const pasteImage = useRef(onPasteImage);
  pasteImage.current = onPasteImage;

  const [caret, setCaret] = useState({ line: 1, column: 1 });
  const [selectionWords, setSelectionWords] = useState(0);

  useEffect(
    () => () => {
      registration.current?.dispose();
      if (pasteTarget.current && pasteHandler.current) {
        pasteTarget.current.removeEventListener('paste', pasteHandler.current, true);
      }
    },
    []
  );

  // Underline citation and reference keys that do not exist, which otherwise only
  // surface as [?] in the compiled PDF.
  //
  // `modelPath` is in the dependency list because each file now has its own
  // model: switching to a file whose text happens to be identical changes
  // nothing else here, and the new model would be left with no markers at all.
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;

    const model = editor.getModel();
    if (!model) return;

    const markers = findUnknownReferences(content, citations, labels).map(problem => ({
      severity: monaco.MarkerSeverity.Warning,
      message:
        problem.kind === 'citation'
          ? `No entry "${problem.key}" in the .bib files of this project.`
          : `No \\label{${problem.key}} in this project.`,
      startLineNumber: problem.line,
      endLineNumber: problem.line,
      startColumn: problem.column,
      endColumn: problem.column + problem.length
    }));

    monaco.editor.setModelMarkers(model, 'zabbleaf', markers);
  }, [content, citations, labels, modelPath]);

  // Jump to a line, used when a compiler error is clicked.
  useEffect(() => {
    if (!revealLine || !editorRef.current) return;
    editorRef.current.revealLineInCenter(revealLine.line);
    editorRef.current.setPosition({ lineNumber: revealLine.line, column: 1 });
    editorRef.current.focus();
  }, [revealLine?.nonce]);

  // Type something in at the caret: a symbol from the palette, or the figure
  // block for an image that was just dropped in.
  useEffect(() => {
    const editor = editorRef.current;
    if (!insertion || !editor) return;
    insertAtCaret(insertion.text, insertion.math);
  }, [insertion?.nonce]);

  /** Writes at the caret, replacing the selection when there is one. */
  const insertAtCaret = (text: string, wrapMath = false) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;

    const selection = editor.getSelection();
    let payload = text;

    if (wrapMath) {
      const before = model.getValueInRange({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: selection.startLineNumber,
        endColumn: selection.startColumn
      });
      if (!isInsideMath(before)) payload = `$${text}$`;
    }

    editor.executeEdits('zabbleaf', [{ range: selection, text: payload, forceMoveMarkers: true }]);
    editor.pushUndoStop();
    editor.focus();
  };

  /**
   * Intercepts a pasted image before Monaco sees it.
   *
   * The handler sits on the editor container in the capture phase, which is the
   * only place it can run before Monaco's own hidden textarea handles the
   * event — and the only way to stop a screenshot from being pasted as nothing
   * at all, which is what used to happen.
   */
  const handlePaste = async (event: ClipboardEvent) => {
    const store = pasteImage.current;
    if (!store || !event.clipboardData) return;

    const image = Array.from(event.clipboardData.items).find(item =>
      item.type.startsWith('image/')
    );
    if (!image) return;

    // Copying from a word processor carries both text and a picture of it; the
    // text is what the user meant.
    const text = event.clipboardData.getData('text/plain');
    if (text.trim()) return;

    const blob = image.getAsFile();
    if (!blob) return;

    event.preventDefault();
    event.stopPropagation();

    const path = await store(blob);
    if (path) insertAtCaret(path);
  };

  const handleMount = (editor: any, monaco: Monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    registration.current?.dispose();

    editor.onDidChangeCursorPosition((event: any) => {
      setCaret({ line: event.position.lineNumber, column: event.position.column });
    });

    editor.onDidChangeCursorSelection((event: any) => {
      const model = editor.getModel();
      const selected = model?.getValueInRange(event.selection) || '';
      // Wrapped so the counter sees a body rather than looking for a preamble.
      setSelectionWords(
        selected.trim()
          ? countWords(`\\begin{document}${selected}\\end{document}`).words
          : 0
      );
    });

    const node = editor.getDomNode();
    if (node && onPasteImage) {
      const listener = (event: ClipboardEvent) => {
        void handlePaste(event);
      };
      node.addEventListener('paste', listener, true);
      pasteTarget.current = node;
      pasteHandler.current = listener;
    }

    // Never `Text`: `suggest.showWords: false` filters that kind straight out
    // of the list, so an item given it would be built and then thrown away.
    const kinds = monaco.languages.CompletionItemKind;
    const KIND_MAP: Record<CompletionItemKindKey, languages.CompletionItemKind> = {
      command: kinds.Function,
      symbol: kinds.Operator,
      environment: kinds.Class,
      snippet: kinds.Snippet,
      citation: kinds.Reference,
      label: kinds.Variable,
      package: kinds.Module,
      file: kinds.File
    };
    const rules = monaco.languages.CompletionItemInsertTextRule;

    const toSuggestion = (
      item: LatexCompletion,
      position: Position
    ): languages.CompletionItem => ({
      label: item.label,
      kind: KIND_MAP[item.kindKey],
      detail: item.detail,
      documentation: item.documentation ? { value: item.documentation } : undefined,
      insertText: item.insertText,
      // Only the bodies that carry tab stops go through the snippet parser; a
      // citation key or a bare \alpha is literal text and would lose its
      // backslash to it.
      insertTextRules: item.isSnippet ? rules.InsertAsSnippet : rules.None,
      filterText: item.filterText,
      sortText: item.sortText,
      commitCharacters: item.commitCharacters,
      preselect: item.preselect,
      // Accepting `\cite` leaves the caret inside a live snippet placeholder,
      // where `snippetsPreventQuickSuggestions` below blocks quick suggestions
      // outright — so typing the first letters of a key opened nothing at all,
      // on the one interaction this feature is advertised on. Monaco special-
      // cases this command id and re-triggers the widget itself after the
      // insert (`SuggestController._insertSuggestion`), which is the only path
      // into the list that the snippet session does not close off. Once it is
      // open, further typing refilters rather than re-triggering, so the rest
      // of the key narrows the list normally.
      command: item.retrigger
        ? { id: 'editor.action.triggerSuggest', title: 'Suggest' }
        : undefined,
      // Monaco's own `getWordUntilPosition` stops at `\`, `:`, `-` and `.`, so
      // the default range excludes the backslash the user just typed: the list
      // filtered itself to nothing, and accepting inside `\cite{knuth:19`
      // wrote `\cite{knuth:knuth:1984`. Both ranges must be single-line, on the
      // request's line, and share a startColumn or Monaco discards the item.
      range: {
        insert: {
          startLineNumber: position.lineNumber,
          startColumn: item.startColumn,
          endLineNumber: position.lineNumber,
          endColumn: item.insertEndColumn
        },
        replace: {
          startLineNumber: position.lineNumber,
          startColumn: item.startColumn,
          endLineNumber: position.lineNumber,
          endColumn: item.replaceEndColumn
        }
      }
    });

    registration.current = monaco.languages.registerCompletionItemProvider('latex', {
      // '\\' is ONE backslash at runtime. Monaco compares each trigger against
      // a single typed character, so a two-character string here would never
      // fire — and the backslash is the trigger this whole feature turns on.
      // '/' reopens the widget part-way through `\input{chapters/`, and ',' is
      // safe because the provider returns nothing outside a comma list.
      triggerCharacters: ['\\', '{', ',', '/'],
      // Annotated rather than inferred: `@monaco-editor/react` types `Monaco`
      // through a deep `monaco-editor/esm/...` import that its `exports` map no
      // longer resolves, so the whole namespace lands here as `any`.
      provideCompletionItems: (model: monacoEditor.ITextModel, position: Position) => {
        const line = model.getLineContent(position.lineNumber);
        const live = sourcesRef.current;

        const items = completionsAt({
          lineBefore: line.slice(0, position.column - 1),
          lineAfter: line.slice(position.column - 1),
          mathBefore: mathWindow(
            lineNumber => model.getLineContent(lineNumber),
            position.lineNumber,
            position.column
          ),
          // Left as closures: only a caret inside `\begin{`/`\end{` needs the
          // rest of the document, and building either on every prose keystroke
          // would copy the whole chapter.
          documentBefore: () =>
            model.getValueInRange({
              startLineNumber: 1,
              startColumn: 1,
              endLineNumber: position.lineNumber,
              endColumn: position.column
            }),
          documentAfter: () =>
            model.getValueInRange({
              startLineNumber: position.lineNumber,
              startColumn: position.column,
              endLineNumber: model.getLineCount(),
              endColumn: model.getLineMaxColumn(model.getLineCount())
            }),
          lineNumber: position.lineNumber,
          column: position.column,
          citations: live.citations,
          labels: live.labels,
          sources: live.sources
        });

        return { suggestions: items.map(item => toSuggestion(item, position)) };
      }
    });
  };

  return (
    <div className="editor-pane">
      <div className="pane-header">
        <span>📄 {fileName}</span>
        <span style={{ fontSize: '0.75rem', color: '#7b8593' }}>LaTeX Code Editor</span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Editor
          height="100%"
          path={modelPath}
          defaultLanguage="latex"
          theme="vs-dark"
          value={content}
          onChange={onChange}
          beforeMount={registerLatexLanguage}
          onMount={handleMount}
          options={EDITOR_OPTIONS}
        />
      </div>

      <EditorStatusBar
        count={wordCount}
        selectionWords={selectionWords}
        line={caret.line}
        column={caret.column}
        onOpenDetails={onOpenWordDetails}
      />
    </div>
  );
};

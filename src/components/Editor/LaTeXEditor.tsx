import React, { useEffect, useRef, useState } from 'react';
import Editor, { Monaco } from '@monaco-editor/react';
import {
  ProjectSymbol,
  isInsideCommand,
  findUnknownReferences,
  LATEX_SNIPPETS
} from '../../services/latexSymbols';
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
  /** Citation keys from the project's .bib files. */
  citations?: ProjectSymbol[];
  /** \label targets from the project's sources. */
  labels?: ProjectSymbol[];
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

export const LaTeXEditor: React.FC<LaTeXEditorProps> = ({
  content,
  onChange,
  fileName,
  citations = [],
  labels = [],
  revealLine = null,
  insertion = null,
  onPasteImage,
  wordCount,
  onOpenWordDetails
}) => {
  // The completion provider is registered once, but the lists change as files
  // are edited, so it reads them through a ref rather than closing over a copy.
  const symbols = useRef({ citations, labels });
  symbols.current = { citations, labels };

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
  }, [content, citations, labels]);

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

    registration.current = monaco.languages.registerCompletionItemProvider('latex', {
      triggerCharacters: ['{', ','],
      provideCompletionItems: (model: any, position: any) => {
        const before = model.getValueInRange({
          startLineNumber: position.lineNumber,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column
        });

        const wanted = isInsideCommand(before, ['cite', 'citep', 'citet', 'parencite', 'textcite', 'autocite'])
          ? symbols.current.citations
          : isInsideCommand(before, ['ref', 'eqref', 'autoref', 'cref', 'Cref', 'pageref'])
            ? symbols.current.labels
            : null;

        const word = model.getWordUntilPosition(position);
        const here = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn
        };

        // Outside a citation or reference, offer the blocks nobody remembers
        // the syntax of.
        if (!wanted) {
          return {
            suggestions: LATEX_SNIPPETS.map(snippet => ({
              label: snippet.label,
              kind: monaco.languages.CompletionItemKind.Snippet,
              detail: snippet.detail,
              insertText: snippet.body,
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              range: here
            }))
          };
        }

        if (wanted.length === 0) return { suggestions: [] };

        return {
          suggestions: wanted.map(symbol => ({
            label: symbol.key,
            kind: monaco.languages.CompletionItemKind.Reference,
            detail: symbol.detail,
            insertText: symbol.key,
            range: here
          }))
        };
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
          defaultLanguage="latex"
          theme="vs-dark"
          value={content}
          onChange={onChange}
          beforeMount={registerLatexLanguage}
          onMount={handleMount}
          options={{
            fontSize: 14,
            fontFamily: "'Fira Code', monospace",
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            lineNumbers: 'on',
            automaticLayout: true,
            tabSize: 2
          }}
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

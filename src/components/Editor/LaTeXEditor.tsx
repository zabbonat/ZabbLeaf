import React, { useEffect, useRef } from 'react';
import Editor, { Monaco } from '@monaco-editor/react';
import {
  ProjectSymbol,
  isInsideCommand,
  findUnknownReferences,
  LATEX_SNIPPETS
} from '../../services/latexSymbols';

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
  revealLine = null
}) => {
  // The completion provider is registered once, but the lists change as files
  // are edited, so it reads them through a ref rather than closing over a copy.
  const symbols = useRef({ citations, labels });
  symbols.current = { citations, labels };

  const registration = useRef<{ dispose: () => void } | null>(null);
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<Monaco | null>(null);
  useEffect(() => () => registration.current?.dispose(), []);

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

  const handleMount = (editor: any, monaco: Monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    registration.current?.dispose();

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
      <div style={{ flex: 1 }}>
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
    </div>
  );
};

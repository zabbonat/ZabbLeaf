/**
 * Collects everything in a project that says "not finished yet".
 *
 * The notes are already there — scattered as % TODO comments, \todo{} margin
 * notes and \missingfigure placeholders across a dozen files. What was missing
 * is one list answering "what is left before I submit this?", which is also
 * where unresolved \cite and \ref keys belong: they never stop a compile, they
 * just come out as [?] in the PDF.
 */

import { ProjectSymbol, findUnknownReferences } from './latexSymbols';

export type TodoKind = 'todo' | 'fixme' | 'note' | 'missing-figure' | 'citation' | 'label';

export interface TodoItem {
  id: string;
  kind: TodoKind;
  text: string;
  fileName: string;
  line: number;
}

/** Comment markers: % TODO: rewrite this. */
const MARKERS: { pattern: RegExp; kind: TodoKind }[] = [
  { pattern: /%+\s*TODO\b:?\s*(.*)$/i, kind: 'todo' },
  { pattern: /%+\s*FIXME\b:?\s*(.*)$/i, kind: 'fixme' },
  { pattern: /%+\s*(?:NOTE|XXX)\b:?\s*(.*)$/i, kind: 'note' }
];

/** The todonotes package, for people who prefer notes in the margin. */
const COMMANDS: { pattern: RegExp; kind: TodoKind }[] = [
  { pattern: /\\missingfigure\s*(?:\[[^\]]*\])?\{([^}]*)\}/i, kind: 'missing-figure' },
  { pattern: /\\todo\s*(?:\[[^\]]*\])?\{([^}]*)\}/i, kind: 'todo' }
];

export function collectTodos(
  files: { name: string; content: string }[],
  citations: ProjectSymbol[] = [],
  labels: ProjectSymbol[] = []
): TodoItem[] {
  const items: TodoItem[] = [];

  for (const file of files) {
    const lower = file.name.toLowerCase();
    if (!lower.endsWith('.tex') && !lower.endsWith('.bib')) continue;

    file.content.split('\n').forEach((line, index) => {
      let claimed = false;

      for (const { pattern, kind } of COMMANDS) {
        const hit = line.match(pattern);
        if (!hit) continue;
        items.push({
          id: `${file.name}:${index}:${kind}`,
          kind,
          text: hit[1].trim() || (kind === 'missing-figure' ? 'Missing figure' : 'To do'),
          fileName: file.name,
          line: index + 1
        });
        claimed = true;
      }

      // A \todo{} already reported above should not come back as a comment.
      if (claimed) return;

      for (const { pattern, kind } of MARKERS) {
        const hit = line.match(pattern);
        if (!hit) continue;
        items.push({
          id: `${file.name}:${index}:${kind}`,
          kind,
          text: hit[1].trim() || 'To do',
          fileName: file.name,
          line: index + 1
        });
        break;
      }
    });

    if (lower.endsWith('.tex')) {
      for (const problem of findUnknownReferences(file.content, citations, labels)) {
        items.push({
          id: `${file.name}:${problem.line}:${problem.kind}:${problem.key}`,
          kind: problem.kind,
          text:
            problem.kind === 'citation'
              ? `${problem.key} — no entry with this key in the .bib files`
              : `${problem.key} — no \\label with this key anywhere`,
          fileName: file.name,
          line: problem.line
        });
      }
    }
  }

  const rank: Record<TodoKind, number> = {
    fixme: 0,
    todo: 1,
    'missing-figure': 2,
    citation: 3,
    label: 4,
    note: 5
  };

  return items.sort(
    (a, b) =>
      rank[a.kind] - rank[b.kind] || a.fileName.localeCompare(b.fileName) || a.line - b.line
  );
}

export const TODO_LABELS: Record<TodoKind, { label: string; color: string }> = {
  todo: { label: 'TODO', color: '#d1a054' },
  fixme: { label: 'FIXME', color: '#c97b7b' },
  note: { label: 'NOTE', color: '#89a7bd' },
  'missing-figure': { label: 'FIGURE', color: '#d1a054' },
  citation: { label: 'CITATION', color: '#c97b7b' },
  label: { label: 'REFERENCE', color: '#c97b7b' }
};

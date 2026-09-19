/**
 * The data behind LaTeX autocompletion: what to offer, where, and what span of
 * text accepting it is allowed to overwrite.
 *
 * Typing `\beg` used to open nothing, because `\` is neither a trigger
 * character nor a word character; and when the widget did open, the range came
 * from Monaco's `getWordUntilPosition`, which stops at `\`, `:`, `-` and `.` —
 * so accepting `knuth:1984` inside `\cite{knuth:19` wrote
 * `\cite{knuth:knuth:1984`. Computing the span from an explicit prefix is the
 * only way to put the backslash and the colon inside the replaced text, and it
 * is also the text Monaco fuzzy-matches against, so without it the list scores
 * against the wrong word and empties itself.
 *
 * Nothing here imports Monaco: the editor component is a thin adapter over
 * `completionsAt`, and everything below is a pure function over strings.
 */

import { COMMAND_PACKAGES, ENVIRONMENT_PACKAGES } from './latexErrors';
import { ProjectSymbol } from './latexSymbols';
import { ProjectAsset, formatBytes, isAssetName } from './projectAssets';
import { SYMBOL_GROUPS, isInsideMath } from './symbolPalette';

/* ------------------------------------------------------------------ *
 * Part 1 — snippet escaping and caret classification
 * ------------------------------------------------------------------ */

export type CompletionKind =
  | 'none'
  | 'command'
  | 'environment'
  | 'citation'
  | 'label'
  | 'package'
  | 'graphics'
  | 'input'
  | 'bibresource';

/** The Monaco `CompletionItemKind` to use, named so this module stays Monaco-free. */
export type CompletionItemKindKey =
  | 'command'
  | 'symbol'
  | 'environment'
  | 'snippet'
  | 'citation'
  | 'label'
  | 'package'
  | 'file';

export interface CaretContext {
  kind: CompletionKind;
  /** The text Monaco scores its fuzzy match against, i.e. startColumn → caret. */
  prefix: string;
  /** 1-based column where an accepted item starts overwriting. */
  startColumn: number;
  /**
   * For `\begin{…`, the 1-based column of the environment name itself. Renaming
   * an environment that already has its `\end` overwrites only the name, so the
   * braces around it survive.
   */
  nameColumn?: number;
  /** The command whose braces the caret sits in, when there is one. */
  command?: string;
  /** True inside `\end{`, where only the bare environment name is inserted. */
  closing?: boolean;
}

/**
 * Monaco's snippet parser treats a backslash as an escape before `$`, `}` and
 * another backslash, and `$` as the start of a tab stop. So a LaTeX row
 * separator written `\\` arrived in the document as a single `\` — which is why
 * every row of the table snippet used to end with one backslash instead of two.
 *
 * Applied exactly once, at module load, to every snippet body below. Bodies are
 * written as ordinary LaTeX; nothing is hand-escaped as well, or `\begin` would
 * come out as `\\begin`.
 */
export function texSnippet(body: string): string {
  return body.replace(/\$\{\d+(?::[^}]*)?\}|\$\d+|[\\$]/g, token =>
    token === '\\' ? '\\\\' : token === '$' ? '\\$' : token
  );
}

/** Commands whose braces hold something this module can complete. */
const COMMAND_CONTEXTS: Record<string, CompletionKind> = {
  cite: 'citation',
  citep: 'citation',
  citet: 'citation',
  citeauthor: 'citation',
  citeyear: 'citation',
  citealt: 'citation',
  citealp: 'citation',
  parencite: 'citation',
  textcite: 'citation',
  autocite: 'citation',
  footcite: 'citation',
  nocite: 'citation',
  fullcite: 'citation',
  ref: 'label',
  eqref: 'label',
  autoref: 'label',
  cref: 'label',
  Cref: 'label',
  cpageref: 'label',
  pageref: 'label',
  nameref: 'label',
  vref: 'label',
  begin: 'environment',
  end: 'environment',
  usepackage: 'package',
  RequirePackage: 'package',
  includegraphics: 'graphics',
  input: 'input',
  include: 'input',
  subfile: 'input',
  bibliography: 'bibresource',
  addbibresource: 'bibresource'
};

/** `\cite{a,b}` and `\usepackage{amsmath,amssymb}` complete one key at a time. */
const COMMA_LISTS: CompletionKind[] = ['citation', 'label', 'package'];

/**
 * One pass for the two things classification needs: where the comment starts,
 * and which `{` is still open. Escaped braces and `\%` are skipped by stepping
 * over the character a backslash protects.
 */
function scanLine(line: string): { comment: number; open: number } {
  const opens: number[] = [];

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '\\') {
      i += 1;
      continue;
    }
    if (char === '%') return { comment: i, open: -1 };
    if (char === '{') opens.push(i);
    else if (char === '}') opens.pop();
  }

  return { comment: -1, open: opens.length ? opens[opens.length - 1] : -1 };
}

/**
 * What the caret is in the middle of, judged from the text before it on its own
 * line. Everything is anchored at the end of `lineBefore`.
 */
export function classifyCaret(lineBefore: string): CaretContext {
  const scan = scanLine(lineBefore);
  if (scan.comment !== -1) return { kind: 'none', prefix: '', startColumn: 1 };

  if (scan.open !== -1) {
    const head = lineBefore.slice(0, scan.open);
    // Zero or more optional groups, so `\includegraphics[width=2cm][h]{` still
    // classifies; a single-group version missed those and offered nothing.
    const call = head.match(/\\([a-zA-Z@]+)\*?((?:\[[^\]]*\])*)$/);
    const kind = call ? COMMAND_CONTEXTS[call[1]] : undefined;

    if (call && kind) {
      const closing = call[1] === 'end';

      // `\begin{fig` is replaced whole, because the accepted item brings its own
      // `\begin` — and its own `\end` on a line of its own. When the `\end` is
      // already in the document, `completionsAt` overwrites `nameColumn` on and
      // leaves the rest of the line alone; see `environmentIsRename`.
      if (kind === 'environment' && !closing) {
        const start = call.index ?? 0;
        return {
          kind,
          prefix: lineBefore.slice(start),
          startColumn: start + 1,
          // `{` sits at index scan.open, and columns are 1-based.
          nameColumn: scan.open + 2,
          command: call[1]
        };
      }

      const inner = lineBefore.slice(scan.open + 1);
      const comma = COMMA_LISTS.includes(kind) ? inner.lastIndexOf(',') : -1;
      const rest = inner.slice(comma + 1);
      const lead = rest.length - rest.trimStart().length;

      return {
        kind,
        prefix: rest.slice(lead),
        // `{` sits at index scan.open, so the first key character is at
        // scan.open + 1 + (comma + 1) + lead, and columns are 1-based.
        startColumn: scan.open + comma + lead + 3,
        command: call[1],
        closing
      };
    }
  }

  // The leading [^\\] stops `\\alpha` — a line break followed by a word — from
  // being read as a command.
  const command = lineBefore.match(/(?:^|[^\\])(\\[a-zA-Z@]*)$/);
  if (command) {
    return {
      kind: 'command',
      prefix: command[1],
      startColumn: lineBefore.length - command[1].length + 1
    };
  }

  return { kind: 'none', prefix: '', startColumn: 1 };
}

const runLength = (text: string, pattern: RegExp): number => (pattern.exec(text)?.[0] ?? '').length;

/**
 * How far to the right an accepted item may overwrite, so that completing in
 * the middle of an existing word replaces it instead of doubling it.
 */
export function replaceRunLength(
  lineAfter: string,
  kind: CompletionKind,
  bareName = false
): number {
  if (kind === 'none') return 0;
  if (kind === 'command') return runLength(lineAfter, /^[a-zA-Z@]*\*?/);
  if (kind === 'environment') {
    // `\end{`, and renaming a `\begin{…}` that already has its `\end`, insert a
    // bare name and leave the closing brace where it is.
    if (bareName) return runLength(lineAfter, /^[A-Za-z0-9*@]*/);
    // A `\begin{...}` block brings its own closing brace, so the auto-closed
    // one has to go or the line ends up `\begin{itemize}}` — but only when it
    // is really there. The brace used to be optional, which meant `\begin{`
    // typed in front of existing prose swallowed the word after the caret.
    return runLength(lineAfter, /^[A-Za-z0-9*@]*\}/);
  }
  // Brace values stop at the closing brace: those items do not supply one.
  return runLength(lineAfter, /^[^,}\s]*/);
}

/**
 * The text a maths test needs, and no more.
 *
 * `isInsideMath` reads everything before the caret, and doing that from line 1
 * on every keystroke copies a whole thesis. A blank line inside `$...$` or
 * `\begin{align}` is a TeX error anyway, so the paragraph is a sound boundary.
 */
export function mathWindow(
  readLine: (lineNumber: number) => string,
  lineNumber: number,
  column: number,
  maxLines = 400
): string {
  const floor = Math.max(1, lineNumber - maxLines);
  let start = lineNumber;
  while (start > floor && readLine(start - 1).trim() !== '') start -= 1;

  const lines: string[] = [];
  for (let n = start; n < lineNumber; n += 1) lines.push(readLine(n));
  lines.push(readLine(lineNumber).slice(0, Math.max(0, column - 1)));
  return lines.join('\n');
}

/** Environments opened and not yet closed, innermost last. */
export function openEnvironments(textBefore: string): string[] {
  const stack: string[] = [];
  const pattern = /\\(begin|end)\{([^}]+)\}/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(textBefore)) !== null) {
    if (match[1] === 'begin') {
      stack.push(match[2]);
      continue;
    }
    // A mismatched \end closes the nearest one with that name, which is what a
    // half-typed document looks like most of the time.
    const at = stack.lastIndexOf(match[2]);
    if (at !== -1) stack.splice(at, 1);
    else stack.pop();
  }

  return stack;
}

/**
 * True when the `\begin{…` the caret sits in is an environment being renamed
 * rather than a new one being written — i.e. its `\end{…}` is already below.
 *
 * Selecting `itemize` in an existing `\begin{itemize}` and typing `enum` used
 * to insert the whole `\begin…\end` block over the line, leaving the original
 * `\end{itemize}` orphaned so the document no longer compiled. The line alone
 * cannot tell the two apart: `\begin{enum|}` looks identical whether the brace
 * came from auto-closing a fresh `\begin{` or was there all along.
 *
 * So count instead: every `\end` below the caret that closes nothing opened
 * below it belongs to a group opened above. One more of those than there are
 * environments still open means the surplus one is closing the half-typed
 * `\begin`. In a document with mismatched `\end`s the count can be off, and
 * then this is simply the old behaviour or an in-place rename — never an edit
 * beyond the name and its braces.
 */
export function environmentIsRename(textBefore: string, textAfter: string): boolean {
  let depth = 0;
  let closers = 0;
  const pattern = /\\(begin|end)\{[^}]*\}/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(textAfter)) !== null) {
    if (match[1] === 'begin') depth += 1;
    else if (depth === 0) closers += 1;
    else depth -= 1;
  }

  return closers > openEnvironments(textBefore).length;
}

/* ------------------------------------------------------------------ *
 * Part 2 — catalogues, built once at import
 * ------------------------------------------------------------------ */

/**
 * A suggestion with every string it will ever need already computed. The
 * provider runs on the keystroke path, so a call is a spread plus a range and
 * never any string work.
 */
interface PreparedItem {
  label: string;
  labelDetail?: string;
  labelDescription?: string;
  kindKey: CompletionItemKindKey;
  detail?: string;
  documentation?: string;
  insertText: string;
  /** Maths-only symbols need `$...$` around them when the caret is in prose. */
  proseInsertText?: string;
  isSnippet: boolean;
  filterText: string;
  sortText: string;
  /** The same item, reordered for a caret inside maths. */
  mathSortText: string;
  commitCharacters?: string[];
  /** Ask the editor to re-open the list after this item is accepted. */
  retrigger?: boolean;
}

/**
 * Ranks, most wanted first. sortText only breaks ties between items of equal
 * fuzzy score, which is exactly what it is for here.
 */
const RANK = {
  open: '0',
  project: '1',
  context: '2',
  structure: '3',
  preferred: '4',
  other: '5',
  needsPackage: '6'
} as const;

const sortKey = (rank: string, label: string): string =>
  rank + label.replace(/^\\/, '').toLowerCase();

const freeze = <T>(item: T): T => Object.freeze(item);

/**
 * A bare environment name: what `\end{` takes, and what renaming an existing
 * `\begin{…}` takes — in both places the braces are already on the line.
 */
const nameItem = (name: string, detail: string, rank: string): PreparedItem => ({
  label: name,
  kindKey: 'environment',
  detail,
  insertText: name,
  isSnippet: false,
  filterText: name,
  sortText: sortKey(rank, name),
  mathSortText: sortKey(rank, name)
});

/**
 * Turns a palette command into a snippet with one tab stop per brace group:
 * `\frac{a}{b}` becomes `\frac{${1:a}}{${2:b}}` and `\textbf{}` becomes
 * `\textbf{$1}`.
 */
function snippetFromTemplate(command: string): { body: string; hasStops: boolean } {
  let stop = 0;
  const body = command.replace(/\{([^{}]*)\}/g, (_all, inner: string) => {
    stop += 1;
    return inner ? `{\${${stop}:${inner}}}` : `{$${stop}}`;
  });
  return { body, hasStops: stop > 0 };
}

/** A literal dollar sign inside a snippet body has to be escaped. */
const SNIPPET_DOLLAR = '\\$';

function paletteCommands(): PreparedItem[] {
  const items: PreparedItem[] = [];

  for (const group of SYMBOL_GROUPS) {
    for (const symbol of group.symbols) {
      // ``'' and friends are palette buttons, not commands: they can never be
      // reached from a prefix that starts with a backslash.
      if (!/^\\(?:[a-zA-Z@]+|[^a-zA-Z\s])/.test(symbol.command)) continue;

      const { body, hasStops } = snippetFromTemplate(symbol.command);
      const escaped = hasStops ? texSnippet(body) : symbol.command;

      const insertText = hasStops ? `${escaped}$0` : escaped;
      const proseInsertText = symbol.math
        ? hasStops
          ? `${SNIPPET_DOLLAR}${escaped}${SNIPPET_DOLLAR}$0`
          : `$${symbol.command}$`
        : undefined;

      items.push(
        freeze({
          label: symbol.command,
          labelDetail: `  ${symbol.glyph}`,
          labelDescription: group.name,
          kindKey: 'symbol' as const,
          detail: symbol.glyph,
          insertText,
          proseInsertText,
          // With no tab stops there is nothing for the snippet parser to do, and
          // a plain insertion cannot be mangled by an escape it does not expect.
          isSnippet: hasStops,
          filterText: `${symbol.command} ${symbol.terms.join(' ')}`,
          sortText: sortKey(symbol.math ? RANK.other : RANK.preferred, symbol.command),
          mathSortText: sortKey(symbol.math ? RANK.preferred : RANK.other, symbol.command)
        })
      );
    }
  }

  return items;
}

/** Ready-made blocks for the things nobody remembers the syntax of. */
export interface LatexSnippet {
  label: string;
  detail: string;
  /** Monaco snippet syntax: ${1:placeholder} marks the tab stops. */
  body: string;
}

/**
 * Written as plain LaTeX joined by real newlines. `texSnippet` does the
 * escaping; hand-escaping them as well would put `\\begin` in the document.
 */
export const LATEX_SNIPPETS: LatexSnippet[] = [
  {
    label: '\\begin{figure}',
    detail: 'Figure with caption and label',
    body: [
      '\\begin{figure}[${1:htbp}]',
      '  \\centering',
      '  \\includegraphics[width=${2:0.8}\\textwidth]{${3:path/to/image}}',
      '  \\caption{${4:Caption}}',
      '  \\label{fig:${5:key}}',
      '\\end{figure}'
    ].join('\n')
  },
  {
    label: '\\begin{table}',
    detail: 'Table with booktabs rules',
    body: [
      '\\begin{table}[${1:htbp}]',
      '  \\centering',
      '  \\caption{${2:Caption}}',
      '  \\label{tab:${3:key}}',
      '  \\begin{tabular}{${4:lcc}}',
      '    \\toprule',
      '    ${5:Column} & ${6:Column} & ${7:Column} \\\\',
      '    \\midrule',
      '    ${8:value} & value & value \\\\',
      '    \\bottomrule',
      '  \\end{tabular}',
      '\\end{table}'
    ].join('\n')
  },
  {
    label: '\\begin{equation}',
    detail: 'Numbered equation with label',
    body: [
      '\\begin{equation}',
      '  ${1:x = y}',
      '  \\label{eq:${2:key}}',
      '\\end{equation}'
    ].join('\n')
  },
  {
    label: '\\begin{itemize}',
    detail: 'Bulleted list',
    body: [
      '\\begin{itemize}',
      '  \\item ${1:first}',
      '  \\item ${2:second}',
      '\\end{itemize}'
    ].join('\n')
  },
  {
    label: '\\begin{subfigure}',
    detail: 'Two figures side by side',
    body: [
      '\\begin{figure}[${1:htbp}]',
      '  \\centering',
      '  \\begin{subfigure}{0.48\\textwidth}',
      '    \\includegraphics[width=\\textwidth]{${2:left}}',
      '    \\caption{${3:Left}}',
      '  \\end{subfigure}',
      '  \\hfill',
      '  \\begin{subfigure}{0.48\\textwidth}',
      '    \\includegraphics[width=\\textwidth]{${4:right}}',
      '    \\caption{${5:Right}}',
      '  \\end{subfigure}',
      '  \\caption{${6:Overall caption}}',
      '  \\label{fig:${7:key}}',
      '\\end{figure}'
    ].join('\n')
  }
];

const BLOCK_SNIPPETS: PreparedItem[] = LATEX_SNIPPETS.map(snippet =>
  freeze({
    label: snippet.label,
    kindKey: 'snippet' as const,
    detail: snippet.detail,
    insertText: texSnippet(snippet.body),
    isSnippet: true,
    filterText: `${snippet.label} ${snippet.detail}`,
    sortText: sortKey(RANK.structure, snippet.label),
    mathSortText: sortKey(RANK.structure, snippet.label)
  })
);

interface StructureCommand {
  label: string;
  body: string;
  detail: string;
}

/**
 * The commands a document is actually built out of, with their arguments. The
 * symbol palette has no reason to carry these — it is a glyph picker — but they
 * are most of what anyone types.
 */
const STRUCTURE_COMMANDS: StructureCommand[] = [
  { label: '\\documentclass', body: '\\documentclass[${1:11pt}]{${2:article}}', detail: 'Document class' },
  { label: '\\usepackage', body: '\\usepackage{$1}', detail: 'Load a package' },
  { label: '\\title', body: '\\title{$1}', detail: 'Document title' },
  { label: '\\author', body: '\\author{$1}', detail: 'Author' },
  { label: '\\date', body: '\\date{${1:\\today}}', detail: 'Date' },
  { label: '\\maketitle', body: '\\maketitle', detail: 'Print the title block' },
  { label: '\\tableofcontents', body: '\\tableofcontents', detail: 'Table of contents' },
  { label: '\\chapter', body: '\\chapter{$1}', detail: 'Chapter heading' },
  { label: '\\section', body: '\\section{$1}', detail: 'Section heading' },
  { label: '\\subsection', body: '\\subsection{$1}', detail: 'Subsection heading' },
  { label: '\\subsubsection', body: '\\subsubsection{$1}', detail: 'Subsubsection heading' },
  { label: '\\paragraph', body: '\\paragraph{$1}', detail: 'Paragraph heading' },
  { label: '\\label', body: '\\label{$1}', detail: 'Reference target' },
  { label: '\\ref', body: '\\ref{$1}', detail: 'Reference to a label' },
  { label: '\\cite', body: '\\cite{$1}', detail: 'Citation' },
  { label: '\\caption', body: '\\caption{$1}', detail: 'Caption for a float' },
  { label: '\\includegraphics', body: '\\includegraphics[width=${1:0.8}\\textwidth]{$2}', detail: 'Insert an image' },
  { label: '\\item', body: '\\item ', detail: 'List entry' },
  { label: '\\input', body: '\\input{$1}', detail: 'Include another source file' },
  { label: '\\newcommand', body: '\\newcommand{\\$1}[${2:0}]{$3}', detail: 'Define a command' },
  { label: '\\begin', body: '\\begin{$1}', detail: 'Open an environment' },
  { label: '\\end', body: '\\end{$1}', detail: 'Close an environment' },
  { label: '\\bibliography', body: '\\bibliography{$1}', detail: 'bibtex database' },
  { label: '\\bibliographystyle', body: '\\bibliographystyle{${1:plain}}', detail: 'bibtex style' },
  { label: '\\addbibresource', body: '\\addbibresource{$1}', detail: 'biblatex database' },
  { label: '\\printbibliography', body: '\\printbibliography', detail: 'biblatex bibliography' },
  { label: '\\href', body: '\\href{$1}{$2}', detail: 'Link with text' },
  { label: '\\url', body: '\\url{$1}', detail: 'Bare link' },
  { label: '\\footnote', body: '\\footnote{$1}', detail: 'Footnote' },
  { label: '\\text', body: '\\text{$1}', detail: 'Words inside maths' },
  { label: '\\mathrm', body: '\\mathrm{$1}', detail: 'Upright maths' },
  { label: '\\left(', body: '\\left($1\\right)', detail: 'Auto-sized brackets' },
  { label: '\\hspace', body: '\\hspace{$1}', detail: 'Horizontal space' },
  { label: '\\vspace', body: '\\vspace{$1}', detail: 'Vertical space' },
  { label: '\\newpage', body: '\\newpage', detail: 'Page break' },
  { label: '\\noindent', body: '\\noindent ', detail: 'Suppress the indent' },
  { label: '\\centering', body: '\\centering', detail: 'Centre the rest of the group' },
  { label: '\\hline', body: '\\hline', detail: 'Rule across a table' },
  { label: '\\multicolumn', body: '\\multicolumn{${1:2}}{${2:c}}{$3}', detail: 'Span table columns' }
];

function structureCommands(): PreparedItem[] {
  return STRUCTURE_COMMANDS.map(entry => {
    const isSnippet = /\$\{?\d/.test(entry.body);
    // `\cite{$1}` leaves the caret in a brace this module can fill in, and the
    // editor will not open the list there by itself — the caret is inside a
    // live snippet placeholder. So the item asks for it; see `retrigger`.
    // Bodies whose first tab stop is somewhere else, like
    // `\includegraphics[width=$1]{$2}`, gain nothing and are left alone.
    const opens = /^\\([a-zA-Z@]+)\{\$\{?1/.exec(entry.body);
    return freeze({
      label: entry.label,
      kindKey: 'command' as const,
      detail: entry.detail,
      insertText: isSnippet ? texSnippet(entry.body) : entry.body,
      isSnippet,
      retrigger: Boolean(opens && COMMAND_CONTEXTS[opens[1]]),
      filterText: `${entry.label} ${entry.detail}`,
      sortText: sortKey(RANK.structure, entry.label),
      mathSortText: sortKey(RANK.structure, entry.label)
    });
  });
}

/**
 * The commands the error explainer knows a package for. They are worth offering
 * even when the package is not loaded — the documentation says which one to add.
 */
function packageCommands(taken: Set<string>): PreparedItem[] {
  const items: PreparedItem[] = [];

  for (const [command, pack] of Object.entries(COMMAND_PACKAGES)) {
    if (!pack) continue;
    const label = `\\${command}`;
    if (taken.has(label)) continue;

    items.push(
      freeze({
        label,
        labelDescription: pack,
        kindKey: 'command' as const,
        detail: pack,
        documentation: `Needs \\usepackage{${pack}}`,
        insertText: label,
        isSnippet: false,
        filterText: `${label} ${pack}`,
        sortText: sortKey(RANK.needsPackage, label),
        mathSortText: sortKey(RANK.needsPackage, label)
      })
    );
  }

  return items;
}

const COMMAND_CATALOGUE: PreparedItem[] = (() => {
  const palette = paletteCommands();
  const structure = structureCommands();
  const taken = new Set([...palette, ...structure, ...BLOCK_SNIPPETS].map(item => item.label));
  return [...structure, ...BLOCK_SNIPPETS, ...palette, ...packageCommands(taken)];
})();

/** Environments that come with LaTeX or with a package the explainer knows. */
const CORE_ENVIRONMENTS: string[] = [
  'abstract', 'align', 'align*', 'appendix', 'array', 'bmatrix', 'cases', 'center',
  'description', 'displaymath', 'document', 'enumerate', 'equation', 'equation*',
  'figure', 'figure*', 'flushleft', 'flushright', 'frame', 'gather', 'gather*',
  'itemize', 'landscape', 'longtable', 'lstlisting', 'math', 'matrix', 'minipage',
  'minted', 'multline', 'pmatrix', 'proof', 'quotation', 'quote', 'split',
  'subfigure', 'table', 'table*', 'tabular', 'tabularx', 'thebibliography',
  'theorem', 'tikzpicture', 'titlepage', 'verbatim', 'verse', 'wrapfigure'
];

/** Arguments that are not optional, so the snippet compiles as inserted. */
const ENVIRONMENT_ARGUMENTS: Record<string, string> = {
  array: '{${1:cc}}',
  figure: '[${1:htbp}]',
  'figure*': '[${1:htbp}]',
  frame: '{${1:Title}}',
  lstlisting: '[language=${1:Python}]',
  minipage: '{${1:0.48\\textwidth}}',
  subfigure: '{${1:0.48\\textwidth}}',
  table: '[${1:htbp}]',
  'table*': '[${1:htbp}]',
  tabular: '{${1:lcc}}',
  tabularx: '{${1:\\textwidth}}{${2:lXX}}',
  thebibliography: '{${1:9}}',
  wrapfigure: '{${1:r}}{${2:0.4\\textwidth}}'
};

/** A list environment that opens with no \item is a compile error. */
const ENVIRONMENT_BODIES: Record<string, string> = {
  description: '\\item[${1:term}] $0',
  enumerate: '\\item $0',
  itemize: '\\item $0'
};

interface PreparedEnvironment {
  name: string;
  /** `\begin{name} … \end{name}`, for the default ranking. */
  item: PreparedItem;
  /** The same, promoted because the project already uses this environment. */
  usedItem: PreparedItem;
  /** The bare name, for `\end{` and for renaming a `\begin{…}` in place. */
  closingItem: PreparedItem;
}

function prepareEnvironment(name: string, pack: string | undefined): PreparedEnvironment {
  const label = `\\begin{${name}}`;
  const body =
    `\\begin{${name}}${ENVIRONMENT_ARGUMENTS[name] || ''}\n` +
    `\t${ENVIRONMENT_BODIES[name] || '$0'}\n` +
    `\\end{${name}}`;

  const shared = {
    label,
    kindKey: 'environment' as const,
    detail: pack || 'environment',
    documentation: pack ? `Needs \\usepackage{${pack}}` : undefined,
    insertText: texSnippet(body),
    isSnippet: true,
    filterText: label
  };

  const rank = pack ? RANK.structure : RANK.context;

  return {
    name,
    item: freeze({ ...shared, sortText: sortKey(rank, name), mathSortText: sortKey(rank, name) }),
    usedItem: freeze({
      ...shared,
      sortText: sortKey(RANK.project, name),
      mathSortText: sortKey(RANK.project, name)
    }),
    closingItem: freeze(nameItem(name, pack || 'environment', rank))
  };
}

const ENVIRONMENT_CATALOGUE: PreparedEnvironment[] = (() => {
  const names = [...new Set([...CORE_ENVIRONMENTS, ...Object.keys(ENVIRONMENT_PACKAGES)])];
  names.sort((a, b) => a.localeCompare(b));
  return names.map(name => prepareEnvironment(name, ENVIRONMENT_PACKAGES[name] || undefined));
})();

const ENVIRONMENT_NAMES = new Set(ENVIRONMENT_CATALOGUE.map(entry => entry.name));

export interface PackageEntry {
  name: string;
  /** Commands and environments this package is the reason for. */
  provides: string[];
}

/**
 * The `\usepackage{` list, inverted out of the two tables the error explainer
 * already keeps, so the editor and the one-click installer never disagree about
 * which package provides what.
 */
export const PACKAGE_CATALOGUE: PackageEntry[] = (() => {
  const byName = new Map<string, string[]>();

  const add = (pack: string, provided: string) => {
    if (!pack) return;
    const list = byName.get(pack);
    if (list) list.push(provided);
    else byName.set(pack, [provided]);
  };

  for (const [command, pack] of Object.entries(COMMAND_PACKAGES)) add(pack, `\\${command}`);
  for (const [environment, pack] of Object.entries(ENVIRONMENT_PACKAGES)) {
    add(pack, `\\begin{${environment}}`);
  }

  return [...byName]
    .map(([name, provides]) => ({ name, provides }))
    .sort((a, b) => a.name.localeCompare(b.name));
})();

const PACKAGE_ITEMS: PreparedItem[] = PACKAGE_CATALOGUE.map(entry =>
  freeze({
    label: entry.name,
    kindKey: 'package' as const,
    detail: entry.provides.slice(0, 3).join(', ') + (entry.provides.length > 3 ? ' …' : ''),
    documentation: `Provides ${entry.provides.join(', ')}`,
    insertText: entry.name,
    isSnippet: false,
    filterText: `${entry.name} ${entry.provides.join(' ')}`,
    sortText: sortKey(RANK.context, entry.name),
    mathSortText: sortKey(RANK.context, entry.name),
    commitCharacters: [',']
  })
);

const PACKAGE_NAMES = new Set(PACKAGE_CATALOGUE.map(entry => entry.name));

/* ------------------------------------------------------------------ *
 * Part 3 — what this particular project offers
 * ------------------------------------------------------------------ */

export interface ProjectCompletionSources {
  /** Environment names the project already uses, most used first. */
  environments: string[];
  /** Source files, for `\input{` and friends. */
  inputs: string[];
  /** .bib files, for `\bibliography{` and `\addbibresource{`. */
  bibliographies: string[];
  /** Figures, for `\includegraphics{`. */
  images: ProjectAsset[];
  /** Packages the preamble already loads. */
  packagesInUse: string[];
}

/** A project with nothing in it yet, so no caller has to build one by hand. */
export const EMPTY_COMPLETION_SOURCES: ProjectCompletionSources = {
  environments: [],
  inputs: [],
  bibliographies: [],
  images: [],
  packagesInUse: []
};

/**
 * One pass over the debounced file list. Runs off the keystroke path — the
 * provider itself must never touch the project's files.
 */
export function buildProjectSources(
  files: { name: string; content: string }[],
  assets: ProjectAsset[]
): ProjectCompletionSources {
  const environmentUses = new Map<string, number>();
  const inputs: string[] = [];
  const bibliographies: string[] = [];
  const packages = new Set<string>();

  for (const file of files) {
    const lower = file.name.toLowerCase();

    if (lower.endsWith('.bib')) {
      bibliographies.push(file.name);
      continue;
    }
    if (lower.endsWith('.tex')) inputs.push(file.name);

    const begin = /\\begin\{([^}]+)\}/g;
    let match: RegExpExecArray | null;
    while ((match = begin.exec(file.content)) !== null) {
      environmentUses.set(match[1], (environmentUses.get(match[1]) || 0) + 1);
    }

    const use = /\\usepackage(?:\[[^\]]*\])?\{([^}]+)\}/g;
    while ((match = use.exec(file.content)) !== null) {
      for (const name of match[1].split(',')) {
        const trimmed = name.trim();
        if (trimmed) packages.add(trimmed);
      }
    }
  }

  return {
    // What the author already writes is the strongest signal there is.
    environments: [...environmentUses]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name]) => name),
    inputs: inputs.sort((a, b) => a.localeCompare(b)),
    bibliographies: bibliographies.sort((a, b) => a.localeCompare(b)),
    images: assets.filter(asset => isAssetName(asset.name)),
    packagesInUse: [...packages]
  };
}

/* ------------------------------------------------------------------ *
 * Part 4 — the provider entry point
 * ------------------------------------------------------------------ */

export interface CompletionRequest {
  /** The active line up to the caret. */
  lineBefore: string;
  /** The active line from the caret on. */
  lineAfter: string;
  /** Enough text above the caret to tell maths from prose; see mathWindow. */
  mathBefore: string;
  /** Everything above the caret — lazy, because only environments need it. */
  documentBefore: () => string;
  /** Everything below the caret — lazy, and only `\begin{` needs it. */
  documentAfter: () => string;
  lineNumber: number;
  column: number;
  citations: ProjectSymbol[];
  labels: ProjectSymbol[];
  sources: ProjectCompletionSources;
}

export interface LatexCompletion {
  label: string | { label: string; detail?: string; description?: string };
  kindKey: CompletionItemKindKey;
  detail?: string;
  documentation?: string;
  insertText: string;
  isSnippet: boolean;
  filterText: string;
  sortText: string;
  commitCharacters?: string[];
  preselect?: boolean;
  /**
   * The editor must re-open the list once this item has been accepted: it puts
   * the caret somewhere completable that nothing else will trigger on.
   */
  retrigger?: boolean;
  /** 1-based column where both the insert and the replace range start. */
  startColumn: number;
  /** End of the insert range: the caret. */
  insertEndColumn: number;
  /** End of the replace range: the caret plus whatever it may overwrite. */
  replaceEndColumn: number;
}

function keyItem(
  symbol: ProjectSymbol,
  kindKey: CompletionItemKindKey
): PreparedItem {
  const sort = sortKey(RANK.project, symbol.key);
  return {
    label: symbol.key,
    kindKey,
    detail: symbol.detail,
    documentation: symbol.documentation,
    insertText: symbol.key,
    isSnippet: false,
    filterText: symbol.key,
    sortText: sort,
    mathSortText: sort,
    // Finishing one key and starting the next; never '}', which would double
    // the brace auto-closing already inserted.
    commitCharacters: [',']
  };
}

function pathItem(value: string, filterText: string, detail: string): PreparedItem {
  const sort = sortKey(RANK.project, value);
  return {
    label: value,
    kindKey: 'file',
    detail,
    insertText: value,
    isSnippet: false,
    filterText,
    sortText: sort,
    mathSortText: sort
  };
}

/**
 * Everything worth offering where the caret is, already ranged.
 *
 * Returns immediately for prose, which is the hot path: quick suggestions call
 * this on every keystroke in a paragraph.
 */
export function completionsAt(request: CompletionRequest): LatexCompletion[] {
  const context = classifyCaret(request.lineBefore);
  if (context.kind === 'none') return [];

  // An existing `\begin{itemize}` is being renamed, not written: its `\end` is
  // already below, so only the name may be overwritten. Inserting the whole
  // block here orphaned that `\end` and the document stopped compiling.
  const renaming =
    context.kind === 'environment' &&
    !context.closing &&
    context.nameColumn !== undefined &&
    environmentIsRename(request.documentBefore(), request.documentAfter());

  // Both cases where the braces are already on the line and only the bare
  // environment name is inserted.
  const bareName = Boolean(context.closing) || renaming;

  const insideMath = context.kind === 'command' && isInsideMath(request.mathBefore);
  const startColumn = renaming ? (context.nameColumn as number) : context.startColumn;
  const insertEndColumn = request.column;
  const replaceEndColumn =
    request.column + replaceRunLength(request.lineAfter, context.kind, bareName);

  const place = (items: PreparedItem[], preselect?: string): LatexCompletion[] =>
    items.map(item => ({
      label:
        item.labelDetail || item.labelDescription
          ? { label: item.label, detail: item.labelDetail, description: item.labelDescription }
          : item.label,
      kindKey: item.kindKey,
      detail: item.detail,
      documentation: item.documentation,
      insertText: !insideMath && item.proseInsertText ? item.proseInsertText : item.insertText,
      isSnippet: item.isSnippet,
      filterText: item.filterText,
      sortText: insideMath ? item.mathSortText : item.sortText,
      commitCharacters: item.commitCharacters,
      preselect: preselect !== undefined && item.label === preselect ? true : undefined,
      retrigger: item.retrigger,
      startColumn,
      insertEndColumn,
      replaceEndColumn
    }));

  switch (context.kind) {
    case 'command':
      return place(COMMAND_CATALOGUE);

    case 'citation':
      return place(request.citations.map(symbol => keyItem(symbol, 'citation')));

    case 'label':
      return place(request.labels.map(symbol => keyItem(symbol, 'label')));

    case 'package': {
      const own = request.sources.packagesInUse
        .filter(name => !PACKAGE_NAMES.has(name))
        .map(name => ({
          label: name,
          kindKey: 'package' as const,
          detail: 'already in this project',
          insertText: name,
          isSnippet: false,
          filterText: name,
          sortText: sortKey(RANK.project, name),
          mathSortText: sortKey(RANK.project, name),
          commitCharacters: [',']
        }));
      return place([...own, ...PACKAGE_ITEMS]);
    }

    case 'graphics':
      return place(
        request.sources.images.map(asset =>
          pathItem(asset.name, asset.name, formatBytes(asset.bytes))
        )
      );

    case 'input':
      return place(
        // \input adds the .tex itself; writing it out is the usual way to get
        // "I can't find file `chapter.tex.tex'".
        request.sources.inputs.map(name => pathItem(name.replace(/\.tex$/i, ''), name, name))
      );

    case 'bibresource': {
      // \bibliography wants the stem, \addbibresource wants the file name.
      const keepExtension = context.command === 'addbibresource';
      return place(
        request.sources.bibliographies.map(name =>
          pathItem(keepExtension ? name : name.replace(/\.bib$/i, ''), name, 'bibliography')
        )
      );
    }

    case 'environment': {
      if (context.closing) {
        const open = openEnvironments(request.documentBefore());
        const innermost = open.length ? open[open.length - 1] : undefined;
        const seen = new Set<string>();
        const items: PreparedItem[] = [];

        for (const name of [...open].reverse()) {
          if (seen.has(name)) continue;
          seen.add(name);
          items.push(nameItem(name, 'open here', RANK.open));
        }

        for (const entry of ENVIRONMENT_CATALOGUE) {
          if (seen.has(entry.name)) continue;
          seen.add(entry.name);
          items.push(entry.closingItem);
        }

        for (const name of request.sources.environments) {
          if (seen.has(name)) continue;
          seen.add(name);
          items.push(nameItem(name, 'used in this project', RANK.project));
        }

        return place(items, innermost);
      }

      if (renaming) {
        // Names only, and no block snippets: the `\begin{`, its `}` and the
        // matching `\end{…}` below all stay exactly where they are.
        const seen = new Set<string>();
        const items: PreparedItem[] = [];

        for (const name of request.sources.environments) {
          if (seen.has(name)) continue;
          seen.add(name);
          items.push(nameItem(name, 'used in this project', RANK.project));
        }

        for (const entry of ENVIRONMENT_CATALOGUE) {
          if (seen.has(entry.name)) continue;
          seen.add(entry.name);
          items.push(entry.closingItem);
        }

        return place(items);
      }

      const used = new Set(request.sources.environments);
      const own = request.sources.environments
        .filter(name => !ENVIRONMENT_NAMES.has(name))
        .map(name => prepareEnvironment(name, undefined).usedItem);
      const catalogue = ENVIRONMENT_CATALOGUE.map(entry =>
        used.has(entry.name) ? entry.usedItem : entry.item
      );

      return place([...own, ...catalogue, ...BLOCK_SNIPPETS]);
    }

    default:
      return [];
  }
}

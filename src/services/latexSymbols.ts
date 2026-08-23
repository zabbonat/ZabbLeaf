/**
 * Pulls the things worth autocompleting out of a project: citation keys from the
 * .bib files and \label targets from the sources.
 *
 * Coming from Overleaf, typing \cite{ and getting nothing is the most obvious
 * thing missing, and both lists are cheap to extract from files already loaded.
 */

export interface ProjectSymbol {
  key: string;
  /** Shown next to the key in the suggestion list. */
  detail: string;
}

/** Reads @article{key, ... entries. Comment-only lines are skipped. */
export function collectCitations(files: { name: string; content: string }[]): ProjectSymbol[] {
  const found = new Map<string, string>();

  for (const file of files) {
    if (!file.name.toLowerCase().endsWith('.bib')) continue;

    const entry = /@(\w+)\s*\{\s*([^,\s}]+)\s*,/g;
    let match: RegExpExecArray | null;
    while ((match = entry.exec(file.content)) !== null) {
      const [, kind, key] = match;
      if (kind.toLowerCase() === 'comment' || kind.toLowerCase() === 'string') continue;

      // The title makes the list readable when keys are opaque.
      const after = file.content.slice(match.index, match.index + 800);
      const title = after.match(/title\s*=\s*[{"]+([^}"]{3,80})/i)?.[1];
      found.set(key, title ? `${kind}: ${title.replace(/\s+/g, ' ').trim()}` : kind);
    }
  }

  return [...found].map(([key, detail]) => ({ key, detail }));
}

/** Reads \label{...} from every source, so \ref{ can offer them. */
export function collectLabels(files: { name: string; content: string }[]): ProjectSymbol[] {
  const found = new Map<string, string>();

  for (const file of files) {
    if (!file.name.toLowerCase().endsWith('.tex')) continue;

    const label = /\\label\{([^}]+)\}/g;
    let match: RegExpExecArray | null;
    while ((match = label.exec(file.content)) !== null) {
      found.set(match[1], file.name);
    }
  }

  return [...found].map(([key, detail]) => ({ key, detail }));
}

/**
 * True when the caret sits inside the braces of one of the given commands, which
 * is the only place these suggestions belong.
 */
export function isInsideCommand(textBeforeCaret: string, commands: string[]): boolean {
  const open = textBeforeCaret.lastIndexOf('{');
  if (open === -1) return false;
  // A closing brace after the last opening one means we are already out.
  if (textBeforeCaret.indexOf('}', open) !== -1) return false;

  const head = textBeforeCaret.slice(0, open);
  return commands.some(command => new RegExp(`\\\\${command}\\*?(\\[[^\\]]*\\])?$`).test(head));
}

/** Ready-made blocks for the things nobody remembers the syntax of. */
export interface LatexSnippet {
  label: string;
  detail: string;
  /** Monaco snippet syntax: ${1:placeholder} marks the tab stops. */
  body: string;
}

export const LATEX_SNIPPETS: LatexSnippet[] = [
  {
    label: 'figure',
    detail: 'Figure with caption and label',
    body: [
      '\\begin{figure}[${1:htbp}]',
      '  \\centering',
      '  \\includegraphics[width=${2:0.8}\\textwidth]{${3:path/to/image}}',
      '  \\caption{${4:Caption}}',
      '  \\label{fig:${5:key}}',
      '\\end{figure}'
    ].join('\\n')
  },
  {
    label: 'table',
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
    ].join('\\n')
  },
  {
    label: 'equation',
    detail: 'Numbered equation with label',
    body: [
      '\\begin{equation}',
      '  ${1:x = y}',
      '  \\label{eq:${2:key}}',
      '\\end{equation}'
    ].join('\\n')
  },
  {
    label: 'itemize',
    detail: 'Bulleted list',
    body: [
      '\\begin{itemize}',
      '  \\item ${1:first}',
      '  \\item ${2:second}',
      '\\end{itemize}'
    ].join('\\n')
  },
  {
    label: 'subfigure',
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
    ].join('\\n')
  }
];

/**
 * Finds \cite and 
ef keys used in a document that do not exist, which
 * otherwise only show up as [?] in the compiled PDF.
 */
export interface UnknownReference {
  key: string;
  line: number;
  column: number;
  length: number;
  kind: 'citation' | 'label';
}

export function findUnknownReferences(
  content: string,
  citations: ProjectSymbol[],
  labels: ProjectSymbol[]
): UnknownReference[] {
  const knownCitations = new Set(citations.map(c => c.key));
  const knownLabels = new Set(labels.map(l => l.key));
  const problems: UnknownReference[] = [];

  const command = /\\(cite[a-zA-Z]*|ref|eqref|autoref|cref|Cref|pageref)\*?(?:\[[^\]]*\])*\{([^}]*)\}/g;

  content.split('\n').forEach((text, index) => {
    let match: RegExpExecArray | null;
    command.lastIndex = 0;

    while ((match = command.exec(text)) !== null) {
      const isCitation = match[1].startsWith('cite');
      const known = isCitation ? knownCitations : knownLabels;
      // Nothing to check against: an empty .bib should not paint the file red.
      if (known.size === 0) continue;

      const keysStart = match.index + match[0].lastIndexOf('{') + 1;
      let offset = 0;
      for (const raw of match[2].split(',')) {
        const key = raw.trim();
        if (key && !known.has(key)) {
          problems.push({
            key,
            line: index + 1,
            column: keysStart + offset + (raw.length - raw.trimStart().length) + 1,
            length: key.length,
            kind: isCitation ? 'citation' : 'label'
          });
        }
        offset += raw.length + 1;
      }
    }
  });

  return problems;
}

/**
 * Files that can be compiled on their own, i.e. the ones with a preamble.
 *
 * Assuming main.tex is wrong twice over: plenty of projects call their root
 * something else, and some hold several independent documents (a CV and a
 * cover letter, or a paper and its slides).
 */
export function findRootDocuments(files: { name: string; content: string }[]): string[] {
  return files
    .filter(file => file.name.toLowerCase().endsWith('.tex'))
    .filter(file => /\\documentclass/.test(file.content))
    .map(file => file.name)
    .sort((a, b) => {
      // main.tex first when it exists, then alphabetical.
      const rank = (name: string) => (name.toLowerCase() === 'main.tex' ? 0 : 1);
      return rank(a) - rank(b) || a.localeCompare(b);
    });
}

/** Picks a sensible document to compile when the user has not chosen one. */
export function defaultRootDocument(roots: string[], activeFile: string): string {
  if (roots.length === 0) return activeFile;
  // Editing a standalone document: compile the one in front of you.
  if (roots.includes(activeFile)) return activeFile;
  return roots[0];
}

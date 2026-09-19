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
  /**
   * Markdown for the suggestion widget's details pane. Filled here rather than
   * from a resolveCompletionItem callback because the completion provider runs
   * on the keystroke path and must not go back to the files.
   */
  documentation?: string;
}

/** Everything a .bib entry is worth showing, pulled from one window of text. */
function describeEntry(kind: string, body: string): { detail: string; documentation?: string } {
  // The leading boundary is load-bearing: without it the `title` probe matched
  // inside `booktitle`, so an @inproceedings entry that lists the venue first
  // showed "Proceedings of NeurIPS" as its title and never showed the paper's.
  // A lookbehind would be shorter, but the webviews this ships in are not all
  // new enough for one.
  const field = (names: string, limit: number) =>
    body
      .match(new RegExp(`(?:^|[^A-Za-z])(?:${names})\\s*=\\s*[{"]+([^}"]{3,${limit}})`, 'i'))?.[1]
      .replace(/\s+/g, ' ')
      .trim();

  const title = field('title', 80);
  const author = field('author', 120);
  const journal = field('journal|booktitle|publisher|school|institution', 80);
  const year = body.match(/year\s*=\s*[{"]?\s*(\d{4})/i)?.[1];

  const byline = [author, year].filter(Boolean).join(' · ');
  const lines = [title ? `**${title}**` : `**${kind}**`, byline, journal ? `*${journal}*` : ''];

  return {
    detail: title ? `${kind}: ${title}` : kind,
    documentation: lines.filter(Boolean).join('\n\n') || undefined
  };
}

/** Reads @article{key, ... entries. Comment-only lines are skipped. */
export function collectCitations(files: { name: string; content: string }[]): ProjectSymbol[] {
  const found = new Map<string, ProjectSymbol>();

  for (const file of files) {
    if (!file.name.toLowerCase().endsWith('.bib')) continue;

    const entry = /@(\w+)\s*\{\s*([^,\s}]+)\s*,/g;
    let match: RegExpExecArray | null;
    while ((match = entry.exec(file.content)) !== null) {
      const [, kind, key] = match;
      if (kind.toLowerCase() === 'comment' || kind.toLowerCase() === 'string') continue;

      // The title makes the list readable when keys are opaque.
      const after = file.content.slice(match.index, match.index + 800);
      found.set(key, { key, ...describeEntry(kind, after) });
    }
  }

  return [...found.values()];
}

/** Reads \label{...} from every source, so \ref{ can offer them. */
export function collectLabels(files: { name: string; content: string }[]): ProjectSymbol[] {
  const found = new Map<string, string>();

  for (const file of files) {
    // Everything except the bibliography: labels live in .sty, .cls and .ltx
    // fragments too, and a \ref to one of those used to be reported as unknown.
    if (file.name.toLowerCase().endsWith('.bib')) continue;

    const label = /\\label\{([^}]+)\}/g;
    let match: RegExpExecArray | null;
    while ((match = label.exec(file.content)) !== null) {
      found.set(match[1], file.name);
    }
  }

  return [...found].map(([key, detail]) => ({ key, detail }));
}

/**
 * Finds \cite and \ref keys used in a document that do not exist, which
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

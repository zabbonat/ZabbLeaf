/**
 * Word counting that means something for a LaTeX document.
 *
 * A plain split on whitespace counts `\begin{figure}[htbp]` as three words,
 * which is why nobody trusts the number their editor shows. This follows what
 * texcount does: the preamble does not count, commands do not count, but the
 * text inside \textbf, \emph or \caption does, and a piece of inline maths
 * counts as one word rather than as its symbols.
 */

export interface WordCount {
  words: number;
  characters: number;
  /** Counted, not read: each $...$ contributes a single word. */
  inlineMath: number;
  displayMath: number;
  figures: number;
  tables: number;
}

export interface SectionCount {
  title: string;
  /** 0 part, 1 chapter, 2 section, 3 subsection, 4 subsubsection. */
  level: number;
  line: number;
  words: number;
}

/** Environments whose body is not prose. */
const NON_PROSE_ENVIRONMENTS = [
  'equation', 'align', 'gather', 'multline', 'eqnarray', 'array', 'matrix', 'bmatrix',
  'pmatrix', 'tikzpicture', 'lstlisting', 'verbatim', 'minted', 'tabular', 'tabularx',
  'longtable', 'thebibliography', 'filecontents'
];

/** Everything before \begin{document} is setup, not writing. */
function body(content: string): string {
  const start = content.indexOf('\\begin{document}');
  if (start === -1) return content;
  const end = content.indexOf('\\end{document}');
  return content.slice(start + '\\begin{document}'.length, end === -1 ? undefined : end);
}

function stripComments(text: string): string {
  // An escaped \% is a percent sign in the output, not the start of a comment.
  return text.replace(/(^|[^\\])%.*$/gm, '$1');
}

function countMatches(text: string, pattern: RegExp): number {
  return (text.match(pattern) || []).length;
}

/**
 * Reduces a document to the words a reader would actually read.
 */
function toProse(text: string): string {
  let out = stripComments(text);

  for (const environment of NON_PROSE_ENVIRONMENTS) {
    // The starred variants (align*, equation*) are the ones people actually use.
    const block = new RegExp(
      `\\\\begin\\{${environment}\\*?\\}[\\s\\S]*?\\\\end\\{${environment}\\*?\\}`,
      'g'
    );
    out = out.replace(block, ' ');
  }

  // Display maths is dropped; inline maths leaves one placeholder word behind,
  // which is how texcount treats it too.
  out = out.replace(/\\\[[\s\S]*?\\\]/g, ' ');
  out = out.replace(/\$\$[\s\S]*?\$\$/g, ' ');
  out = out.replace(/\\\([\s\S]*?\\\)/g, ' math ');
  out = out.replace(/\$[^$]*\$/g, ' math ');

  // \begin{itemize} would otherwise leave the word "itemize" behind.
  out = out.replace(/\\(?:begin|end)\s*\{[^}]*\}(?:\[[^\]]*\])*(?:\{[^{}]*\})*/g, ' ');

  // Commands nobody reads, together with whatever they carry.
  out = out.replace(
    /\\(?:label|ref|eqref|autoref|cref|Cref|pageref|cite[a-zA-Z]*|includegraphics|usepackage|documentclass|bibliography|bibliographystyle|addbibresource|input|include|hspace|vspace|setlength|newcommand|renewcommand|definecolor|geometry|url|color|textcolor)\*?(?:\[[^\]]*\])*(?:\{[^{}]*\})*/g,
    ' '
  );

  // Everything else keeps its braces: the argument of \textbf, \emph, \caption
  // or \section is text a reader reads. Only the command itself goes.
  out = out.replace(/\\[a-zA-Z@]+\*?(?:\[[^\]]*\])?/g, ' ');
  out = out.replace(/\\[^a-zA-Z]/g, ' ');
  out = out.replace(/[{}]/g, ' ');

  return out;
}

export function countWords(content: string): WordCount {
  const text = body(content);
  const prose = toProse(text);

  const words = prose.split(/\s+/).filter(token => /[\p{L}\p{N}]/u.test(token)).length;
  const withoutComments = stripComments(text);

  return {
    words,
    characters: prose.replace(/\s+/g, ' ').trim().length,
    inlineMath: countMatches(withoutComments, /\$[^$]+\$/g),
    displayMath:
      countMatches(withoutComments, /\\begin\{(?:equation|align|gather|multline)\*?\}/g) +
      countMatches(withoutComments, /\\\[/g),
    figures: countMatches(withoutComments, /\\begin\{figure\*?\}/g),
    tables: countMatches(withoutComments, /\\begin\{table\*?\}/g)
  };
}

const HEADINGS: Record<string, number> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4
};

/**
 * Words per section, which is the number that matters when a journal caps the
 * introduction or a supervisor asks how long the methods are.
 */
export function countBySection(content: string): SectionCount[] {
  const text = body(content);
  const heading = /\\(part|chapter|section|subsection|subsubsection)\*?\{([^}]*)\}/g;

  const marks: { title: string; level: number; index: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = heading.exec(text)) !== null) {
    marks.push({
      title: match[2].trim() || '(untitled)',
      level: HEADINGS[match[1]],
      index: match.index
    });
  }
  if (marks.length === 0) return [];

  // Line numbers are counted in the whole file, so clicking one can jump there.
  const offset = Math.max(content.indexOf(text), 0);

  // This used to be content.slice(0, offset + index).split('\n').length, run once
  // per heading: on a 150 KB chapter with 60 headings that copied and split
  // several megabytes of string every time the section panel recomputed. The
  // marks below are in ascending index order and map visits them in order, so a
  // single newline scan that never goes backwards gives the same answer.
  let scanned = 0;
  let line = 1;
  const lineOf = (index: number) => {
    const target = offset + index;
    for (; scanned < target; scanned += 1) {
      if (content.charCodeAt(scanned) === 10) line += 1;
    }
    return line;
  };

  return marks.map((mark, position) => {
    const end = position + 1 < marks.length ? marks[position + 1].index : text.length;
    const slice = text.slice(mark.index, end);
    return {
      title: mark.title,
      level: mark.level,
      line: lineOf(mark.index),
      // Wrapped so countWords sees a body rather than looking for a preamble.
      words: countWords(`\\begin{document}${slice}\\end{document}`).words
    };
  });
}

/** Total across every .tex file, which is what the writing statistics track. */
export function countProjectWords(files: { name: string; content: string }[]): number {
  return files
    .filter(file => file.name.toLowerCase().endsWith('.tex'))
    .reduce((total, file) => total + countWords(file.content).words, 0);
}

/** 1,234 rather than 1234, which is unreadable at a glance. */
export function formatCount(value: number): string {
  return value.toLocaleString();
}

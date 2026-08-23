/**
 * Turns a TeX log into something a person can act on.
 *
 * `! Undefined control sequence.` is technically accurate and completely
 * useless: it does not say which command, why it failed, or what to do. Each
 * rule below takes one of the failures that actually happen and answers those
 * three questions — and where the answer is "a package is missing", it names
 * the package so it can be installed with one click.
 */

export interface Diagnostic {
  id: string;
  severity: 'error' | 'warning' | 'info';
  fileName?: string;
  line?: number;
  /** What the engine printed, kept so the log is never contradicted. */
  raw: string;
  title: string;
  explanation: string;
  fix: string;
  /** Set when the fix is installing a package. */
  missingPackage?: string;
}

/**
 * Commands that only exist once a package is loaded. This is the lookup that
 * turns "Undefined control sequence" into "add \usepackage{booktabs}".
 */
const COMMAND_PACKAGES: Record<string, string> = {
  toprule: 'booktabs',
  midrule: 'booktabs',
  bottomrule: 'booktabs',
  cmidrule: 'booktabs',
  includegraphics: 'graphicx',
  href: 'hyperref',
  url: 'hyperref',
  textcolor: 'xcolor',
  definecolor: 'xcolor',
  colorbox: 'xcolor',
  multirow: 'multirow',
  multicolumn: '',
  citep: 'natbib',
  citet: 'natbib',
  cref: 'cleveref',
  Cref: 'cleveref',
  todo: 'todonotes',
  missingfigure: 'todonotes',
  SI: 'siunitx',
  si: 'siunitx',
  num: 'siunitx',
  mathbb: 'amssymb',
  mathfrak: 'amssymb',
  text: 'amsmath',
  eqref: 'amsmath',
  DeclareMathOperator: 'amsmath',
  lstinputlisting: 'listings',
  lstset: 'listings',
  subcaptionbox: 'subcaption',
  subfloat: 'subfig',
  lipsum: 'lipsum',
  pagestyle: 'fancyhdr',
  fancyhead: 'fancyhdr',
  fancyfoot: 'fancyhdr',
  setlist: 'enumitem',
  tikz: 'tikz',
  usetikzlibrary: 'tikz',
  glossary: 'glossaries',
  gls: 'glossaries',
  RequirePackage: '',
  bm: 'bm',
  ul: 'soul',
  hl: 'soul'
};

/** Environments that need a package, same idea. */
const ENVIRONMENT_PACKAGES: Record<string, string> = {
  align: 'amsmath',
  'align*': 'amsmath',
  gather: 'amsmath',
  'gather*': 'amsmath',
  multline: 'amsmath',
  cases: 'amsmath',
  bmatrix: 'amsmath',
  pmatrix: 'amsmath',
  tikzpicture: 'tikz',
  lstlisting: 'listings',
  minted: 'minted',
  algorithm: 'algorithm',
  algorithmic: 'algorithmicx',
  tabularx: 'tabularx',
  longtable: 'longtable',
  subfigure: 'subcaption',
  wrapfigure: 'wrapfig',
  theorem: 'amsthm',
  proof: 'amsthm',
  landscape: 'pdflscape'
};

/** `booktabs.sty` and `booktabs` are the same thing to a package manager. */
function packageName(file: string): string {
  return file.replace(/\.(sty|cls)$/i, '');
}

interface Rule {
  pattern: RegExp;
  build: (match: RegExpMatchArray, context: string) => Omit<Diagnostic, 'id' | 'raw'>;
}

const RULES: Rule[] = [
  {
    // The single most common failure, and the one worth automating.
    pattern: /(?:LaTeX Error: )?File [`'"]([^'"`]+\.(?:sty|cls))' not found/,
    build: match => ({
      severity: 'error',
      title: `The ${packageName(match[1])} package is not installed`,
      explanation: `Your document loads ${packageName(match[1])}, but this TeX installation does not have it. Nothing is wrong with your file.`,
      fix: `Install ${packageName(match[1])} — the button does it for you — then recompile.`,
      missingPackage: packageName(match[1])
    })
  },
  {
    pattern: /auto expansion is only possible with scalable fonts/,
    build: () => ({
      severity: 'error',
      title: 'The scalable fonts are missing',
      explanation:
        'A document using \\usepackage[T1]{fontenc} needs the Type 1 versions of the Computer Modern fonts, which this installation does not have.',
      fix: 'Install the cm-super font package and recompile.',
      missingPackage: 'cm-super'
    })
  },
  {
    pattern: /Undefined control sequence/,
    build: (_match, context) => {
      // The message never names the command; the l.NN line printed under it does.
      const offender =
        context.match(/^l\.\d+\s*.*?\\([a-zA-Z@]+)\s*$/m)?.[1] ||
        context.match(/\\([a-zA-Z@]+)\s*$/m)?.[1];

      if (!offender) {
        return {
          severity: 'error' as const,
          title: 'A command on this line does not exist',
          explanation:
            'LaTeX reached a backslash command it has never been told about — a typo, or one that comes from a package the document does not load.',
          fix: 'Check the spelling on the reported line, and the \\usepackage list above it.'
        };
      }

      const pack = COMMAND_PACKAGES[offender];

      return pack
        ? {
            severity: 'error',
            title: `\\${offender} needs the ${pack} package`,
            explanation: `\\${offender} is not a built-in command: it comes from ${pack}, which this document never loads.`,
            fix: `Add \\usepackage{${pack}} to the preamble. If it is not installed either, install it first.`,
            missingPackage: pack
          }
        : {
            severity: 'error',
            title: `\\${offender} is not a command LaTeX knows`,
            explanation:
              'Either it is a typo, or it comes from a package the document does not load.',
            fix: `Check the spelling of \\${offender}, or add the \\usepackage that defines it.`
          };
    }
  },
  {
    pattern: /LaTeX Error: Environment ([a-zA-Z*]+) undefined/,
    build: match => {
      const pack = ENVIRONMENT_PACKAGES[match[1]];
      return pack
        ? {
            severity: 'error',
            title: `The ${match[1]} environment needs the ${pack} package`,
            explanation: `\\begin{${match[1]}} is defined by ${pack}, which this document does not load.`,
            fix: `Add \\usepackage{${pack}} to the preamble.`,
            missingPackage: pack
          }
        : {
            severity: 'error',
            title: `LaTeX does not know the ${match[1]} environment`,
            explanation:
              'Either the name is misspelled, or the package that defines it is not loaded.',
            fix: `Check the spelling of \\begin{${match[1]}}, or load the package that provides it.`
          };
    }
  },
  {
    pattern: /Missing \$ inserted/,
    build: () => ({
      severity: 'error',
      title: 'Maths outside maths mode',
      explanation:
        'Something that only exists in maths — usually _, ^, \\alpha or \\frac — was used in ordinary text.',
      fix: 'Wrap it in $...$, or use \\_ and \\^{} when you meant the characters themselves.'
    })
  },
  {
    pattern: /LaTeX Error: \\begin\{([^}]+)\} on input line (\d+) ended by \\end\{([^}]+)\}/,
    build: match => ({
      severity: 'error',
      title: `\\begin{${match[1]}} is closed by \\end{${match[3]}}`,
      explanation: `The environment opened on line ${match[2]} is closed with the wrong name, so LaTeX never finds its end.`,
      fix: `Change \\end{${match[3]}} to \\end{${match[1]}}, or fix whichever of the two is the typo.`,
      line: Number(match[2])
    })
  },
  {
    pattern: /Runaway argument|Paragraph ended before .* was complete/,
    build: () => ({
      severity: 'error',
      title: 'A command was left open',
      explanation:
        'A closing brace is missing, or a blank line landed inside a command that does not allow one — a \\caption or \\footnote split over two paragraphs, for example.',
      fix: 'Find the brace that was never closed just above the reported line, and remove any blank line inside the command.'
    })
  },
  {
    pattern: /Missing \} inserted|Missing \{ inserted/,
    build: () => ({
      severity: 'error',
      title: 'The braces do not balance',
      explanation: 'Somewhere above the reported line, a { was opened and never closed.',
      fix: 'Count the braces on that line and the ones just before it.'
    })
  },
  {
    pattern: /Too many \}'s|Extra \}, or forgotten \$/,
    build: () => ({
      severity: 'error',
      title: 'One brace too many',
      explanation: 'A } appears where nothing was open — often after deleting half of a command.',
      fix: 'Remove the extra }, or restore the { that used to match it.'
    })
  },
  {
    pattern: /LaTeX Error: Missing \\begin\{document\}/,
    build: () => ({
      severity: 'error',
      title: 'Text appears before \\begin{document}',
      explanation:
        'Only \\usepackage and settings belong in the preamble. Anything printable there is read as text with no document to put it in.',
      fix: 'Move that text below \\begin{document}, or comment it out with %.'
    })
  },
  {
    pattern: /LaTeX Error: Can be used only in preamble/,
    build: () => ({
      severity: 'error',
      title: 'That command belongs in the preamble',
      explanation:
        '\\usepackage and \\documentclass have to come before \\begin{document}; by then the document has already started.',
      fix: 'Move the line above \\begin{document}.'
    })
  },
  {
    pattern: /Unknown graphics extension: (\.[a-zA-Z0-9]+)/,
    build: match => ({
      severity: 'error',
      title: `${match[1]} images are not supported by this engine`,
      explanation:
        'pdflatex reads PDF, PNG and JPG. EPS needs either the epstopdf package or a run through xelatex or lualatex.',
      fix: `Convert the figure to PDF or PNG, or add \\usepackage{epstopdf} for ${match[1]} files.`
    })
  },
  {
    pattern: /LaTeX Error: File [`'"]([^'"`]+)' not found/,
    build: match => ({
      severity: 'error',
      title: `${match[1]} is not where the document expects it`,
      explanation:
        'The path is resolved from the project folder, so figures/plot.png means a figures folder next to your main file.',
      fix: `Check that ${match[1]} exists in the project and that the path matches, capital letters included.`
    })
  },
  {
    pattern: /LaTeX Error: Something's wrong--perhaps a missing \\item/,
    build: () => ({
      severity: 'error',
      title: 'A list without items',
      explanation:
        'An itemize, enumerate or description environment contains text that is not preceded by \\item.',
      fix: 'Put \\item in front of the first entry, or remove the empty list.'
    })
  },
  {
    pattern: /I can't find file [`'"]([^'"`]+)'/,
    build: match => ({
      severity: 'error',
      title: `${match[1]} is missing`,
      explanation: 'An \\input or \\include points at a file that is not in the project.',
      fix: `Create ${match[1]}, or correct the path in the \\input line.`
    })
  },
  {
    pattern: /TeX capacity exceeded, sorry \[([a-z ]+)=/,
    build: match => ({
      severity: 'error',
      title: 'The engine ran out of room',
      explanation: `TeX exhausted its ${match[1]}, which in practice always means a command that calls itself, or an environment that never ends.`,
      fix: 'Look for a \\newcommand defined in terms of itself, or a \\begin without its \\end.'
    })
  },
  {
    pattern: /Package ([a-zA-Z0-9@_-]+) Error: (.+)/,
    build: match => ({
      severity: 'error',
      title: `${match[1]} refused to continue`,
      explanation: match[2].trim(),
      fix: `This comes from the ${match[1]} package rather than from LaTeX itself — its options or its arguments are wrong.`
    })
  },
  {
    pattern: /LaTeX Warning: Citation [`'"]([^'"`]+)' .* undefined/,
    build: match => ({
      severity: 'warning',
      title: `The citation ${match[1]} prints as [?]`,
      explanation: `No entry with the key ${match[1]} was found in the .bib files, so nothing goes in the bibliography.`,
      fix: `Add ${match[1]} to your .bib file, or correct the key in the \\cite.`
    })
  },
  {
    pattern: /LaTeX Warning: Reference [`'"]([^'"`]+)' .* undefined/,
    build: match => ({
      severity: 'warning',
      title: `The reference ${match[1]} prints as ??`,
      explanation: `No \\label{${match[1]}} exists anywhere in the project.`,
      fix: `Add \\label{${match[1]}} where it belongs — inside the figure, table or section it names.`
    })
  },
  {
    pattern: /LaTeX Warning: Label [`'"]([^'"`]+)' multiply defined/,
    build: match => ({
      severity: 'warning',
      title: `${match[1]} is used by two labels`,
      explanation: 'References to it point at whichever came last, which is rarely the intended one.',
      fix: `Rename one of the two \\label{${match[1]}}.`
    })
  },
  {
    pattern: /I couldn't open database file ([^\s]+)/,
    build: match => ({
      severity: 'error',
      title: `bibtex cannot open ${match[1]}`,
      explanation:
        'The \\bibliography line names a file that is not in the project, or names it with the wrong spelling.',
      fix: `Write \\bibliography{${match[1].replace(/\.bib$/i, '')}} without the .bib extension, and check the file is there.`
    })
  }
];

/** Errors printed as `main.tex:37: message` by -file-line-error. */
const FILE_LINE = /^(?:\.\/)?([^\s:]+\.(?:tex|sty|cls|bib)):(\d+):\s*(.*)$/;

/**
 * Reads a log and returns what is worth showing, most serious first.
 *
 * Only the first occurrence of each distinct problem is kept: a missing package
 * reports itself on every pass, and three copies of the same advice help nobody.
 */
export function explainLog(log: string): Diagnostic[] {
  if (!log.trim()) return [];

  const lines = log.split('\n');
  const found: Diagnostic[] = [];
  const seen = new Set<string>();

  lines.forEach((line, index) => {
    const fileLine = line.match(FILE_LINE);
    const message = fileLine ? fileLine[3] : line;
    const isCandidate = fileLine || line.startsWith('!') || /Warning|Error|couldn't/.test(line);
    if (!isCandidate) return;

    // The engine puts the offending source on the lines that follow. It is only
    // ever read by a rule that needs it: matching rules against it would let a
    // later error swallow the line being looked at, which is how the citation
    // and reference warnings used to disappear behind an unrelated one.
    const context = lines.slice(index, index + 6).join('\n');

    for (const rule of RULES) {
      const match = message.match(rule.pattern);
      if (!match) continue;

      const built = rule.build(match, context);
      const key = `${built.title}::${built.explanation}`;
      if (seen.has(key)) return;
      seen.add(key);

      // `l.37 \toprule` is where the engine says it stopped.
      const reported =
        built.line ||
        (fileLine ? Number(fileLine[2]) : undefined) ||
        Number(context.match(/^l\.(\d+)/m)?.[1]) ||
        undefined;

      found.push({
        id: `${key}:${index}`,
        raw: line.trim(),
        fileName: fileLine ? fileLine[1] : undefined,
        ...built,
        line: Number.isFinite(reported) ? reported : undefined
      });
      return;
    }
  });

  // Lines running past the margin are worth one line, never thirty.
  const overfull = (log.match(/Overfull \\hbox/g) || []).length;
  if (overfull > 0) {
    found.push({
      id: 'overfull',
      severity: 'info',
      raw: `Overfull \\hbox ×${overfull}`,
      title: `${overfull} line${overfull === 1 ? '' : 's'} run past the margin`,
      explanation:
        'Usually a long URL, a wide table or a word LaTeX cannot hyphenate. The PDF is fine; the text just sticks out.',
      fix: 'Wrap URLs in \\url{}, use tabularx for wide tables, or leave it — this rarely matters in a draft.'
    });
  }

  const order = { error: 0, warning: 1, info: 2 };
  return found.sort((a, b) => order[a.severity] - order[b.severity]).slice(0, 12);
}

/** True when the compile failed on something a package install would fix. */
export function firstInstallablePackage(diagnostics: Diagnostic[]): string | null {
  return diagnostics.find(d => d.missingPackage)?.missingPackage || null;
}

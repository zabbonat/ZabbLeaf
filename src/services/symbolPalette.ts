/**
 * A searchable list of the symbols people go looking for on the web.
 *
 * Nobody remembers that "≈" is \approx or that "⊂" is \subset, so the loop is
 * always the same: leave the editor, search, copy, come back. Each entry
 * carries the words someone would actually type — in English and in Italian,
 * because guessing which one comes to mind first is a lost cause.
 */

export interface LatexSymbol {
  command: string;
  /** What it looks like, for the button face. */
  glyph: string;
  /** Words that should find it. */
  terms: string[];
  /** Needs to be inside $...$ to compile. */
  math: boolean;
}

export interface SymbolGroup {
  name: string;
  symbols: LatexSymbol[];
}

const m = (command: string, glyph: string, terms: string[]): LatexSymbol => ({
  command,
  glyph,
  terms,
  math: true
});

const t = (command: string, glyph: string, terms: string[]): LatexSymbol => ({
  command,
  glyph,
  terms,
  math: false
});

export const SYMBOL_GROUPS: SymbolGroup[] = [
  {
    name: 'Greek',
    symbols: [
      m('\\alpha', 'α', ['alpha', 'greek', 'greco']),
      m('\\beta', 'β', ['beta', 'greek', 'greco']),
      m('\\gamma', 'γ', ['gamma', 'greek', 'greco']),
      m('\\Gamma', 'Γ', ['gamma', 'capital', 'maiuscola']),
      m('\\delta', 'δ', ['delta', 'greek', 'greco']),
      m('\\Delta', 'Δ', ['delta', 'difference', 'differenza', 'variazione']),
      m('\\epsilon', 'ϵ', ['epsilon', 'error', 'errore']),
      m('\\varepsilon', 'ε', ['epsilon', 'error', 'errore']),
      m('\\zeta', 'ζ', ['zeta']),
      m('\\eta', 'η', ['eta']),
      m('\\theta', 'θ', ['theta', 'angle', 'angolo']),
      m('\\Theta', 'Θ', ['theta', 'capital', 'maiuscola']),
      m('\\iota', 'ι', ['iota']),
      m('\\kappa', 'κ', ['kappa']),
      m('\\lambda', 'λ', ['lambda']),
      m('\\Lambda', 'Λ', ['lambda', 'capital', 'maiuscola']),
      m('\\mu', 'μ', ['mu', 'mean', 'media', 'micro']),
      m('\\nu', 'ν', ['nu']),
      m('\\xi', 'ξ', ['xi']),
      m('\\pi', 'π', ['pi', 'pigreco']),
      m('\\Pi', 'Π', ['pi', 'product', 'prodotto', 'produttoria']),
      m('\\rho', 'ρ', ['rho', 'correlation', 'correlazione']),
      m('\\sigma', 'σ', ['sigma', 'deviation', 'deviazione', 'standard']),
      m('\\Sigma', 'Σ', ['sigma', 'sum', 'somma', 'sommatoria']),
      m('\\tau', 'τ', ['tau']),
      m('\\phi', 'ϕ', ['phi']),
      m('\\varphi', 'φ', ['phi']),
      m('\\Phi', 'Φ', ['phi', 'capital', 'normale', 'cdf']),
      m('\\chi', 'χ', ['chi', 'chi-squared', 'chiquadro']),
      m('\\psi', 'ψ', ['psi']),
      m('\\Psi', 'Ψ', ['psi', 'capital', 'maiuscola']),
      m('\\omega', 'ω', ['omega']),
      m('\\Omega', 'Ω', ['omega', 'ohm', 'capital', 'maiuscola'])
    ]
  },
  {
    name: 'Operators',
    symbols: [
      m('\\times', '×', ['times', 'multiply', 'per', 'moltiplicazione', 'prodotto']),
      m('\\div', '÷', ['divide', 'division', 'diviso', 'divisione']),
      m('\\pm', '±', ['plus minus', 'piu meno', 'più meno', 'tolerance', 'errore']),
      m('\\mp', '∓', ['minus plus', 'meno piu']),
      m('\\cdot', '⋅', ['dot', 'punto', 'product', 'prodotto', 'scalare']),
      m('\\cdots', '⋯', ['dots', 'puntini', 'ellipsis']),
      m('\\ldots', '…', ['dots', 'puntini', 'ellipsis', 'sospensione']),
      m('\\sum', '∑', ['sum', 'somma', 'sommatoria', 'sigma']),
      m('\\prod', '∏', ['product', 'prodotto', 'produttoria']),
      m('\\int', '∫', ['integral', 'integrale']),
      m('\\iint', '∬', ['double integral', 'integrale doppio']),
      m('\\oint', '∮', ['contour integral', 'integrale di linea', 'circuitazione']),
      m('\\sqrt{x}', '√', ['root', 'radice', 'square root', 'radice quadrata']),
      m('\\frac{a}{b}', 'a/b', ['fraction', 'frazione', 'divide', 'rapporto']),
      m('\\partial', '∂', ['partial', 'parziale', 'derivative', 'derivata']),
      m('\\nabla', '∇', ['nabla', 'gradient', 'gradiente', 'del']),
      m('\\infty', '∞', ['infinity', 'infinito']),
      m('\\lim_{x \\to 0}', 'lim', ['limit', 'limite']),
      m('\\hat{x}', 'x̂', ['hat', 'cappello', 'estimate', 'stima', 'stimatore']),
      m('\\bar{x}', 'x̄', ['bar', 'barra', 'mean', 'media']),
      m('\\tilde{x}', 'x̃', ['tilde', 'tilde']),
      m('\\vec{x}', 'x⃗', ['vector', 'vettore']),
      m('\\dot{x}', 'ẋ', ['dot', 'derivative', 'derivata', 'punto'])
    ]
  },
  {
    name: 'Relations',
    symbols: [
      m('\\leq', '≤', ['less equal', 'minore uguale', 'minoreuguale']),
      m('\\geq', '≥', ['greater equal', 'maggiore uguale', 'maggioreuguale']),
      m('\\neq', '≠', ['not equal', 'diverso', 'differente']),
      m('\\approx', '≈', ['approximately', 'circa', 'approssimato', 'quasi uguale']),
      m('\\sim', '∼', ['similar', 'simile', 'distributed', 'distribuito']),
      m('\\simeq', '≃', ['similar equal', 'circa uguale']),
      m('\\equiv', '≡', ['equivalent', 'equivalente', 'identico']),
      m('\\propto', '∝', ['proportional', 'proporzionale']),
      m('\\ll', '≪', ['much less', 'molto minore']),
      m('\\gg', '≫', ['much greater', 'molto maggiore']),
      m('\\ne', '≠', ['not equal', 'diverso'])
    ]
  },
  {
    name: 'Arrows',
    symbols: [
      m('\\to', '→', ['arrow', 'freccia', 'to', 'tends', 'tende']),
      m('\\rightarrow', '→', ['right arrow', 'freccia destra']),
      m('\\leftarrow', '←', ['left arrow', 'freccia sinistra']),
      m('\\leftrightarrow', '↔', ['double arrow', 'freccia doppia']),
      m('\\Rightarrow', '⇒', ['implies', 'implica', 'freccia doppia', 'quindi']),
      m('\\Leftarrow', '⇐', ['implied by', 'implicato']),
      m('\\Leftrightarrow', '⇔', ['iff', 'se e solo se', 'equivalente']),
      m('\\uparrow', '↑', ['up arrow', 'freccia su', 'aumento']),
      m('\\downarrow', '↓', ['down arrow', 'freccia giu', 'diminuzione']),
      m('\\mapsto', '↦', ['maps to', 'mappa', 'funzione'])
    ]
  },
  {
    name: 'Sets and logic',
    symbols: [
      m('\\in', '∈', ['element', 'appartiene', 'in', 'belongs']),
      m('\\notin', '∉', ['not element', 'non appartiene']),
      m('\\subset', '⊂', ['subset', 'sottoinsieme', 'contenuto']),
      m('\\subseteq', '⊆', ['subset equal', 'sottoinsieme', 'contenuto o uguale']),
      m('\\supset', '⊃', ['superset', 'sovrainsieme', 'contiene']),
      m('\\cup', '∪', ['union', 'unione']),
      m('\\cap', '∩', ['intersection', 'intersezione']),
      m('\\emptyset', '∅', ['empty set', 'insieme vuoto', 'vuoto']),
      m('\\forall', '∀', ['for all', 'per ogni', 'quantificatore']),
      m('\\exists', '∃', ['exists', 'esiste', 'quantificatore']),
      m('\\neg', '¬', ['not', 'negazione', 'non']),
      m('\\land', '∧', ['and', 'congiunzione', 'e logico']),
      m('\\lor', '∨', ['or', 'disgiunzione', 'o logico']),
      m('\\mathbb{R}', 'ℝ', ['real', 'reali', 'blackboard']),
      m('\\mathbb{N}', 'ℕ', ['natural', 'naturali', 'blackboard']),
      m('\\mathbb{Z}', 'ℤ', ['integer', 'interi', 'blackboard']),
      m('\\mathbb{E}', '𝔼', ['expectation', 'valore atteso', 'media', 'attesa']),
      m('\\mathbb{P}', 'ℙ', ['probability', 'probabilita', 'probabilità'])
    ]
  },
  {
    name: 'Text',
    symbols: [
      t('\\textbf{}', 'B', ['bold', 'grassetto', 'bold text']),
      t('\\textit{}', 'I', ['italic', 'corsivo']),
      t('\\underline{}', 'U', ['underline', 'sottolineato']),
      t('\\texttt{}', 'tt', ['monospace', 'codice', 'typewriter']),
      t('\\emph{}', 'em', ['emphasis', 'enfasi', 'corsivo']),
      t('\\footnote{}', 'fn', ['footnote', 'nota a pie di pagina', 'nota']),
      t('\\%', '%', ['percent', 'percentuale', 'per cento']),
      t('\\&', '&', ['ampersand', 'e commerciale']),
      t('\\$', '$', ['dollar', 'dollaro']),
      t('\\_', '_', ['underscore', 'trattino basso']),
      t('\\#', '#', ['hash', 'cancelletto']),
      t('\\textbackslash', '\\', ['backslash', 'barra rovesciata']),
      t('\\euro', '€', ['euro', 'currency', 'valuta']),
      t('\\textdegree', '°', ['degree', 'gradi', 'grado']),
      t('\\dag', '†', ['dagger', 'croce', 'nota']),
      t('\\copyright', '©', ['copyright', 'diritti']),
      t('\\ldots', '…', ['dots', 'puntini', 'sospensione']),
      t('``\'\'', '“”', ['quotes', 'virgolette', 'citazione']),
      t('\\ ', '␣', ['space', 'spazio', 'spazio forzato']),
      t('\\\\', '↵', ['newline', 'a capo', 'nuova riga', 'break'])
    ]
  }
];

/**
 * Matches on the command as well as the terms, so someone who half-remembers
 * "appro" finds \approx just as someone typing "circa" does.
 */
export function searchSymbols(query: string): SymbolGroup[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return SYMBOL_GROUPS;

  return SYMBOL_GROUPS.map(group => ({
    name: group.name,
    symbols: group.symbols.filter(
      symbol =>
        symbol.command.toLowerCase().includes(needle) ||
        symbol.glyph === needle ||
        symbol.terms.some(term => term.includes(needle))
    )
  })).filter(group => group.symbols.length > 0);
}

/**
 * True when the caret sits inside maths, judged by the dollar signs before it.
 *
 * It is a heuristic, but the alternative is inserting \alpha into plain text
 * and letting the user find out from a compile error.
 */
export function isInsideMath(textBeforeCaret: string): boolean {
  // \[ ... \] used to read as text mode, so a symbol accepted inside a display
  // block was wrapped in $...$ and the document stopped compiling.
  const delimiter =
    /\\(begin|end)\{(equation|align|gather|multline|math|displaymath)\*?\}|\\([[\]()])/g;
  let open = false;
  let match: RegExpExecArray | null;
  while ((match = delimiter.exec(textBeforeCaret)) !== null) {
    if (match[1]) {
      open = match[1] === 'begin';
      continue;
    }
    // `\\[2ex]` is a line break with extra leading, not the start of display
    // maths, and it is common inside align and tabular.
    if (textBeforeCaret[match.index - 1] === '\\') continue;
    open = match[3] === '[' || match[3] === '(';
  }
  if (open) return true;

  // \$ is a printed dollar sign, not a delimiter.
  const dollars = (textBeforeCaret.match(/(^|[^\\])\$/g) || []).length;
  return dollars % 2 === 1;
}

/** What to actually type in, given where the caret is. */
export function insertionFor(symbol: LatexSymbol, insideMath: boolean): string {
  if (!symbol.math || insideMath) return symbol.command;
  return `$${symbol.command}$`;
}

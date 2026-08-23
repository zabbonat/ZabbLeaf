/**
 * Starting points for a new project.
 *
 * Overleaf's value is partly its template gallery: a blank main.tex is where
 * people stall. These use nothing but the classes and packages every TeX
 * installation ships with, so a new project compiles on the first try — a
 * template that fails with a missing class would be worse than no template.
 *
 * String.raw keeps the LaTeX readable: no doubled backslashes.
 */

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  /** Shown on the card. */
  emoji: string;
  files: { name: string; content: string }[];
}

const REFERENCES = String.raw`@article{shannon1948,
  author  = {Shannon, Claude E.},
  title   = {A Mathematical Theory of Communication},
  journal = {Bell System Technical Journal},
  volume  = {27},
  number  = {3},
  pages   = {379--423},
  year    = {1948}
}

@book{knuth1984,
  author    = {Knuth, Donald E.},
  title     = {The TeXbook},
  publisher = {Addison-Wesley},
  year      = {1984}
}
`;

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    id: 'blank',
    name: 'Blank document',
    description: 'A minimal article. Nothing to delete before you start.',
    emoji: '📄',
    files: [
      {
        name: 'main.tex',
        content: String.raw`\documentclass[11pt,a4paper]{article}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage{graphicx}
\usepackage{amsmath}

\title{Untitled}
\author{}
\date{\today}

\begin{document}

\maketitle

Write here.

\end{document}
`
      }
    ]
  },
  {
    id: 'article',
    name: 'Academic paper',
    description: 'Abstract, sections, figure, table and a bibliography that works.',
    emoji: '🔬',
    files: [
      {
        name: 'main.tex',
        content: String.raw`\documentclass[11pt,a4paper]{article}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage[margin=2.5cm]{geometry}
\usepackage{graphicx}
\usepackage{amsmath}
\usepackage{hyperref}

\title{A Title That Says What the Paper Found}
\author{Your Name\\ Your Department, Your University}
\date{\today}

\begin{document}

\maketitle

\begin{abstract}
One paragraph: what question the paper asks, how it answers it, and what the
answer turned out to be. Written last, read first.
\end{abstract}

\section{Introduction}
\label{sec:introduction}

What the problem is and why it matters, ending with what this paper adds.
Cite as you go \cite{shannon1948}.

\section{Method}
\label{sec:method}

Enough detail that someone else could repeat it. Equations are numbered when
they are referred to later:

\begin{equation}
  H(X) = -\sum_{i} p_i \log p_i
  \label{eq:entropy}
\end{equation}

Equation~\eqref{eq:entropy} is referred to by its label, never by its number:
the number changes, the label does not.

\section{Results}
\label{sec:results}

% A figure goes here once you have one. Drop the image into the editor and
% ZabbLeaf writes this block for you.

\begin{table}[htbp]
  \centering
  \caption{What the reader should take from the table.}
  \label{tab:results}
  \begin{tabular}{lrr}
    \hline
    Condition & Mean & SD \\
    \hline
    Baseline  & 0.00 & 0.00 \\
    Treatment & 0.00 & 0.00 \\
    \hline
  \end{tabular}
\end{table}

\section{Discussion}
\label{sec:discussion}

What the results mean, what they do not mean, and what is left to do.

\section{Conclusion}
\label{sec:conclusion}

Two or three sentences. No new material.

\bibliographystyle{plain}
\bibliography{references}

\end{document}
`
      },
      { name: 'references.bib', content: REFERENCES }
    ]
  },
  {
    id: 'thesis',
    name: 'Thesis or report',
    description: 'Title page, table of contents, chapters in separate files.',
    emoji: '🎓',
    files: [
      {
        name: 'main.tex',
        content: String.raw`\documentclass[12pt,a4paper,oneside]{report}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage[margin=3cm]{geometry}
\usepackage{graphicx}
\usepackage{amsmath}
\usepackage{hyperref}
\usepackage{setspace}

\onehalfspacing

\begin{document}

% ---------------------------------------------------------------- title page
\begin{titlepage}
  \centering
  \vspace*{3cm}

  {\Huge\bfseries The Title of the Thesis\par}
  \vspace{1.5cm}
  {\Large Your Name\par}
  \vspace{0.5cm}
  {\large Supervisor: Their Name\par}

  \vfill

  {\large Department\\ University\\ \today\par}
\end{titlepage}

\pagenumbering{roman}

\chapter*{Abstract}
\addcontentsline{toc}{chapter}{Abstract}

What the thesis asks, does, and finds, in one page.

\tableofcontents
\listoffigures
\listoftables

\cleardoublepage
\pagenumbering{arabic}

% Chapters live in their own files: one long main.tex is where projects go to die.
\input{chapters/introduction}
\input{chapters/method}
\input{chapters/conclusion}

\bibliographystyle{plain}
\bibliography{references}
\addcontentsline{toc}{chapter}{Bibliography}

\end{document}
`
      },
      {
        name: 'chapters/introduction.tex',
        content: String.raw`\chapter{Introduction}
\label{ch:introduction}

The question, why it is worth asking, and how the rest of the thesis is
organised.

\section{Motivation}
\label{sec:motivation}

% TODO: write this once the results are in — it is easier backwards.
`
      },
      {
        name: 'chapters/method.tex',
        content: String.raw`\chapter{Method}
\label{ch:method}

What was done, in enough detail to be repeated.
`
      },
      {
        name: 'chapters/conclusion.tex',
        content: String.raw`\chapter{Conclusion}
\label{ch:conclusion}

What was found, what it means, and what remains open.
`
      },
      { name: 'references.bib', content: REFERENCES }
    ]
  },
  {
    id: 'beamer',
    name: 'Presentation',
    description: 'Beamer slides: title, sections, two columns, a summary.',
    emoji: '📊',
    files: [
      {
        name: 'main.tex',
        content: String.raw`\documentclass[aspectratio=169]{beamer}
\usetheme{default}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage{graphicx}

\title{The Talk}
\subtitle{What it is about}
\author{Your Name}
\institute{Your University}
\date{\today}

\begin{document}

\begin{frame}
  \titlepage
\end{frame}

\begin{frame}{Outline}
  \tableofcontents
\end{frame}

\section{The problem}

\begin{frame}{The problem}
  \begin{itemize}
    \item One idea per bullet
    \item Four bullets per slide, at most
    \item The slide is not the handout
  \end{itemize}
\end{frame}

\section{The approach}

\begin{frame}{Two things side by side}
  \begin{columns}
    \begin{column}{0.48\textwidth}
      What was expected.
    \end{column}
    \begin{column}{0.48\textwidth}
      What actually happened.
    \end{column}
  \end{columns}
\end{frame}

\section{Results}

\begin{frame}{What to remember}
  \begin{block}{One sentence}
    If the audience keeps a single thing, this is it.
  \end{block}
\end{frame}

\begin{frame}{Thank you}
  \centering
  Questions?
\end{frame}

\end{document}
`
      }
    ]
  },
  {
    id: 'letter',
    name: 'Letter',
    description: 'A formal letter: sender, recipient, date, signature.',
    emoji: '✉️',
    files: [
      {
        name: 'main.tex',
        content: String.raw`\documentclass[11pt,a4paper]{letter}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage[margin=2.5cm]{geometry}

\signature{Your Name}
\address{Your Name \\ Street 1 \\ 00100 City \\ your.email@example.com}

\begin{document}

\begin{letter}{Recipient Name \\ Their Organisation \\ Street 2 \\ 00200 City}

\opening{Dear Dr.\ Recipient,}

The first paragraph says why you are writing, in one sentence.

The middle paragraphs give what the reader needs in order to say yes.

The last one says exactly what happens next, and by when.

\closing{Yours sincerely,}

\end{letter}

\end{document}
`
      }
    ]
  },
  {
    id: 'cv',
    name: 'CV',
    description: 'A clean one-column CV. No exotic class to install.',
    emoji: '📇',
    files: [
      {
        name: 'main.tex',
        content: String.raw`\documentclass[11pt,a4paper]{article}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage[margin=2.2cm]{geometry}
\usepackage{titlesec}
\usepackage{enumitem}
\usepackage{hyperref}

\pagestyle{empty}

% One rule under every heading, and no numbering: a CV is not a paper.
\titleformat{\section}{\large\bfseries}{}{0pt}{}[\titlerule]
\titlespacing{\section}{0pt}{14pt}{6pt}

\newcommand{\entry}[4]{%
  \noindent\textbf{#1} \hfill #2 \\
  \textit{#3} \\
  #4 \vspace{6pt}
}

\begin{document}

\begin{center}
  {\LARGE\bfseries Your Name} \\[4pt]
  City, Country \textbullet\ your.email@example.com \textbullet\ +39 000 000 0000
\end{center}

\section{Education}

\entry{PhD in Something}{2022--2026}{University Name}{
  Thesis: title of the thesis. Supervisor: their name.
}

\entry{MSc in Something}{2020--2022}{University Name}{
  Final mark: 110/110 cum laude.
}

\section{Experience}

\entry{Job Title}{2024--present}{Organisation}{
  \begin{itemize}[leftmargin=*,noitemsep,topsep=2pt]
    \item What you did, starting with a verb and ending with a result.
    \item A second thing, with a number in it wherever possible.
  \end{itemize}
}

\section{Publications}

\begin{enumerate}[leftmargin=*,noitemsep]
  \item Your Name, Co-author. Title of the paper. \textit{Journal}, 2026.
\end{enumerate}

\section{Skills}

\noindent
Languages: Italian (native), English (C1). \\
Technical: Python, R, LaTeX.

\end{document}
`
      }
    ]
  },
  {
    id: 'homework',
    name: 'Problem set',
    description: 'Numbered exercises with solutions, ready for maths.',
    emoji: '✏️',
    files: [
      {
        name: 'main.tex',
        content: String.raw`\documentclass[11pt,a4paper]{article}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage[margin=2.5cm]{geometry}
\usepackage{amsmath}
\usepackage{amssymb}
\usepackage{amsthm}
\usepackage{graphicx}
\usepackage{fancyhdr}

\pagestyle{fancy}
\fancyhf{}
\lhead{Course Name}
\rhead{Your Name}
\cfoot{\thepage}

\newtheorem{exercise}{Exercise}

\title{Problem Set 1}
\author{Your Name}
\date{\today}

\begin{document}

\maketitle

\begin{exercise}
  State the question here.
\end{exercise}

\begin{proof}[Solution]
  The reasoning, one step per line:
  \begin{align}
    f(x) &= x^2 + 2x + 1 \\
         &= (x+1)^2.
  \end{align}
\end{proof}

\begin{exercise}
  The second question.
\end{exercise}

\begin{proof}[Solution]
  % TODO: finish this one before Friday.
\end{proof}

\end{document}
`
      }
    ]
  }
];

export function templateById(id: string): ProjectTemplate {
  return PROJECT_TEMPLATES.find(template => template.id === id) || PROJECT_TEMPLATES[0];
}

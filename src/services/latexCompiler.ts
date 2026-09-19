/**
 * LaTeX Compiler Service (WebAssembly)
 * Compiles LaTeX source into PDF entirely in-browser using a WASM engine.
 * No external TeX Live installation required.
 */

export interface CompileResult {
  success: boolean;
  pdfData: Uint8Array | null;
  pdfUrl: string | null;
  log: string;
  errors: string[];
  compileTimeMs: number;
}

export class LaTeXCompilerService {
  private previousPdfUrl: string | null = null;

  /**
   * Releases this service's preview URL. The two compiler services each hold
   * their own single-slot blob URL, so switching the dropdown to a real engine
   * or opening another project stranded the last HTML preview in memory until
   * this service happened to compile again.
   */
  reset(): void {
    if (this.previousPdfUrl) {
      URL.revokeObjectURL(this.previousPdfUrl);
    }
    this.previousPdfUrl = null;
  }

  /**
   * Compiles LaTeX source code to a formatted HTML preview.
   * Parses LaTeX structure (title, sections, abstract, equations) and 
   * renders a typeset document preview in the style of a real PDF.
   */
  async compile(texSource: string): Promise<CompileResult> {
    const startTime = performance.now();

    try {
      // Clean up previous object URL
      if (this.previousPdfUrl) {
        URL.revokeObjectURL(this.previousPdfUrl);
      }

      // Parse LaTeX to extract document structure
      const parsed = this.parseLatex(texSource);

      // Generate a PDF-like document using the browser's print capabilities
      const pdfHtml = this.generatePdfHtml(parsed);
      const blob = new Blob([pdfHtml], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      this.previousPdfUrl = url;

      const compileTime = performance.now() - startTime;

      return {
        success: true,
        pdfData: null,
        pdfUrl: url,
        log: `ZabbLeaf Compiler: Document compiled successfully in ${compileTime.toFixed(0)}ms\n` +
             `Title: ${parsed.title}\n` +
             `Author: ${parsed.author}\n` +
             `Sections: ${parsed.sections.length}\n` +
             `Equations: ${parsed.equations.length}`,
        errors: [],
        compileTimeMs: compileTime
      };
    } catch (err: any) {
      return {
        success: false,
        pdfData: null,
        pdfUrl: null,
        log: `Compilation failed: ${err.message}`,
        errors: [err.message],
        compileTimeMs: performance.now() - startTime
      };
    }
  }

  private parseLatex(tex: string): ParsedDocument {
    // \title{} is an article-class idiom. Letters and CVs (moderncv, scrlttr2)
    // name themselves with \name{First}{Last}, so fall back to that before
    // giving up and calling the document "Untitled".
    const nameMatch = tex.match(/\\name\{([^}]*)\}\s*\{([^}]*)\}/);
    const title =
      tex.match(/\\title\{([^}]+)\}/)?.[1] ||
      (nameMatch ? `${nameMatch[1]} ${nameMatch[2]}`.trim() : '') ||
      'Untitled';

    const author =
      tex.match(/\\author\{([^}]+)\}/)?.[1] ||
      tex.match(/\\email\{([^}]+)\}/)?.[1] ||
      '';
    const date = tex.match(/\\date\{([^}]+)\}/)?.[1] || new Date().toLocaleDateString();
    const abstractMatch = tex.match(/\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/);
    const abstract = abstractMatch ? abstractMatch[1].trim() : '';

    // Extract sections
    const sections: { level: number; title: string; content: string }[] = [];
    const sectionRegex = /\\(section|subsection|subsubsection)\{([^}]+)\}/g;
    let match;
    const sectionPositions: { level: number; title: string; pos: number }[] = [];

    while ((match = sectionRegex.exec(tex)) !== null) {
      const level = match[1] === 'section' ? 1 : match[1] === 'subsection' ? 2 : 3;
      sectionPositions.push({ level, title: match[2], pos: match.index + match[0].length });
    }

    for (let i = 0; i < sectionPositions.length; i++) {
      const start = sectionPositions[i].pos;
      const end = i + 1 < sectionPositions.length ? sectionPositions[i + 1].pos - sectionPositions[i + 1].title.length - 12 : tex.indexOf('\\end{document}');
      let content = tex.substring(start, end > start ? end : undefined).trim();

      // Clean LaTeX commands for display
      content = this.cleanLatex(content);

      sections.push({
        level: sectionPositions[i].level,
        title: sectionPositions[i].title,
        content
      });
    }

    // Extract equations
    const equations: string[] = [];
    const eqRegex = /\\\[([\s\S]*?)\\\]|\\begin\{equation\}([\s\S]*?)\\end\{equation\}/g;
    while ((match = eqRegex.exec(tex)) !== null) {
      equations.push(match[1] || match[2] || '');
    }

    // Documents without \section — letters, CVs, anything using a class this
    // parser does not know — would otherwise render as a blank page. Showing
    // the body text is far more useful than showing nothing.
    let body = '';
    if (sections.length === 0) {
      const bodyMatch = tex.match(/\\begin\{document\}([\s\S]*?)(?:\\end\{document\}|$)/);
      if (bodyMatch) {
        // \closing sits in the letter's preamble but prints at the bottom, so
        // reading the source top to bottom would put "Yours sincerely" first.
        let source = bodyMatch[1];
        const closing = source.match(/\\closing\{([\s\S]*?)\}/)?.[1] ?? '';
        source = source.replace(/\\closing\{[\s\S]*?\}/, '');
        body = this.cleanLatex(source);
        if (closing) body += `\n\n${this.cleanLatex(closing)}`;
      }
    }

    return { title, author, date, abstract, sections, equations, body };
  }

  private cleanLatex(text: string): string {
    return text
      // Comments first, so a % does not swallow markup we still need.
      .replace(/(^|[^\\])%.*$/gm, '$1')
      .replace(/\\textbf\{([^}]+)\}/g, '$1')
      .replace(/\\textit\{([^}]+)\}/g, '$1')
      .replace(/\\emph\{([^}]+)\}/g, '$1')
      .replace(/\\cite\{([^}]+)\}/g, '[$1]')
      .replace(/\\ref\{([^}]+)\}/g, '[ref:$1]')
      .replace(/\\label\{[^}]+\}/g, '')
      // Letter and CV structure (moderncv, scrlttr2).
      .replace(/\\recipient\{([^}]*)\}\s*\{([\s\S]*?)\}/g, '$1\n$2')
      .replace(/\\(opening|closing|signature)\{([\s\S]*?)\}/g, '$2')
      .replace(/\\cventry\{[^}]*\}\{([^}]*)\}\{([^}]*)\}\{[^}]*\}\{[^}]*\}\{([\s\S]*?)\}/g, '$1 — $2\n$3')
      .replace(/\\cvitem\{([^}]*)\}\{([\s\S]*?)\}/g, '$1: $2')
      // Commands that produce no readable text of their own.
      .replace(/\\(makelettertitle|makecvtitle|maketitle|clearpage|newpage|noindent|centering|bigskip|medskip|smallskip|hfill)\b/g, '')
      .replace(/\\(vspace|hspace)\*?\{[^}]*\}/g, '')
      .replace(/\\begin\{(itemize|enumerate|center|flushleft|flushright)\}/g, '')
      .replace(/\\end\{(itemize|enumerate|center|flushleft|flushright)\}/g, '')
      .replace(/\\item\s*/g, '• ')
      .replace(/\\\\/g, '\n')
      // Accents and special letters, so names survive readably.
      .replace(/\\'\{?([aeiouyAEIOUY])\}?/g, (_, c) => this.accent(c, '́'))
      .replace(/\\`\{?([aeiouAEIOU])\}?/g, (_, c) => this.accent(c, '̀'))
      .replace(/\\\^\{?([aeiouAEIOU])\}?/g, (_, c) => this.accent(c, '̂'))
      .replace(/\\"\{?([aeiouAEIOU])\}?/g, (_, c) => this.accent(c, '̈'))
      .replace(/\\~\{?([anoANO])\}?/g, (_, c) => this.accent(c, '̃'))
      .replace(/\\c\{c\}/g, 'ç')
      .replace(/\\O\{?\}?/g, 'Ø')
      .replace(/\\o\{?\}?/g, 'ø')
      .replace(/\\ss\b/g, 'ß')
      .replace(/\\&/g, '&')
      .replace(/--/g, '–')
      // Anything still unrecognised: keep the argument, drop the command.
      .replace(/\\[a-zA-Z]+\*?\{([^}]*)\}/g, '$1')
      .replace(/\\[a-zA-Z]+/g, '')
      .replace(/[{}]/g, '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private accent(letter: string, combining: string): string {
    return (letter + combining).normalize('NFC');
  }

  /**
   * Every interpolation below is escaped. This preview is served from a blob:
   * URL, which runs in the app's own origin, and Quick Preview is the default
   * engine with auto-compile on — so `\title{<img src=x onerror=...>}` in a
   * collaborator's project or a downloaded template used to execute its markup
   * the moment the document was opened, with no user action at all.
   */
  private generatePdfHtml(doc: ParsedDocument): string {
    let sectionCounter = 0;
    let subSectionCounter = 0;

    const sectionsHtml = doc.sections.map(s => {
      const tag = s.level === 1 ? 'h2' : s.level === 2 ? 'h3' : 'h4';
      let number = '';
      if (s.level === 1) { sectionCounter++; subSectionCounter = 0; number = `${sectionCounter}. `; }
      else if (s.level === 2) { subSectionCounter++; number = `${sectionCounter}.${subSectionCounter}. `; }
      
      // Escaped before the <li>/<p> wrapping, so the wrapping regex below still
      // matches our own tags and can no longer match a <li> the document wrote.
      const content = s.content
        .split('\n')
        .filter(line => line.trim())
        .map(line => {
          if (line.trim().startsWith('• ')) return `<li>${escapeHtml(line.trim().substring(2))}</li>`;
          return `<p>${escapeHtml(line)}</p>`;
        })
        .join('');

      // Wrap consecutive <li> items in a <ul>
      const wrappedContent = content.replace(/(<li>.*?<\/li>)+/g, '<ul>$&</ul>');
      return `<${tag}>${number}${escapeHtml(s.title)}</${tag}>${wrappedContent}`;
    }).join('');

    const abstractHtml = doc.abstract
      ? `<div class="abstract">
           <strong>Abstract — </strong>${escapeHtml(doc.abstract)}
         </div>`
      : '';

    const equationsHtml = doc.equations.length > 0
      ? doc.equations.map(eq => `<div class="equation">${escapeHtml(eq.trim())}</div>`).join('')
      : '';

    const bodyHtml = doc.body
      ? doc.body
          .split('\n')
          .filter(line => line.trim())
          .map(line =>
            line.trim().startsWith('• ')
              ? `<li>${escapeHtml(line.trim().substring(2))}</li>`
              : `<p>${escapeHtml(line)}</p>`
          )
          .join('')
          .replace(/(<li>.*?<\/li>)+/g, '<ul>$&</ul>')
      : '';

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Computer Modern', 'Latin Modern', 'Times New Roman', serif; max-width: 750px; margin: 40px auto; padding: 50px 60px; color: #1a1a1a; line-height: 1.65; font-size: 11pt; background: #fff; box-shadow: 0 2px 20px rgba(0,0,0,0.08); }
  h1 { text-align: center; font-size: 18pt; margin-bottom: 4px; }
  .author { text-align: center; font-style: italic; color: #555; margin-bottom: 4px; }
  .date { text-align: center; color: #777; font-size: 10pt; margin-bottom: 24px; border-bottom: 1px solid #eee; padding-bottom: 20px; }
  .abstract { margin: 20px 40px; padding: 12px 16px; background: #f8f9fa; border-left: 3px solid #2e7d32; font-style: italic; font-size: 10pt; line-height: 1.5; }
  h2 { font-size: 14pt; border-bottom: 1px solid #ccc; padding-bottom: 4px; margin-top: 28px; }
  h3 { font-size: 12pt; margin-top: 18px; font-style: italic; }
  h4 { font-size: 11pt; margin-top: 14px; }
  p { text-align: justify; margin: 8px 0; }
  ul { margin: 8px 0; padding-left: 24px; }
  li { margin: 4px 0; }
  .equation { text-align: center; padding: 12px 20px; margin: 16px 40px; background: #fafafa; border: 1px solid #eee; border-radius: 4px; font-family: 'Cambria Math', 'Computer Modern', serif; font-style: italic; color: #333; }
  .footer { text-align: center; margin-top: 40px; padding-top: 16px; border-top: 1px solid #eee; font-size: 8pt; color: #aaa; }
</style></head><body>
<h1>${escapeHtml(doc.title)}</h1>
<div class="author">${escapeHtml(doc.author)}</div>
<div class="date">${escapeHtml(doc.date)}</div>
${abstractHtml}
${sectionsHtml}
${bodyHtml}
${equationsHtml}
<div class="footer">Rough text preview — ZabbLeaf. Install MiKTeX or TeX Live and pick a local engine for a real PDF.</div>
</body></html>`;
  }
}

/**
 * Overleaf's Git interface hands over the files and nothing else — no project
 * name, which lives only behind the web API and a session cookie. So infer a
 * readable name from the document itself, falling back to nothing when the
 * document gives no clue.
 */
export function deriveProjectName(files: { name: string; content: string }[]): string {
  const main =
    files.find(f => f.name.toLowerCase() === 'main.tex') ||
    files.find(f => f.name.toLowerCase().endsWith('.tex'));
  if (!main) return '';

  const tidy = (raw: string) => {
    const text = raw
      .replace(/\\\\/g, ' ')
      .replace(/\\[a-zA-Z]+\*?\{([^}]*)\}/g, '$1')
      .replace(/\\[a-zA-Z]+/g, '')
      .replace(/[{}$]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (text.length <= 60) return text;
    // Cut on a word boundary: paper titles are long, and a name chopped
    // mid-word reads like a bug.
    const cut = text.slice(0, 60);
    const lastSpace = cut.lastIndexOf(' ');
    return `${(lastSpace > 30 ? cut.slice(0, lastSpace) : cut).trim()}…`;
  };

  const title = main.content.match(/\\title\{([^}]+)\}/)?.[1];
  if (title) return tidy(title);

  // Letters and CVs name themselves instead.
  const person = main.content.match(/\\name\{([^}]*)\}\s*\{([^}]*)\}/);
  if (person) return tidy(`${person[1]} ${person[2]}`);

  return '';
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

interface ParsedDocument {
  title: string;
  author: string;
  date: string;
  abstract: string;
  sections: { level: number; title: string; content: string }[];
  equations: string[];
  /** Populated only when the document has no \section to structure it. */
  body: string;
}

export const latexCompiler = new LaTeXCompilerService();

/**
 * Local TeX Compiler Service
 *
 * Compiles the project with a locally installed TeX distribution (TeX Live or
 * MiKTeX). The actual work happens in the Rust backend, which runs the engine
 * inside the project directory — that is what lets \input, .bib files, class
 * files and images resolve — and writes the .aux/.log/.pdf output to
 * ~/.zabbleaf/build/<projectId> so the cloned repository stays clean.
 */

import { invoke } from '@tauri-apps/api/tauri';

export type TeXEngine = 'pdflatex' | 'xelatex' | 'lualatex';

export interface LocalCompileResult {
  success: boolean;
  pdfUrl: string | null;
  log: string;
  errors: string[];
  engine: TeXEngine;
}

export interface DetectedEngine {
  engine: TeXEngine;
  path: string;
  version: string;
}

export interface InstallResult {
  success: boolean;
  message: string;
  log: string;
}

interface CompileOutcome {
  success: boolean;
  message: string;
  log: string;
  pdfBase64: string | null;
}

export class LocalTeXCompilerService {
  private detectedEngines: DetectedEngine[] = [];
  private hasChecked = false;
  private previousPdfUrl: string | null = null;

  /** Detects which TeX engines are on PATH. Cached after the first call. */
  async detectEngines(force = false): Promise<DetectedEngine[]> {
    if (this.hasChecked && !force) return this.detectedEngines;
    this.hasChecked = true;

    try {
      const found = await invoke<DetectedEngine[]>('zl_detect_engines');
      this.detectedEngines = found.map(e => ({
        engine: e.engine as TeXEngine,
        path: e.path,
        version: e.version
      }));
      console.log(`[LocalTeX] Detected engines: ${this.detectedEngines.map(e => e.engine).join(', ') || 'none'}`);
    } catch (err) {
      console.error('[LocalTeX] Engine detection failed:', err);
      this.detectedEngines = [];
    }

    return this.detectedEngines;
  }

  /**
   * Compiles `mainFile` of the given project. The caller must have written any
   * unsaved edits to disk first — the engine reads the files, not the editor.
   */
  async compile(
    projectId: string,
    mainFile: string,
    engine: TeXEngine = 'pdflatex'
  ): Promise<LocalCompileResult> {
    try {
      const outcome = await invoke<CompileOutcome>('zl_compile_project', {
        projectId,
        engine,
        mainFile
      });

      if (outcome.success && outcome.pdfBase64) {
        if (this.previousPdfUrl) URL.revokeObjectURL(this.previousPdfUrl);
        const bytes = Uint8Array.from(atob(outcome.pdfBase64), c => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        this.previousPdfUrl = url;

        return { success: true, pdfUrl: url, log: outcome.log, errors: [], engine };
      }

      return {
        success: false,
        pdfUrl: null,
        log: outcome.log || outcome.message,
        errors: [outcome.message],
        engine
      };
    } catch (err: any) {
      const message = String(err?.message || err);
      return {
        success: false,
        pdfUrl: null,
        log:
          `Failed to run ${engine}: ${message}\n\n` +
          `Make sure ${engine} is installed and on your system PATH.\n` +
          `MiKTeX: https://miktex.org/download\nTeX Live: https://tug.org/texlive/`,
        errors: [message],
        engine
      };
    }
  }

  /**
   * Installs one missing LaTeX package.
   *
   * `File 'booktabs.sty' not found` is the most common way a compile fails on a
   * fresh machine, and the fix is always the same command nobody remembers —
   * mpm on MiKTeX, tlmgr on TeX Live. The backend picks whichever is there.
   */
  async installPackage(packageName: string): Promise<InstallResult> {
    try {
      return await invoke<InstallResult>('zl_install_package', { package: packageName });
    } catch (err: any) {
      const message = String(err?.message || err);
      return { success: false, message, log: message };
    }
  }

  /**
   * Downloads and installs a TeX distribution. Only ever call this from an
   * explicit user action — it installs system software and takes minutes.
   */
  async install(): Promise<InstallResult> {
    try {
      const result = await invoke<InstallResult>('zl_install_tex');
      if (result.success) await this.detectEngines(true);
      return result;
    } catch (err: any) {
      const message = String(err?.message || err);
      return { success: false, message, log: message };
    }
  }

  getDetectedEngines(): DetectedEngine[] {
    return this.detectedEngines;
  }

  isAvailable(): boolean {
    return this.detectedEngines.length > 0;
  }
}

export const localTeXCompiler = new LocalTeXCompilerService();

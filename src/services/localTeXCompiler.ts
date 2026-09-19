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
  /**
   * The same PDF as raw bytes. pdf.js renders from these, which makes a
   * recompile a state update; pointing an iframe at a fresh blob URL is a
   * navigation that throws away the reader's scroll position every 2 seconds.
   */
  pdfData: Uint8Array | null;
  /**
   * True when the engine was killed because the user pressed Stop or a newer
   * compile took over. The caller must leave the previous PDF and log alone:
   * reporting a deliberate Stop as a failure wipes a good PDF off the screen.
   */
  cancelled: boolean;
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
  cancelled: boolean;
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

      // A stopped compile is not a failed one. The backend reports it as an
      // ordinary result precisely so the caller can leave the last good PDF,
      // log and diagnostics on screen instead of replacing them with an error.
      if (outcome.cancelled) {
        return {
          success: false,
          pdfUrl: null,
          pdfData: null,
          cancelled: true,
          log: outcome.log,
          errors: [],
          engine
        };
      }

      if (outcome.success && outcome.pdfBase64) {
        // Uint8Array.from(str, fn) walks the string through its iterator and
        // allocates a one-character string per byte: 323 ms for a 5 MB PDF
        // against 7 ms here, landing the instant the window unfreezes.
        const binary = atob(outcome.pdfBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);

        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        // Revoked only once the replacement exists: revoking first leaves one
        // render whose iframe src names a blob that has already been released.
        const stale = this.previousPdfUrl;
        this.previousPdfUrl = url;
        if (stale) URL.revokeObjectURL(stale);

        return {
          success: true,
          pdfUrl: url,
          pdfData: bytes,
          cancelled: false,
          log: outcome.log,
          errors: [],
          engine
        };
      }

      return {
        success: false,
        pdfUrl: null,
        pdfData: null,
        cancelled: false,
        log: outcome.log || outcome.message,
        errors: [outcome.message],
        engine
      };
    } catch (err: any) {
      const message = String(err?.message || err);
      return {
        success: false,
        pdfUrl: null,
        pdfData: null,
        cancelled: false,
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
   * Kills the engine currently running for this project.
   *
   * Resolves false when nothing was running — Stop on an idle project must not
   * look like it did something. The in-flight `compile()` promise resolves on
   * its own with `cancelled: true`; do not clear the compiling state here, or a
   * new compile can start before the engine has actually died.
   *
   * `userInitiated` distinguishes the Stop button from housekeeping. A real
   * Stop that finds nothing running is remembered for a few seconds, because
   * "nothing running" also covers a compile that has not finished registering.
   * Leaving a project must NOT do that: switching away and straight back would
   * then have the arming swallow the returning project's first compile, which
   * shows neither a PDF nor an error.
   */
  async cancel(projectId: string, userInitiated = true): Promise<boolean> {
    try {
      return await invoke<boolean>('zl_cancel_compile', { projectId, userInitiated });
    } catch (err) {
      console.error('[LocalTeX] Could not stop the compile:', err);
      return false;
    }
  }

  /**
   * Releases the blob URL held for the Download button.
   *
   * Each compiler service keeps its own single-slot URL, so switching projects
   * or engines would otherwise strand the last one until that same service
   * compiles again. Idempotent.
   */
  reset(): void {
    if (this.previousPdfUrl) URL.revokeObjectURL(this.previousPdfUrl);
    this.previousPdfUrl = null;
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

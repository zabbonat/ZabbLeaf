import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url';

/**
 * pdf.js plumbing: worker start-up and document loading.
 *
 * Kept out of the React component so the one genuinely tricky decision — how the
 * worker is started under `tauri://localhost` — lives in one place with the
 * reason attached, and so `outputScaleFor` stays a pure function.
 */

/**
 * pdf.js decides whether it is allowed to call `new Worker(workerSrc)` itself by
 * comparing origins, and the URL `.origin` getter serializes the non-special
 * `tauri:` scheme to the string "null". So pdf.js concludes its own worker is
 * cross-origin and wraps it in a blob that calls `importScripts()` — on a scheme
 * wry 0.24 registers as secure but not CORS-enabled, which fails. Constructing
 * the Worker ourselves and handing pdf.js the port skips that check entirely.
 */
let mode: 'port' | 'script' = 'port';
let port: Worker | null = null;

/**
 * pdf.js performs no handshake when it is given a port: `getDocument` simply
 * never resolves if the worker script failed to load, so an empty pane would sit
 * there forever with nothing in the console. Give up after this long and reload
 * through the path that cannot fail silently.
 */
const WORKER_HANDSHAKE_MS = 8000;
const TIMED_OUT = Symbol('pdf-worker-timeout');

/** A canvas larger than this is refused outright by some platforms. */
export const MAX_CANVAS_PIXELS = 16_777_216;
/** Per-side cap; WebKit and Chromium both stop honouring dimensions past this. */
export const MAX_CANVAS_SIDE = 8192;
/**
 * Never rasterize below half a device pixel per CSS pixel. A very large page at
 * 400% can push the computed scale under 1, and letting it fall freely turns the
 * page into an unreadable postage stamp — a soft page is the better failure.
 */
export const MIN_OUTPUT_SCALE = 0.5;

// Set even while the port is in use: pdf.js ignores workerSrc as long as a port
// is configured, but if we ever null the port it must already have somewhere to
// fall back to, and an unset workerSrc makes pdf.js throw instead.
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

function degradeToScriptWorker(): void {
  mode = 'script';
  try {
    port?.terminate();
  } catch {
    /* already gone */
  }
  port = null;
  // With no port, pdf.js loads the same file with a <script> tag and parses on
  // the main thread when a real Worker will not start. Slower, but it always
  // produces pages.
  pdfjsLib.GlobalWorkerOptions.workerPort = null;
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
}

function ensureWorkerPort(): boolean {
  if (mode === 'script') return false;
  if (port) return true;
  try {
    const worker = new Worker(pdfWorkerUrl);
    // A Worker whose script fails to load reports it here and nowhere else —
    // the constructor itself succeeds.
    worker.addEventListener('error', () => degradeToScriptWorker());
    port = worker;
    pdfjsLib.GlobalWorkerOptions.workerPort = worker;
    return true;
  } catch {
    degradeToScriptWorker();
    return false;
  }
}

/**
 * The worker port above is module-global, and `destroy()` flags it as being torn
 * down until the Terminate round-trip comes back; a `getDocument` started inside
 * that window throws "the worker is being destroyed. Please remember to await
 * PDFDocumentLoadingTask.destroy()-calls." Collapsing and re-expanding the
 * preview pane destroys one component's document and immediately loads the next
 * one's, so the two calls come from different React instances and no
 * per-component guard can order them — everything that touches the worker queues
 * here instead.
 */
let workerQueue: Promise<unknown> = Promise.resolve();

/**
 * How long the queue waits for a job before letting the next one past.
 *
 * A job that rejects is handled below, but one that never settles at all is not:
 * a terminated worker answers neither a Terminate nor a GetDocument, and because
 * this queue is module-global that single dead job would wedge every later load
 * in the app rather than the one component that hit it.
 */
const WORKER_JOB_TIMEOUT_MS = 10_000;

function queued<T>(job: () => Promise<T>): Promise<T> {
  // `then(job, job)` rather than `then(job)`: one failed load must not stall
  // every later one behind a rejected chain.
  const run = workerQueue.then(job, job);
  // The caller still awaits the real job; only the queue gives up early, so a
  // wedged worker costs one stuck caller instead of a dead PDF pane forever.
  workerQueue = new Promise<void>(resolve => {
    const timer = window.setTimeout(resolve, WORKER_JOB_TIMEOUT_MS);
    const release = () => {
      window.clearTimeout(timer);
      resolve();
    };
    run.then(release, release);
  });
  return run;
}

/**
 * Parse a PDF held in memory.
 *
 * The caller keeps its bytes in React state for the next zoom and the next
 * recompile, so the array handed to pdf.js is always a copy: `getDocument`
 * transfers `data.buffer` to the worker, which detaches the original and makes
 * every later load fail with an empty pane.
 */
export function loadPdfDocument(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  return queued(() => openDocument(bytes));
}

/**
 * Release a document and its worker-side parse.
 *
 * Callers must use this rather than `doc.destroy()`: it is the half of the queue
 * that makes the next `loadPdfDocument` wait for the Terminate round-trip.
 */
export function destroyPdfDocument(doc: PDFDocumentProxy | null | undefined): Promise<void> {
  if (!doc) return Promise.resolve();
  return queued(async () => {
    try {
      await doc.destroy();
    } catch {
      /* a document whose worker already went away is already destroyed */
    }
  });
}

async function openDocument(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  const start = () => pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false });

  if (!ensureWorkerPort()) return start().promise;

  const task = start();
  let timer = 0;
  const watchdog = new Promise<never>((_resolve, reject) => {
    timer = window.setTimeout(() => reject(TIMED_OUT), WORKER_HANDSHAKE_MS);
  });

  try {
    return await Promise.race([task.promise, watchdog]);
  } catch (error) {
    if (error !== TIMED_OUT) throw error;
    await task.destroy().catch(() => undefined);
    degradeToScriptWorker();
    return start().promise;
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * How many device pixels per CSS pixel a page of this size may be rasterized at.
 *
 * Returns `dpr` — which is what makes the page sharp — unless that would blow
 * past the canvas caps, in which case it drops as far as `MIN_OUTPUT_SCALE` so
 * the allocation stays bounded and the page only goes soft.
 */
export function outputScaleFor(
  widthPx: number,
  heightPx: number,
  dpr: number,
  maxPixels: number = MAX_CANVAS_PIXELS,
  maxSide: number = MAX_CANVAS_SIDE
): number {
  const width = Math.max(1, widthPx);
  const height = Math.max(1, heightPx);
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;

  const capped = Math.min(
    ratio,
    Math.sqrt(maxPixels / (width * height)),
    maxSide / width,
    maxSide / height
  );

  return Math.max(MIN_OUTPUT_SCALE, capped);
}

/**
 * Cancelling a render is the normal outcome of zooming or recompiling while a
 * page is still painting, so it must not be reported as a failure. pdf.js does
 * not export a usable class for `instanceof`, hence the name check.
 */
export function isRenderingCancelled(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === 'RenderingCancelledException';
}

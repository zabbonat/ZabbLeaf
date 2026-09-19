import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import {
  destroyPdfDocument,
  isRenderingCancelled,
  loadPdfDocument,
  outputScaleFor
} from '../../services/pdfEngine';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';

/**
 * A continuous, canvas-backed PDF viewer.
 *
 * The iframe it replaces could never be sharp: WebKit's embedded viewer lays the
 * document out to the frame's CSS width and pins itself to "page width", so a
 * CSS transform on the frame only resamples a bitmap that was already rasterized
 * at the wrong size — zooming in rasterized into *fewer* pixels and stretched
 * them. Owning the canvas is what lets the backing store track
 * devicePixelRatio and makes a zoom re-rasterize instead of upscale.
 */

interface PageGeometry {
  index: number;
  /** Width of the page at scale 1, in CSS pixels. */
  widthPt: number;
  /** Height of the page at scale 1, in CSS pixels. */
  heightPt: number;
}

export interface PdfCanvasViewProps {
  /**
   * The PDF as raw bytes. A new array means a new document; the same array
   * across renders is left alone, which is what keeps a recompile from being
   * treated as a navigation.
   */
  data: Uint8Array | null;
  /** 1 means fit-width. 0.5 is 50%, 4 is 400%. */
  zoom: number;
  /** Called with the page count each time a document finishes loading. */
  onPageCount?: (pages: number) => void;
}

/** Matches the padding in `.pdf-canvas-pages`, so fit-width really fits. */
const PAGE_GUTTER = 16;
/** Below this the page is a smudge; stop shrinking rather than vanish. */
const MIN_BASE_SCALE = 0.1;
/** Rasterize a screen's worth of pages either side of the viewport. */
const PRERENDER_MARGIN = '600px 0px';
/** The pane divider is dragged continuously; re-rasterizing per frame is not. */
const WIDTH_SETTLE_MS = 120;

export const PdfCanvasView: React.FC<PdfCanvasViewProps> = ({ data, zoom, onPageCount }) => {
  const [pages, setPages] = useState<PageGeometry[]>([]);
  const [containerWidth, setContainerWidth] = useState(0);
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  const [visible, setVisible] = useState<Set<number>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const geometryRef = useRef<Map<number, PageGeometry>>(new Map());
  const canvases = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const canvasRefs = useRef<Map<number, (element: HTMLCanvasElement | null) => void>>(new Map());
  const renderTasks = useRef<Map<number, RenderTask>>(new Map());
  /** Signature of the raster each canvas currently holds. */
  const renderedAt = useRef<Map<number, string>>(new Map());
  /** Signature each canvas is currently being painted at. */
  const inFlight = useRef<Map<number, string>>(new Map());
  /** Loads are serialized through this: see the comment in the load effect. */
  const loadChain = useRef<Promise<void>>(Promise.resolve());
  const pendingScroll = useRef<number | null>(null);
  const previousScale = useRef(0);
  const onPageCountRef = useRef(onPageCount);

  useEffect(() => {
    onPageCountRef.current = onPageCount;
  }, [onPageCount]);

  // Fit-width is the baseline: zoom 1 means the widest page exactly fills the
  // pane, which is what the old viewer's pinned "page-width" preset did.
  const settledWidth = useDebouncedValue(containerWidth, WIDTH_SETTLE_MS);
  const baseScale = useMemo(() => {
    const widest = pages.reduce((max, page) => Math.max(max, page.widthPt), 0);
    if (!widest || !settledWidth) return 1;
    return Math.max(MIN_BASE_SCALE, (settledWidth - PAGE_GUTTER * 2) / widest);
  }, [pages, settledWidth]);

  const scale = baseScale * (Number.isFinite(zoom) && zoom > 0 ? zoom : 1);

  const cancelRender = useCallback((index: number) => {
    const task = renderTasks.current.get(index);
    if (!task) return;
    renderTasks.current.delete(index);
    try {
      task.cancel();
    } catch {
      /* already finished */
    }
  }, []);

  const cancelAllRenders = useCallback(() => {
    for (const index of Array.from(renderTasks.current.keys())) cancelRender(index);
    inFlight.current.clear();
  }, [cancelRender]);

  const renderPage = useCallback(
    async (index: number, pageScale: number, ratio: number) => {
      const doc = docRef.current;
      const canvas = canvases.current.get(index);
      const geometry = geometryRef.current.get(index);
      if (!doc || !canvas || !geometry) return;

      const cssWidth = geometry.widthPt * pageScale;
      const cssHeight = geometry.heightPt * pageScale;
      const output = outputScaleFor(cssWidth, cssHeight, ratio);
      // Both halves matter: the same backing-store size at a different CSS size
      // is a stretched bitmap, which is the bug this component exists to fix.
      const signature = `${Math.round(cssWidth)}x${Math.round(cssHeight)}@${output.toFixed(3)}`;

      if (renderedAt.current.get(index) === signature) return;
      if (inFlight.current.get(index) === signature) return;

      // "Cannot use the same canvas during multiple render() operations" — a
      // zoom or a recompile routinely arrives while the previous pass is still
      // painting, and pdf.js refuses the second one outright.
      cancelRender(index);
      inFlight.current.set(index, signature);

      let task: RenderTask | null = null;
      try {
        const page = await doc.getPage(index);
        // A recompile or a further zoom landed while getPage was resolving.
        if (docRef.current !== doc || inFlight.current.get(index) !== signature) return;

        const viewport = page.getViewport({ scale: pageScale });
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) return;

        canvas.width = Math.max(1, Math.floor(viewport.width * output));
        canvas.height = Math.max(1, Math.floor(viewport.height * output));

        task = page.render({
          canvasContext: context,
          viewport,
          background: '#ffffff',
          transform: output === 1 ? undefined : [output, 0, 0, output, 0, 0]
        });
        renderTasks.current.set(index, task);
        await task.promise;
        renderedAt.current.set(index, signature);
      } catch (error) {
        if (!isRenderingCancelled(error)) console.error('pdf.js could not render a page', error);
      } finally {
        if (renderTasks.current.get(index) === task) renderTasks.current.delete(index);
        if (inFlight.current.get(index) === signature) inFlight.current.delete(index);
      }
    },
    [cancelRender]
  );

  // A new closure per render would make React detach and re-attach every canvas
  // on every state change, losing the raster each time.
  const registerCanvas = useCallback((index: number) => {
    const existing = canvasRefs.current.get(index);
    if (existing) return existing;

    const setter = (element: HTMLCanvasElement | null) => {
      if (element) {
        canvases.current.set(index, element);
        return;
      }
      canvases.current.delete(index);
      // A fresh canvas arrives blank, so the recorded raster is a lie.
      renderedAt.current.delete(index);
      inFlight.current.delete(index);
    };
    canvasRefs.current.set(index, setter);
    return setter;
  }, []);

  // --- load / reload, serialized ------------------------------------------
  useEffect(() => {
    let cancelled = false;

    // Keeps this instance's own reloads in order, so a 2-second auto-compile
    // cannot have two jobs writing docRef and the geometry maps at once.
    // Ordering against *another* instance's teardown is not something a ref can
    // do; pdfEngine's queue owns that.
    loadChain.current = loadChain.current
      .then(async () => {
        if (cancelled) return;

        cancelAllRenders();
        const previous = docRef.current;
        docRef.current = null;
        await destroyPdfDocument(previous);
        if (cancelled) return;

        if (!data || data.length === 0) {
          geometryRef.current = new Map();
          renderedAt.current.clear();
          setPages([]);
          setLoadError(null);
          setLoading(false);
          return;
        }

        // Auto-compile fires two seconds after the last keystroke; snapping back
        // to the top of page 1 every time makes the preview useless while
        // writing, so the scroll offset is carried across the reload.
        pendingScroll.current = scrollRef.current?.scrollTop ?? 0;
        setLoading(true);

        // Held out here so every way of leaving this job releases the document:
        // a truncated PDF makes getPage throw half-way through the geometry pass
        // and the throw used to escape to the chain's .catch with nobody left
        // holding the proxy, so the worker kept the parsed document and one
        // more port listener for every auto-compile that failed the same way.
        let opened: PDFDocumentProxy | null = null;
        try {
          opened = await loadPdfDocument(data);
          if (cancelled) return;

          const geometry: PageGeometry[] = [];
          for (let index = 1; index <= opened.numPages; index += 1) {
            const page = await opened.getPage(index);
            const viewport = page.getViewport({ scale: 1 });
            geometry.push({ index, widthPt: viewport.width, heightPt: viewport.height });
          }
          if (cancelled) return;

          const doc = opened;
          // Handed to docRef: the next reload, or the teardown, destroys it now.
          opened = null;

          docRef.current = doc;
          geometryRef.current = new Map(geometry.map(entry => [entry.index, entry]));
          // The canvases still hold the previous document's pages at exactly the
          // signatures the new ones would compute, so nothing would repaint.
          renderedAt.current.clear();
          inFlight.current.clear();
          setPages(geometry);
          setLoadError(null);
          setLoading(false);
          onPageCountRef.current?.(doc.numPages);
        } finally {
          await destroyPdfDocument(opened);
        }
      })
      .catch(error => {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : String(error));
        setLoading(false);
        setPages([]);
      });

    return () => {
      cancelled = true;
    };
  }, [data, cancelAllRenders]);

  // --- devicePixelRatio ----------------------------------------------------
  useEffect(() => {
    // A 'resize' listener does not fire when only the scale factor changes:
    // dragging the window to a differently-scaled monitor leaves the pane's CSS
    // size alone. Watch the resolution itself, and re-arm after every change
    // because the query is pinned to the ratio it was built with.
    const query = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const onChange = () => setDpr(window.devicePixelRatio || 1);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [dpr]);

  // --- pane width ----------------------------------------------------------
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    // The editor/PDF split divider is draggable, so a window resize listener
    // would miss most of the width changes that matter here.
    const observer = new ResizeObserver(entries => {
      const entry = entries[0];
      if (entry) setContainerWidth(entry.contentRect.width);
    });
    observer.observe(element);
    setContainerWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  // --- which pages are worth rasterizing -----------------------------------
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || pages.length === 0) return;

    const observer = new IntersectionObserver(
      entries => {
        setVisible(previousVisible => {
          const next = new Set(previousVisible);
          let changed = false;
          for (const entry of entries) {
            const index = Number((entry.target as HTMLElement).dataset.page);
            if (!Number.isFinite(index)) continue;
            if (entry.isIntersecting) {
              if (!next.has(index)) {
                next.add(index);
                changed = true;
              }
            } else if (next.delete(index)) {
              changed = true;
            }
          }
          // Returning a fresh Set unconditionally re-runs the render effect on
          // every scroll frame and pegs a core.
          return changed ? next : previousVisible;
        });
      },
      { root, rootMargin: PRERENDER_MARGIN }
    );

    root.querySelectorAll<HTMLElement>('[data-page]').forEach(element => observer.observe(element));
    return () => observer.disconnect();
  }, [pages]);

  // --- render / evict ------------------------------------------------------
  useEffect(() => {
    if (pages.length === 0) return;

    visible.forEach(index => void renderPage(index, scale, dpr));

    for (const [index, canvas] of canvases.current) {
      if (visible.has(index)) continue;
      if (!renderedAt.current.has(index) && !inFlight.current.has(index)) continue;
      // A page's backing store is width × height × 4 bytes; holding two hundred
      // of them runs the webview out of memory on a thesis.
      cancelRender(index);
      inFlight.current.delete(index);
      renderedAt.current.delete(index);
      canvas.width = 0;
      canvas.height = 0;
    }
  }, [visible, scale, dpr, pages, renderPage, cancelRender]);

  // --- scroll position -----------------------------------------------------
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    if (pendingScroll.current !== null) {
      // The page wrappers carry their exact size, so scrollHeight is already
      // correct here even though no page has been rasterized yet.
      const limit = Math.max(0, element.scrollHeight - element.clientHeight);
      element.scrollTop = Math.min(pendingScroll.current, limit);
      pendingScroll.current = null;
    } else if (previousScale.current > 0 && previousScale.current !== scale) {
      // Keep the reader looking at the same part of the document across a zoom.
      element.scrollTop = element.scrollTop * (scale / previousScale.current);
    }

    previousScale.current = scale;
  }, [pages, scale]);

  // --- teardown ------------------------------------------------------------
  useEffect(
    () => () => {
      cancelAllRenders();
      const doc = docRef.current;
      docRef.current = null;
      // A cleanup cannot await, but destroyPdfDocument queues on the module's
      // worker chain, so the next instance's load still waits for this.
      void destroyPdfDocument(doc);
    },
    [cancelAllRenders]
  );

  const message = loadError
    ? `Could not display this PDF: ${loadError}`
    : loading && pages.length === 0
      ? 'Rendering PDF…'
      : '';

  return (
    <div className="pdf-canvas-view">
      <div className="pdf-canvas-scroll" ref={scrollRef}>
        <div className="pdf-canvas-pages">
          {pages.map(page => {
            const width = Math.max(1, Math.floor(page.widthPt * scale));
            const height = Math.max(1, Math.floor(page.heightPt * scale));
            return (
              <div className="pdf-page" key={page.index} data-page={page.index} style={{ width, height }}>
                <canvas ref={registerCanvas(page.index)} style={{ width, height }} />
              </div>
            );
          })}
        </div>
        {message && <div className="pdf-canvas-message">{message}</div>}
      </div>
    </div>
  );
};

export default PdfCanvasView;

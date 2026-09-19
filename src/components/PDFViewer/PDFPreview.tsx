import React, { useMemo, useState } from 'react';
import { ZoomIn, ZoomOut, Download, FileCheck, Terminal, ChevronDown, ChevronRight, Square } from 'lucide-react';
import { explainLog } from '../../services/latexErrors';
import { CompileProblems } from './CompileProblems';
import { PdfCanvasView } from './PdfCanvasView';

/**
 * One <div> per log line is unbounded DOM. The backend caps engine output at
 * 8 MB, which makes a runaway \errmessage loop reachable from here for the
 * first time — the tail is the part that explains the failure anyway.
 */
const MAX_LOG_LINES = 2000;

interface PDFPreviewProps {
  compiledUrl: string | null;
  /**
   * The same PDF as raw bytes, when a real engine produced it. pdf.js renders
   * from these; `compiledUrl` stays behind for the Download button and for the
   * HTML preview, which has no bytes.
   */
  pdfData?: Uint8Array | null;
  compileLog: string;
  isCompiling: boolean;
  /** A real engine produced a PDF; the quick preview only produces HTML. */
  isPdf?: boolean;
  /** Which pass the engine is on, from the backend's progress events. */
  compileStep?: string;
  /** Kills the running engine. Absent for engines that cannot be stopped. */
  onCancelCompile?: () => void;
  /** Called when a compiler error line is clicked. */
  onJumpToError?: (fileName: string, line: number) => void;
  /** Installs a package a diagnostic says is missing. */
  onInstallPackage?: (packageName: string) => void;
  /** The package currently being installed, if any. */
  installingPackage?: string;
}

export const PDFPreview: React.FC<PDFPreviewProps> = ({
  compiledUrl,
  pdfData = null,
  compileLog,
  isCompiling,
  isPdf = false,
  compileStep = '',
  onCancelCompile,
  onJumpToError,
  onInstallPackage,
  installingPackage = ''
}) => {
  const [zoom, setZoom] = useState(100);
  const [showRawLog, setShowRawLog] = useState(false);

  // Reading a 2,000-line log for the one line that matters is the worst part of
  // compiling locally, so the log is explained first and shown second.
  const diagnostics = useMemo(() => explainLog(compileLog), [compileLog]);

  // Splitting an 8 MB log is not worth doing for a panel nobody has opened.
  const rawLog = useMemo(() => {
    if (!showRawLog || !compileLog) return { lines: [] as string[], total: 0 };
    const lines = compileLog.split('\n');
    return {
      lines: lines.length > MAX_LOG_LINES ? lines.slice(-MAX_LOG_LINES) : lines,
      total: lines.length
    };
  }, [compileLog, showRawLog]);

  // The canvas renderer re-rasterizes at every zoom level, so high zoom is
  // finally worth offering: the old iframe only ever resampled one bitmap.
  const handleZoomIn = () => setZoom(prev => Math.min(prev + 25, 400));
  const handleZoomOut = () => setZoom(prev => Math.max(prev - 25, 50));
  const handleDownload = () => {
    if (compiledUrl) {
      const a = document.createElement('a');
      a.href = compiledUrl;
      // A real engine produces a PDF; the quick preview is only HTML.
      a.download = isPdf ? 'zabbleaf.pdf' : 'zabbleaf-preview.html';
      a.click();
    }
  };

  const showCanvas = isPdf && !!pdfData;
  // Nothing has been compiled yet, so there is no last-good preview to keep on
  // screen and the compile indicator can have the whole pane.
  const previewIsEmpty = !showCanvas && !compiledUrl;

  const compileIndicator = isCompiling && (
    <div className={`pdf-compile-overlay${previewIsEmpty ? ' pdf-compile-overlay--full' : ''}`}>
      <div className="pdf-compile-card" role="status" aria-live="polite">
        <span className="pdf-compile-spinner" aria-hidden="true">⚙️</span>
        <div className="pdf-compile-text">
          <p>Compiling LaTeX document...</p>
          {/* A bibliography build runs four processes; without this it looks
              identical to a hang for the whole of it. */}
          {compileStep && <p className="pdf-compile-step">{compileStep}</p>}
        </div>
        {onCancelCompile && (
          <button
            className="btn-secondary pdf-compile-stop"
            onClick={onCancelCompile}
            title="Stop the running engine"
          >
            <Square size={14} fill="#c97b7b" color="#c97b7b" /> Stop
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className="pdf-pane">
      <div className="pane-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <FileCheck size={14} color="#6fa8cc" />
          <span>Compiled PDF Preview</span>
          {zoom !== 100 && (
            <button
              onClick={() => setZoom(100)}
              title="Back to fit width"
              style={{
                background: 'none',
                border: 'none',
                padding: 0,
                font: 'inherit',
                fontSize: '0.7rem',
                color: '#7b8593',
                cursor: 'pointer'
              }}
            >
              {zoom}%
            </button>
          )}
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button className="btn-secondary" style={{ padding: '4px 8px' }} title="Zoom In" onClick={handleZoomIn}>
            <ZoomIn size={14} />
          </button>
          <button className="btn-secondary" style={{ padding: '4px 8px' }} title="Zoom Out" onClick={handleZoomOut}>
            <ZoomOut size={14} />
          </button>
          <button className="btn-secondary" style={{ padding: '4px 8px' }} title="Download Preview" onClick={handleDownload} disabled={!compiledUrl}>
            <Download size={14} />
          </button>
        </div>
      </div>

      {/* The indicator is a sibling of the scrolling container rather than a
          child of it, so it stays put instead of scrolling away with the
          preview it sits on top of. */}
      <div className="pdf-viewer-stage">
        <div className={`pdf-viewer-container${showCanvas ? ' pdf-viewer-container--canvas' : ''}`} style={{ padding: 0 }}>
          {showCanvas ? (
            // Rasterized into a canvas at devicePixelRatio rather than shown in an
            // iframe: WebKit lays its embedded viewer out to the frame's CSS width
            // and pins it to page-width, so a transform on the frame only
            // resamples a bitmap that was already drawn at the wrong size.
            //
            // It is deliberately NOT swapped out for the compile indicator:
            // auto-compile fires two seconds after the last keystroke, and
            // unmounting this throws away the document, every rasterized page and
            // the scroll offset PdfCanvasView carries across a reload — typing one
            // character on page 12 would bounce the reader back to page 1.
            <PdfCanvasView data={pdfData} zoom={zoom / 100} />
          ) : compiledUrl ? (
            // The HTML preview genuinely does reflow to the frame's width, so the
            // reciprocal width/transform pair is the right zoom for this branch.
            <iframe
              src={compiledUrl}
              className="pdf-iframe-container"
              title="Compiled PDF"
              style={{ transform: `scale(${zoom / 100})`, transformOrigin: 'top left', width: `${10000 / zoom}%`, height: `${10000 / zoom}%` }}
            />
          ) : (
            <div style={{ color: '#a0a9b5', textAlign: 'center', padding: '40px', flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
              <FileCheck size={48} style={{ opacity: 0.2, marginBottom: '12px' }} />
              <p>Click <strong>Recompile</strong> to generate the PDF preview.</p>
            </div>
          )}
        </div>
        {compileIndicator}
      </div>

      {diagnostics.length > 0 && (
        <div className="problems-pane">
          <CompileProblems
            diagnostics={diagnostics}
            onJump={(fileName, line) => {
              if (line && onJumpToError) onJumpToError(fileName || '', line);
            }}
            onInstallPackage={packageName => onInstallPackage?.(packageName)}
            installing={installingPackage}
          />
        </div>
      )}

      {compileLog && (
        <div className="compile-log">
          <button
            className="compile-log-toggle"
            onClick={() => setShowRawLog(current => !current)}
            title="The unedited output of the TeX engine"
          >
            {showRawLog ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <Terminal size={12} /> Compiler output
          </button>

          {showRawLog && rawLog.total > rawLog.lines.length && (
            <div style={{ color: '#7b8593' }}>
              Showing the last {rawLog.lines.length} of {rawLog.total} lines.
            </div>
          )}

          {showRawLog && rawLog.lines.map((line, index) => {
            // -file-line-error makes the engine print "main.tex:37: message",
            // which is enough to jump straight to the offending line.
            const hit = line.match(/^([^\s:]+\.(?:tex|sty|cls|bib)):(\d+):\s*(.*)$/);
            if (!hit || !onJumpToError) return <div key={index}>{line}</div>;

            const [, fileName, lineNumber, message] = hit;
            return (
              <div key={index}>
                <button
                  onClick={() => onJumpToError(fileName, Number(lineNumber))}
                  title={`Go to ${fileName} line ${lineNumber}`}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    font: 'inherit',
                    color: '#c97b7b',
                    cursor: 'pointer',
                    textDecoration: 'underline'
                  }}
                >
                  {fileName}:{lineNumber}
                </button>
                <span style={{ color: '#ccd2da' }}>: {message}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

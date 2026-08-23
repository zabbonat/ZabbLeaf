import React, { useMemo, useState } from 'react';
import { ZoomIn, ZoomOut, Download, FileCheck, Terminal, ChevronDown, ChevronRight } from 'lucide-react';
import { explainLog } from '../../services/latexErrors';
import { CompileProblems } from './CompileProblems';

interface PDFPreviewProps {
  compiledUrl: string | null;
  compileLog: string;
  isCompiling: boolean;
  /** A real engine produced a PDF; the quick preview only produces HTML. */
  isPdf?: boolean;
  /** Called when a compiler error line is clicked. */
  onJumpToError?: (fileName: string, line: number) => void;
  /** Installs a package a diagnostic says is missing. */
  onInstallPackage?: (packageName: string) => void;
  /** The package currently being installed, if any. */
  installingPackage?: string;
}

export const PDFPreview: React.FC<PDFPreviewProps> = ({
  compiledUrl,
  compileLog,
  isCompiling,
  isPdf = false,
  onJumpToError,
  onInstallPackage,
  installingPackage = ''
}) => {
  const [zoom, setZoom] = useState(100);
  const [showRawLog, setShowRawLog] = useState(false);

  // Reading a 2,000-line log for the one line that matters is the worst part of
  // compiling locally, so the log is explained first and shown second.
  const diagnostics = useMemo(() => explainLog(compileLog), [compileLog]);

  const handleZoomIn = () => setZoom(prev => Math.min(prev + 15, 200));
  const handleZoomOut = () => setZoom(prev => Math.max(prev - 15, 50));
  const handleDownload = () => {
    if (compiledUrl) {
      const a = document.createElement('a');
      a.href = compiledUrl;
      // A real engine produces a PDF; the quick preview is only HTML.
      a.download = isPdf ? 'zabbleaf.pdf' : 'zabbleaf-preview.html';
      a.click();
    }
  };

  return (
    <div className="pdf-pane">
      <div className="pane-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <FileCheck size={14} color="#6fa8cc" />
          <span>Compiled PDF Preview</span>
          {zoom !== 100 && (
            <span style={{ fontSize: '0.7rem', color: '#7b8593' }}>{zoom}%</span>
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

      <div className="pdf-viewer-container" style={{ padding: 0 }}>
        {isCompiling ? (
          <div style={{ color: '#a0a9b5', textAlign: 'center', padding: '40px', flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ fontSize: '2rem', marginBottom: '12px', animation: 'spin 1s linear infinite' }}>⚙️</div>
            <p>Compiling LaTeX document...</p>
          </div>
        ) : compiledUrl ? (
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

          {showRawLog && compileLog.split('\n').map((line, index) => {
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

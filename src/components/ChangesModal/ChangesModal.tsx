import React from 'react';
import { X, Upload, GitCompare } from 'lucide-react';

interface ChangesModalProps {
  isOpen: boolean;
  projectName: string;
  files: string[];
  diff: string;
  isSyncing: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/** Colours a unified diff without pulling in a syntax highlighter. */
const lineColour = (line: string): string => {
  if (line.startsWith('+++') || line.startsWith('---')) return '#7b8593';
  if (line.startsWith('@@')) return '#89a7bd';
  if (line.startsWith('+')) return '#7fbf9a';
  if (line.startsWith('-')) return '#c97b7b';
  return '#a0a9b5';
};

/**
 * Shows what a sync is about to publish. After a few hours offline nobody
 * remembers everything they touched, and on a shared document that is the
 * difference between pressing the button confidently and pressing it hoping.
 */
export const ChangesModal: React.FC<ChangesModalProps> = ({
  isOpen,
  projectName,
  files,
  diff,
  isSyncing,
  onConfirm,
  onClose
}) => {
  if (!isOpen) return null;

  const lines = diff.split('\n').slice(0, 600);

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: '820px', width: '90vw' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <GitCompare size={22} color="#6fa8cc" />
            <h2 style={{ fontSize: '1.1rem', margin: 0 }}>About to publish to {projectName}</h2>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#a0a9b5', cursor: 'pointer' }}>
            <X size={20} />
          </button>
        </div>

        {files.length === 0 ? (
          <p style={{ color: '#a0a9b5', fontSize: '0.9rem' }}>
            Nothing has changed since the last sync. Syncing will still pull anything new from Overleaf.
          </p>
        ) : (
          <>
            <div style={{ fontSize: '0.85rem', color: '#ccd2da', marginBottom: '10px' }}>
              {files.length} file{files.length === 1 ? '' : 's'} changed:
            </div>
            <div style={{ marginBottom: '14px', display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {files.map(file => (
                <span
                  key={file}
                  style={{
                    fontSize: '0.75rem',
                    fontFamily: 'monospace',
                    background: 'rgba(111, 168, 204, 0.12)',
                    border: '1px solid rgba(111, 168, 204, 0.3)',
                    borderRadius: '6px',
                    padding: '3px 8px'
                  }}
                >
                  {file}
                </span>
              ))}
            </div>

            <pre
              style={{
                maxHeight: '46vh',
                overflow: 'auto',
                background: '#1c2025',
                border: '1px solid #39404a',
                borderRadius: '8px',
                padding: '12px',
                fontSize: '0.75rem',
                lineHeight: 1.5,
                margin: 0
              }}
            >
              {lines.map((line, index) => (
                <div key={index} style={{ color: lineColour(line), whiteSpace: 'pre-wrap' }}>
                  {line || ' '}
                </div>
              ))}
            </pre>
          </>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '18px' }}>
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-sync" onClick={onConfirm} disabled={isSyncing}>
            <Upload size={16} /> {isSyncing ? 'Syncing...' : 'Publish to Overleaf'}
          </button>
        </div>
      </div>
    </div>
  );
};

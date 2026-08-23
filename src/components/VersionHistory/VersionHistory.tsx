import React from 'react';
import { RotateCcw, FileText } from 'lucide-react';
import { VersionSnapshot, VersionHistoryService } from '../../services/versionHistory';

interface VersionHistoryProps {
  snapshots: VersionSnapshot[];
  onRestore: (snapshot: VersionSnapshot) => void;
}

/**
 * Renders the list only: the panel around it, and its title, now come from the
 * tabbed side panel this lives in.
 */
export const VersionHistory: React.FC<VersionHistoryProps> = ({
  snapshots,
  onRestore
}) => {
  if (snapshots.length === 0) {
    return (
      <div className="panel-empty">
        <p>No versions saved yet.</p>
        <p className="panel-empty-hint">
          One is written every time you compile, so offline changes can always be rolled back.
        </p>
      </div>
    );
  }

  return (
    <>
      <ul className="version-list">
        {snapshots.map((snapshot, index) => (
          <li key={snapshot.id} className="version-item">
            <div className="version-timeline">
              <div className={`version-dot ${index === 0 ? 'latest' : ''}`} />
              {index < snapshots.length - 1 && <div className="version-line" />}
            </div>

            <div className="version-content">
              <div className="version-time">
                {VersionHistoryService.timeAgo(snapshot.timestamp)}
              </div>
              <div className="version-message">
                <FileText size={12} color="#a0a9b5" />
                {snapshot.message}
              </div>
              <div className="version-file">{snapshot.fileName}</div>

              {index > 0 && (
                <button
                  className="version-restore-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRestore(snapshot);
                  }}
                >
                  <RotateCcw size={12} /> Restore
                </button>
              )}
              {index === 0 && (
                <span className="version-current-badge">Current</span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
};

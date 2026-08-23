import React, { useRef, useState } from 'react';
import {
  FileText,
  Folder,
  Plus,
  FileCode,
  Database,
  FolderOpen,
  Trash2,
  ImagePlus,
  Image as ImageIcon
} from 'lucide-react';
import { ProjectAsset, formatBytes } from '../../services/projectAssets';

export interface FileNode {
  id: string;
  name: string;
  type: 'file' | 'folder';
  content?: string;
  isModified?: boolean;
  lastSynced?: string;
  children?: FileNode[];
}

interface FileTreeProps {
  files: FileNode[];
  activeFileId: string;
  onSelectFile: (id: string) => void;
  onNewFile: (fileName: string) => void;
  onDeleteFile: (id: string) => void;
  onOpenFolder: () => void;
  currentFolderPath?: string;
  /** Images and PDFs in the project, which are not editable text. */
  assets?: ProjectAsset[];
  onAddImage?: (file: File) => void;
  onInsertAsset?: (path: string) => void;
  onDeleteAsset?: (path: string) => void;
  width?: number;
}

export const FileTree: React.FC<FileTreeProps> = ({
  files,
  activeFileId,
  onSelectFile,
  onNewFile,
  onDeleteFile,
  onOpenFolder,
  currentFolderPath,
  assets = [],
  onAddImage,
  onInsertAsset,
  onDeleteAsset,
  width
}) => {
  const [isAddingFile, setIsAddingFile] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const filePicker = useRef<HTMLInputElement>(null);

  const getFileIcon = (fileName: string) => {
    if (fileName.endsWith('.tex')) return <FileCode size={16} color="#6fa8cc" />;
    if (fileName.endsWith('.bib')) return <Database size={16} color="#89a7bd" />;
    return <FileText size={16} color="#a0a9b5" />;
  };

  const handleAddSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFileName.trim()) return;
    let name = newFileName.trim();
    if (!name.includes('.')) name += '.tex'; // default to .tex
    onNewFile(name);
    setNewFileName('');
    setIsAddingFile(false);
  };

  return (
    <aside className="sidebar" style={width ? { width } : undefined}>
      {/* Folder Picker Header */}
      <div style={{ padding: '12px 16px', borderBottom: '1px solid #39404a', background: 'rgba(28, 32, 37, 0.9)' }}>
        <button
          className="btn-secondary"
          onClick={onOpenFolder}
          style={{ width: '100%', justifyContent: 'center', gap: '8px' }}
        >
          <FolderOpen size={16} color="#d1a054" />
          <span>Open Local Folder...</span>
        </button>
        {currentFolderPath && (
          <div style={{ fontSize: '0.7rem', color: '#a0a9b5', marginTop: '6px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            📁 {currentFolderPath}
          </div>
        )}
      </div>

      <div className="sidebar-header">
        <span>Project Files ({files.length})</span>
        <button
          onClick={() => setIsAddingFile(true)}
          style={{
            background: 'rgba(111, 168, 204, 0.2)',
            border: '1px solid rgba(111, 168, 204, 0.4)',
            color: '#6fa8cc',
            borderRadius: '4px',
            padding: '2px 6px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            fontSize: '0.75rem'
          }}
          title="Create New File"
        >
          <Plus size={14} /> New File
        </button>
      </div>

      {/* New File Inline Form */}
      {isAddingFile && (
        <form onSubmit={handleAddSubmit} style={{ padding: '8px 12px', background: '#262b32', borderBottom: '1px solid #39404a' }}>
          <input
            type="text"
            className="input-control"
            placeholder="filename.tex"
            value={newFileName}
            onChange={(e) => setNewFileName(e.target.value)}
            autoFocus
            style={{ fontSize: '0.8rem', padding: '6px 10px' }}
          />
          <div style={{ display: 'flex', gap: '6px', marginTop: '6px', justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="btn-secondary"
              style={{ fontSize: '0.75rem', padding: '2px 8px' }}
              onClick={() => setIsAddingFile(false)}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn-sync"
              style={{ fontSize: '0.75rem', padding: '2px 10px' }}
            >
              Add
            </button>
          </div>
        </form>
      )}

      {/* File List */}
      <ul className="file-list">
        {files.map((file) => (
          <li
            key={file.id}
            className={`file-item ${file.id === activeFileId ? 'active' : ''}`}
            style={{ justifyContent: 'space-between' }}
            onClick={() => onSelectFile(file.id)}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden' }}>
              {file.type === 'folder' ? <Folder size={16} color="#d1a054" /> : getFileIcon(file.name)}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {file.name}
              </span>
              {file.isModified && (
                <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#d1a054', flexShrink: 0 }} title="Modified" />
              )}
            </div>

            {files.length > 1 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteFile(file.id);
                }}
                style={{ background: 'none', border: 'none', color: '#7b8593', cursor: 'pointer', opacity: 0.6 }}
                title="Delete File"
              >
                <Trash2 size={13} />
              </button>
            )}
          </li>
        ))}
      </ul>

      {/* Figures: not editable text, so they never appeared in this list at all. */}
      {onAddImage && (
        <>
          <div className="sidebar-header" style={{ borderTop: '1px solid #262b32' }}>
            <span>Figures ({assets.length})</span>
            <button
              onClick={() => filePicker.current?.click()}
              className="sidebar-add"
              title="Add an image from your computer"
            >
              <ImagePlus size={14} /> Add
            </button>
          </div>

          <input
            ref={filePicker}
            type="file"
            accept="image/*,.pdf,.eps"
            style={{ display: 'none' }}
            onChange={event => {
              const chosen = event.target.files?.[0];
              if (chosen) onAddImage(chosen);
              // Cleared so choosing the same file twice still fires.
              event.target.value = '';
            }}
          />

          {assets.length === 0 ? (
            <div className="sidebar-hint">
              Paste a screenshot into the editor, drop an image on the window, or use Add.
            </div>
          ) : (
            <ul className="file-list">
              {assets.map(asset => (
                <li key={asset.name} className="file-item asset-item">
                  <button
                    className="asset-insert"
                    onClick={() => onInsertAsset?.(asset.name)}
                    title={`Insert a figure block for ${asset.name}`}
                  >
                    <ImageIcon size={15} color="#d1a054" />
                    <span className="asset-name">{asset.name}</span>
                    <span className="asset-size">{formatBytes(asset.bytes)}</span>
                  </button>
                  {onDeleteAsset && (
                    <button
                      onClick={() => onDeleteAsset(asset.name)}
                      style={{ background: 'none', border: 'none', color: '#7b8593', cursor: 'pointer' }}
                      title="Delete this figure"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <div style={{ padding: '12px 16px', borderTop: '1px solid #262b32', fontSize: '0.75rem', color: '#7b8593' }}>
        <div>ZabbLeaf Desktop IDE</div>
        <div style={{ color: '#6fa8cc', marginTop: '2px' }}>by Diletta Abbonato (Zabbonat)</div>
      </div>
    </aside>
  );
};

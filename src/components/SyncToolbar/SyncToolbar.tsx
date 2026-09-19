import React, { useState, useEffect } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import {
  RefreshCw,
  Wifi,
  WifiOff,
  Play,
  Square,
  UserCheck,
  FolderGit2,
  Home,
  ChevronDown,
  LogOut,
  Repeat,
  PanelLeft,
  PanelRight,
  FileCode2,
  FileText
} from 'lucide-react';
import { PanelKey } from '../../hooks/usePanelLayout';

export type CompilerEngine = 'html-preview' | 'overleaf-cloud' | 'pdflatex' | 'xelatex' | 'lualatex';

export interface CompilerOption {
  id: CompilerEngine;
  label: string;
  description: string;
  available: boolean;
}

interface SyncToolbarProps {
  isOnline: boolean;
  isSyncing: boolean;
  isCompiling: boolean;
  onSync: () => void;
  onCompile: () => void;
  /** Kill the running engine. Only reachable while `canCancelCompile`. */
  onCancelCompile: () => void;
  /**
   * True only for the engines that run a real TeX process we can kill.
   * html-preview finishes in milliseconds and overleaf-cloud is a push that
   * must not be interrupted half-way, so neither gets a Stop button.
   */
  canCancelCompile: boolean;
  /** Which pass is running, e.g. "pdflatex — pass 2 of 3". Empty between compiles. */
  compileStep?: string;
  onOpenAuth: () => void;
  onLogout: () => void;
  isLoggedIn: boolean;
  onHome: () => void;
  projectName: string;
  selectedCompiler: CompilerEngine;
  compilerOptions: CompilerOption[];
  onCompilerChange: (compiler: CompilerEngine) => void;
  /** Recompile a couple of seconds after typing stops. */
  autoCompile: boolean;
  onToggleAutoCompile: () => void;
  /** The file that actually gets compiled. */
  rootDocument: string;
  /** Every file with its own preamble, so a project can hold several. */
  rootDocuments: string[];
  onRootDocumentChange: (fileName: string) => void;
  /** Which panels are currently hidden. */
  collapsed: Record<PanelKey, boolean>;
  onTogglePanel: (key: PanelKey) => void;
}

export const SyncToolbar: React.FC<SyncToolbarProps> = ({
  isOnline,
  isSyncing,
  isCompiling,
  onSync,
  onCompile,
  onCancelCompile,
  canCancelCompile,
  compileStep,
  onOpenAuth,
  onLogout,
  isLoggedIn,
  onHome,
  projectName,
  selectedCompiler,
  compilerOptions,
  onCompilerChange,
  autoCompile,
  onToggleAutoCompile,
  rootDocument,
  rootDocuments,
  onRootDocumentChange,
  collapsed,
  onTogglePanel
}) => {
  const selectedOption = compilerOptions.find(c => c.id === selectedCompiler);

  // Four switches for the four columns. Shown as pressed when the panel is
  // open, which is the state people read off a toolbar without thinking.
  const PANEL_BUTTONS: { key: PanelKey; icon: React.ReactNode; label: string; hint: string }[] = [
    { key: 'files', icon: <PanelLeft size={14} />, label: 'Files', hint: 'file list (Ctrl+B)' },
    { key: 'editor', icon: <FileCode2 size={14} />, label: 'Editor', hint: 'editor' },
    { key: 'pdf', icon: <FileText size={14} />, label: 'PDF', hint: 'PDF preview' },
    { key: 'panel', icon: <PanelRight size={14} />, label: 'Panel', hint: 'side panel (Ctrl+J)' }
  ];

  // Read from tauri.conf.json rather than hardcoded: the badge had drifted to
  // "v2.1" while releases were already at v3.1.
  const [version, setVersion] = useState('');
  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion(''));
  }, []);

  const getCompilerColor = (id: CompilerEngine) => {
    if (id === 'html-preview') return '#d1a054';
    if (id === 'overleaf-cloud') return '#89a7bd';
    return '#6fa8cc';
  };

  return (
    <header className="top-toolbar">
      <div className="brand-section">
        <button 
          onClick={onHome} 
          className="btn-secondary" 
          style={{ padding: '6px 10px', marginRight: '10px' }}
          title="Back to Projects"
        >
          <Home size={16} /> Home
        </button>
        <div className="brand-logo" style={{ cursor: 'pointer' }} onClick={onHome}>
          <span>🌿</span> ZabbLeaf
        </div>
        {version && <span className="brand-badge">Desktop v{version}</span>}
        <span style={{ color: '#4d5560', margin: '0 8px' }}>|</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem', color: '#ccd2da' }}>
          <FolderGit2 size={16} color="#6fa8cc" />
          <strong>{projectName}</strong>
        </div>
      </div>

      <div className="toolbar-controls">
        <div className="panel-toggles">
          {PANEL_BUTTONS.map(button => (
            <button
              key={button.key}
              className={`panel-toggle ${collapsed[button.key] ? '' : 'active'}`}
              onClick={() => onTogglePanel(button.key)}
              title={`${collapsed[button.key] ? 'Show' : 'Hide'} the ${button.hint}`}
              aria-pressed={!collapsed[button.key]}
            >
              {button.icon}
            </button>
          ))}
        </div>

        <div className="status-indicator">
          {isOnline ? (
            <>
              <div className="status-dot online" />
              <Wifi size={14} color="#6fa8cc" />
              <span>Connected</span>
            </>
          ) : (
            <>
              <div className="status-dot offline" />
              <WifiOff size={14} color="#d1a054" />
              <span>Offline Mode</span>
            </>
          )}
        </div>

        {/* Compiler Selector Dropdown */}
        <div style={{ position: 'relative', display: 'inline-block' }}>
          <select
            value={selectedCompiler}
            onChange={(e) => onCompilerChange(e.target.value as CompilerEngine)}
            style={{
              appearance: 'none',
              background: 'rgba(38, 43, 50, 0.8)',
              border: `1px solid ${getCompilerColor(selectedCompiler)}40`,
              color: '#f2f5f8',
              padding: '6px 28px 6px 10px',
              borderRadius: '6px',
              fontSize: '0.8rem',
              cursor: 'pointer',
              fontWeight: 500,
              minWidth: '140px'
            }}
          >
            {compilerOptions.map(opt => (
              <option 
                key={opt.id} 
                value={opt.id} 
                disabled={!opt.available}
              >
                {opt.available ? '' : '⊘ '}{opt.label}
              </option>
            ))}
          </select>
          <ChevronDown 
            size={12} 
            style={{ 
              position: 'absolute', 
              right: '8px', 
              top: '50%', 
              transform: 'translateY(-50%)', 
              pointerEvents: 'none',
              color: getCompilerColor(selectedCompiler)
            }} 
          />
        </div>

        {rootDocuments.length > 1 && (
          <select
            value={rootDocument}
            onChange={(e) => onRootDocumentChange(e.target.value)}
            title="Which document gets compiled. A project can hold more than one."
            style={{
              appearance: 'none',
              background: 'rgba(38, 43, 50, 0.8)',
              border: '1px solid #39404a',
              color: '#ccd2da',
              padding: '6px 10px',
              borderRadius: '6px',
              fontSize: '0.8rem',
              cursor: 'pointer',
              maxWidth: '170px'
            }}
          >
            {rootDocuments.map(name => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        )}

        {/*
          The button turns into Stop rather than sitting greyed out: a cold
          lualatex font-cache build takes the better part of ten seconds and a
          runaway macro never finishes at all, and until now the only thing the
          disabled button offered was to wait it out. Stopping is local — it
          kills our own engine process and leaves the last good PDF on screen —
          so unlike Sync Overleaf it needs no confirmation.
        */}
        {isCompiling && canCancelCompile ? (
          <button
            className="btn-secondary"
            onClick={onCancelCompile}
            title="Stop the running compile. The last successful PDF stays on screen."
          >
            <Square size={14} fill="#c97b7b" color="#c97b7b" />
            Stop
          </button>
        ) : (
          <button className="btn-secondary" onClick={onCompile} disabled={isCompiling}>
            <Play size={14} fill="#6fa8cc" color="#6fa8cc" />
            {isCompiling ? 'Compiling...' : 'Recompile'}
          </button>
        )}

        {isCompiling && compileStep && (
          <span
            style={{ fontSize: '0.7rem', color: '#7b8593', whiteSpace: 'nowrap' }}
            title="A LaTeX document is compiled in several passes."
          >
            {compileStep}
          </span>
        )}

        <button
          className="btn-secondary"
          onClick={onToggleAutoCompile}
          title={
            autoCompile
              ? 'Recompiling automatically after you stop typing. Click to turn off.'
              : 'Automatic recompiling is off. Click to turn on.'
          }
          style={{ padding: '6px 10px', opacity: autoCompile ? 1 : 0.55 }}
        >
          <Repeat size={14} color={autoCompile ? '#6fa8cc' : '#7b8593'} />
          Auto
        </button>

        <button className="btn-sync" onClick={onSync} disabled={isSyncing}>
          <RefreshCw size={14} className={isSyncing ? 'spin-animation' : ''} />
          {isSyncing ? 'Syncing...' : 'Sync Overleaf'}
        </button>

        <button className="btn-secondary" onClick={onOpenAuth} title="Account & Overleaf Credentials">
          <UserCheck size={14} />
          Account
        </button>

        {isLoggedIn && (
          <button
            className="btn-secondary"
            onClick={onLogout}
            title="Sign out of Overleaf — your downloaded projects stay on this computer"
            style={{ padding: '6px 10px' }}
          >
            <LogOut size={14} />
          </button>
        )}
      </div>
    </header>
  );
};

import React from 'react';
import { Download, X, Loader2, CheckCircle2 } from 'lucide-react';

interface LaTeXSetupBannerProps {
  /** Hidden entirely once an engine is available. */
  isInstalled: boolean;
  isInstalling: boolean;
  isDismissed: boolean;
  onInstall: () => void;
  onDismiss: () => void;
}

/**
 * ZabbLeaf works without LaTeX — Overleaf compiles in the browser and the quick
 * preview needs nothing — so installing a TeX distribution is a choice, offered
 * here rather than forced at install time. This is the one place that works the
 * same on Windows, macOS and Linux, including for the .dmg and .AppImage
 * downloads, which have no installer UI of their own.
 */
export const LaTeXSetupBanner: React.FC<LaTeXSetupBannerProps> = ({
  isInstalled,
  isInstalling,
  isDismissed,
  onInstall,
  onDismiss
}) => {
  if (isInstalled || (isDismissed && !isInstalling)) return null;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '14px',
        margin: '0 0 18px',
        padding: '14px 18px',
        borderRadius: '12px',
        background: 'rgba(137, 167, 189, 0.08)',
        border: '1px solid rgba(137, 167, 189, 0.3)',
        color: '#e3e7ec'
      }}
    >
      <div style={{ fontSize: '1.5rem', flexShrink: 0 }}>
        {isInstalling ? <Loader2 size={24} className="spin" color="#89a7bd" /> : '📄'}
      </div>

      <div style={{ flex: 1, lineHeight: 1.5 }}>
        <div style={{ fontWeight: 600, marginBottom: '2px' }}>
          {isInstalling ? 'Installing LaTeX…' : 'Compile PDFs offline?'}
        </div>
        <div style={{ fontSize: '0.85rem', color: '#a0a9b5' }}>
          {isInstalling
            ? 'Downloading and setting up MiKTeX. This takes a few minutes — you can keep working.'
            : 'No LaTeX engine found. ZabbLeaf works fine without one, but installing MiKTeX (~142 MB) lets you build real PDFs without an internet connection.'}
        </div>
      </div>

      {!isInstalling && (
        <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
          <button className="btn-sync" onClick={onInstall} style={{ whiteSpace: 'nowrap' }}>
            <Download size={16} /> Install LaTeX
          </button>
          <button
            className="btn-secondary"
            onClick={onDismiss}
            title="Continue without a local LaTeX engine"
            style={{ padding: '6px 10px' }}
          >
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
};

interface GitMissingBannerProps {
  isInstalling: boolean;
  onInstall: () => void;
}

/**
 * git is a hard requirement, not a choice like a TeX engine: without it no
 * project can be downloaded or synced. So this one cannot be dismissed, and it
 * stays until git is actually there.
 */
export const GitMissingBanner: React.FC<GitMissingBannerProps> = ({ isInstalling, onInstall }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: '14px',
      margin: '0 0 18px',
      padding: '14px 18px',
      borderRadius: '12px',
      background: 'rgba(209, 160, 84, 0.10)',
      border: '1px solid rgba(209, 160, 84, 0.35)',
      color: '#e3e7ec'
    }}
  >
    <div style={{ fontSize: '1.5rem', flexShrink: 0 }}>
      {isInstalling ? <Loader2 size={24} className="spin" color="#d1a054" /> : '⚠️'}
    </div>

    <div style={{ flex: 1, lineHeight: 1.5 }}>
      <div style={{ fontWeight: 600, marginBottom: '2px' }}>
        {isInstalling ? 'Installing git…' : 'git is missing'}
      </div>
      <div style={{ fontSize: '0.85rem', color: '#a0a9b5' }}>
        {isInstalling ? (
          'This takes a minute. Windows will ask for administrator permission, because git has no per-user installer.'
        ) : (
          <>
            You need to install git: ZabbLeaf talks to Overleaf through it, so downloading and
            syncing projects will not work without it. If the button fails, install it yourself
            from{' '}
            <a
              href="https://git-scm.com/downloads"
              target="_blank"
              rel="noreferrer"
              style={{ color: '#6fa8cc' }}
            >
              git-scm.com
            </a>{' '}
            and restart ZabbLeaf.
          </>
        )}
      </div>
    </div>

    {!isInstalling && (
      <button className="btn-sync" onClick={onInstall} style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
        <Download size={16} /> Install git
      </button>
    )}
  </div>
);

interface LaTeXReadyNoticeProps {
  version: string;
}

/** Shown once, right after a successful install. */
export const LaTeXReadyNotice: React.FC<LaTeXReadyNoticeProps> = ({ version }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      margin: '0 0 18px',
      padding: '12px 18px',
      borderRadius: '12px',
      background: 'rgba(111, 168, 204, 0.08)',
      border: '1px solid rgba(111, 168, 204, 0.3)',
      color: '#e3e7ec',
      fontSize: '0.9rem'
    }}
  >
    <CheckCircle2 size={18} color="#6fa8cc" />
    <span>LaTeX is ready — {version}. Pick a local engine in the compiler menu.</span>
  </div>
);

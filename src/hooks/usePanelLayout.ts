/**
 * Panel sizes, remembered.
 *
 * The workspace used to be three fixed columns: a 250px file tree, an even
 * split between editor and PDF, and a 240px history panel. Nothing could be
 * widened and nothing could be closed, so reading a two-column PDF meant
 * squinting at half a window while a file list nobody was using held its
 * quarter.
 *
 * Sizes are pixels for the side columns and a ratio for the editor/PDF split,
 * which is what makes the middle behave when the window is resized.
 */

import { useCallback, useEffect, useState } from 'react';

export type PanelKey = 'files' | 'editor' | 'pdf' | 'panel';

export interface PanelLayout {
  sidebarWidth: number;
  panelWidth: number;
  /** Share of the middle taken by the editor, 0 to 1. */
  editorRatio: number;
  collapsed: Record<PanelKey, boolean>;
}

const LAYOUT_KEY = 'zabbleaf_layout';

const DEFAULT_LAYOUT: PanelLayout = {
  sidebarWidth: 250,
  panelWidth: 280,
  editorRatio: 0.5,
  collapsed: { files: false, editor: false, pdf: false, panel: true }
};

const LIMITS = {
  sidebar: { min: 170, max: 520 },
  panel: { min: 220, max: 640 },
  ratio: { min: 0.15, max: 0.85 }
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

function load(): PanelLayout {
  try {
    const stored = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null');
    if (!stored) return DEFAULT_LAYOUT;
    return {
      sidebarWidth: clamp(
        Number(stored.sidebarWidth) || DEFAULT_LAYOUT.sidebarWidth,
        LIMITS.sidebar.min,
        LIMITS.sidebar.max
      ),
      panelWidth: clamp(
        Number(stored.panelWidth) || DEFAULT_LAYOUT.panelWidth,
        LIMITS.panel.min,
        LIMITS.panel.max
      ),
      editorRatio: clamp(
        Number(stored.editorRatio) || DEFAULT_LAYOUT.editorRatio,
        LIMITS.ratio.min,
        LIMITS.ratio.max
      ),
      collapsed: { ...DEFAULT_LAYOUT.collapsed, ...(stored.collapsed || {}) }
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export function usePanelLayout() {
  const [layout, setLayout] = useState<PanelLayout>(load);

  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch {
      // Not worth interrupting anyone over.
    }
  }, [layout]);

  const toggle = useCallback((key: PanelKey) => {
    setLayout(current => {
      const collapsed = { ...current.collapsed, [key]: !current.collapsed[key] };
      // Closing both halves of the middle would leave an empty window.
      if (collapsed.editor && collapsed.pdf) {
        collapsed[key === 'editor' ? 'pdf' : 'editor'] = false;
      }
      return { ...current, collapsed };
    });
  }, []);

  const show = useCallback((key: PanelKey) => {
    setLayout(current =>
      current.collapsed[key]
        ? { ...current, collapsed: { ...current.collapsed, [key]: false } }
        : current
    );
  }, []);

  const resizeSidebar = useCallback((delta: number) => {
    setLayout(current => ({
      ...current,
      sidebarWidth: clamp(current.sidebarWidth + delta, LIMITS.sidebar.min, LIMITS.sidebar.max)
    }));
  }, []);

  const resizePanel = useCallback((delta: number) => {
    setLayout(current => ({
      ...current,
      // The right column grows when the divider moves left, hence the minus.
      panelWidth: clamp(current.panelWidth - delta, LIMITS.panel.min, LIMITS.panel.max)
    }));
  }, []);

  const resizeSplit = useCallback((delta: number, containerWidth: number) => {
    if (containerWidth <= 0) return;
    setLayout(current => ({
      ...current,
      editorRatio: clamp(
        current.editorRatio + delta / containerWidth,
        LIMITS.ratio.min,
        LIMITS.ratio.max
      )
    }));
  }, []);

  /** Double-clicking a divider puts that one back where it started. */
  const reset = useCallback((what: 'sidebar' | 'panel' | 'split') => {
    setLayout(current => ({
      ...current,
      sidebarWidth: what === 'sidebar' ? DEFAULT_LAYOUT.sidebarWidth : current.sidebarWidth,
      panelWidth: what === 'panel' ? DEFAULT_LAYOUT.panelWidth : current.panelWidth,
      editorRatio: what === 'split' ? DEFAULT_LAYOUT.editorRatio : current.editorRatio
    }));
  }, []);

  return { layout, toggle, show, resizeSidebar, resizePanel, resizeSplit, reset };
}

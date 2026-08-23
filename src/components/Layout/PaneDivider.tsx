import React, { useEffect, useRef } from 'react';

interface PaneDividerProps {
  /** Pixels the pointer moved since the last event, positive to the right. */
  onDrag: (delta: number) => void;
  onReset: () => void;
  title: string;
}

/**
 * The bar between two panels.
 *
 * The drag is tracked on the window rather than on the bar itself: the pointer
 * leaves a 6px strip immediately, and half the window is a PDF iframe that
 * would otherwise swallow every move event the moment the cursor crossed into
 * it. The class on the body handles the other half of that problem — it turns
 * off pointer events inside iframes for the duration, so the PDF viewer does
 * not start selecting text mid-drag.
 */
export const PaneDivider: React.FC<PaneDividerProps> = ({ onDrag, onReset, title }) => {
  const lastX = useRef(0);
  const dragging = useRef(false);
  // The listeners are bound once, so they read the current callback rather than
  // the one that existed when they were bound.
  const drag = useRef(onDrag);
  drag.current = onDrag;

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (!dragging.current) return;
      const delta = event.clientX - lastX.current;
      if (delta === 0) return;
      lastX.current = event.clientX;
      drag.current(delta);
    };

    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.classList.remove('is-resizing');
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.body.classList.remove('is-resizing');
    };
  }, []);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    lastX.current = event.clientX;
    dragging.current = true;
    document.body.classList.add('is-resizing');
  };

  return (
    <div
      className="pane-divider"
      role="separator"
      aria-orientation="vertical"
      title={`${title} — drag to resize, double-click to reset`}
      onPointerDown={handlePointerDown}
      onDoubleClick={onReset}
    >
      <span className="pane-divider-grip" />
    </div>
  );
};

interface CollapsedRailProps {
  label: string;
  side: 'left' | 'right';
  onExpand: () => void;
  icon: React.ReactNode;
}

/**
 * What is left of a closed panel: a strip narrow enough to forget, wide enough
 * to click. Without it a closed panel is only reachable from the toolbar, and
 * people forget it is there at all.
 */
export const CollapsedRail: React.FC<CollapsedRailProps> = ({ label, side, onExpand, icon }) => (
  <button
    className={`collapsed-rail ${side}`}
    onClick={onExpand}
    title={`Show ${label.toLowerCase()}`}
  >
    {icon}
    <span className="collapsed-rail-label">{label}</span>
  </button>
);

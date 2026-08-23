import React from 'react';
import { Type, Sigma, ImageIcon } from 'lucide-react';
import { WordCount, formatCount } from '../../services/textStats';

interface EditorStatusBarProps {
  count: WordCount;
  /** Words in the current selection, when there is one. */
  selectionWords: number;
  line: number;
  column: number;
  onOpenDetails: () => void;
}

/**
 * The line under the editor.
 *
 * A word count belongs where it can be glanced at without opening anything —
 * it is checked twenty times a day by anyone writing to a limit. The whole bar
 * opens the breakdown, so the number is a way in rather than a dead end.
 */
export const EditorStatusBar: React.FC<EditorStatusBarProps> = ({
  count,
  selectionWords,
  line,
  column,
  onOpenDetails
}) => (
  <div className="editor-status-bar">
    <button className="status-words" onClick={onOpenDetails} title="Open the word count breakdown">
      <Type size={12} />
      {selectionWords > 0 ? (
        <>
          <strong>{formatCount(selectionWords)}</strong> words selected
        </>
      ) : (
        <>
          <strong>{formatCount(count.words)}</strong> words
        </>
      )}
    </button>

    <span className="status-item" title="Inline and displayed maths">
      <Sigma size={12} />
      {count.inlineMath + count.displayMath}
    </span>

    <span className="status-item" title="Figures and tables">
      <ImageIcon size={12} />
      {count.figures + count.tables}
    </span>

    <span className="status-spacer" />

    <span className="status-item" title="Cursor position">
      Ln {line}, Col {column}
    </span>
  </div>
);

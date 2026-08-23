import React from 'react';
import { History, ListTodo, Sigma, Type, BarChart3, PanelRightClose } from 'lucide-react';
import { VersionHistory } from '../VersionHistory/VersionHistory';
import { TodoPanel } from './TodoPanel';
import { SymbolPanel } from './SymbolPanel';
import { WordsPanel } from './WordsPanel';
import { StatsPanel } from './StatsPanel';
import { VersionSnapshot } from '../../services/versionHistory';
import { TodoItem } from '../../services/todoScanner';
import { LatexSymbol } from '../../services/symbolPalette';
import { SectionCount, WordCount } from '../../services/textStats';
import { WritingSummary } from '../../services/writingStats';

export type SidePanelTab = 'history' | 'todo' | 'symbols' | 'words' | 'stats';

interface SidePanelProps {
  width: number;
  tab: SidePanelTab;
  onTabChange: (tab: SidePanelTab) => void;
  onClose: () => void;

  snapshots: VersionSnapshot[];
  onRestore: (snapshot: VersionSnapshot) => void;

  todos: TodoItem[];
  onOpenTodo: (fileName: string, line: number) => void;

  onInsertSymbol: (symbol: LatexSymbol) => void;

  fileName: string;
  wordCount: WordCount;
  sections: SectionCount[];
  projectWords: number;
  onJumpToLine: (line: number) => void;

  writing: WritingSummary;
}

const TABS: { id: SidePanelTab; label: string; icon: React.ReactNode }[] = [
  { id: 'todo', label: 'To do', icon: <ListTodo size={15} /> },
  { id: 'symbols', label: 'Symbols', icon: <Sigma size={15} /> },
  { id: 'words', label: 'Word count', icon: <Type size={15} /> },
  { id: 'stats', label: 'Writing', icon: <BarChart3 size={15} /> },
  { id: 'history', label: 'History', icon: <History size={15} /> }
];

/**
 * The right-hand column, which used to be the version history and nothing else.
 *
 * Everything here is a reference you glance at rather than a place you work, so
 * they share one column and one set of pixels instead of each taking a strip of
 * the window forever.
 */
export const SidePanel: React.FC<SidePanelProps> = ({
  width,
  tab,
  onTabChange,
  onClose,
  snapshots,
  onRestore,
  todos,
  onOpenTodo,
  onInsertSymbol,
  fileName,
  wordCount,
  sections,
  projectWords,
  onJumpToLine,
  writing
}) => {
  const active = TABS.find(entry => entry.id === tab) || TABS[0];

  return (
    <aside className="side-panel" style={{ width }}>
      <div className="side-panel-tabs">
        {TABS.map(entry => (
          <button
            key={entry.id}
            className={`side-panel-tab ${entry.id === tab ? 'active' : ''}`}
            onClick={() => onTabChange(entry.id)}
            title={entry.label}
            aria-label={entry.label}
          >
            {entry.icon}
            {entry.id === 'todo' && todos.length > 0 && (
              <span className="side-panel-badge">{todos.length > 99 ? '99+' : todos.length}</span>
            )}
          </button>
        ))}
        <span className="side-panel-spacer" />
        <button className="side-panel-close" onClick={onClose} title="Hide this panel (Ctrl+J)">
          <PanelRightClose size={15} />
        </button>
      </div>

      <div className="side-panel-name">{active.label}</div>

      <div className="side-panel-body">
        {tab === 'history' && <VersionHistory snapshots={snapshots} onRestore={onRestore} />}
        {tab === 'todo' && <TodoPanel todos={todos} onOpen={onOpenTodo} />}
        {tab === 'symbols' && <SymbolPanel onInsert={onInsertSymbol} />}
        {tab === 'words' && (
          <WordsPanel
            fileName={fileName}
            count={wordCount}
            sections={sections}
            projectWords={projectWords}
            onJump={onJumpToLine}
          />
        )}
        {tab === 'stats' && <StatsPanel summary={writing} />}
      </div>
    </aside>
  );
};

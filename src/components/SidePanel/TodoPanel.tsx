import React, { useState } from 'react';
import { CheckCircle2, ListTodo } from 'lucide-react';
import { TodoItem, TodoKind, TODO_LABELS } from '../../services/todoScanner';

interface TodoPanelProps {
  todos: TodoItem[];
  onOpen: (fileName: string, line: number) => void;
}

/**
 * One list of everything still unfinished, gathered from every file.
 *
 * The unresolved \cite and \ref keys sit here next to the TODO comments on
 * purpose: they are the items most likely to survive all the way into a
 * submitted PDF, because nothing about a successful compile points them out.
 */
export const TodoPanel: React.FC<TodoPanelProps> = ({ todos, onOpen }) => {
  const [filter, setFilter] = useState<TodoKind | 'all'>('all');

  const counts = todos.reduce((tally, item) => {
    tally[item.kind] = (tally[item.kind] || 0) + 1;
    return tally;
  }, {} as Record<string, number>);

  const visible = filter === 'all' ? todos : todos.filter(item => item.kind === filter);

  if (todos.length === 0) {
    return (
      <div className="panel-empty">
        <CheckCircle2 size={32} color="#6fa8cc" style={{ opacity: 0.4 }} />
        <p>Nothing outstanding.</p>
        <p className="panel-empty-hint">
          Write <code>% TODO: something</code> in a file, or use <code>\todo&#123;&#125;</code>, and it
          shows up here. Citations and references that do not resolve appear too.
        </p>
      </div>
    );
  }

  return (
    <div className="todo-panel">
      <div className="todo-filters">
        <button
          className={`todo-chip ${filter === 'all' ? 'active' : ''}`}
          onClick={() => setFilter('all')}
        >
          All {todos.length}
        </button>
        {(Object.keys(counts) as TodoKind[]).map(kind => (
          <button
            key={kind}
            className={`todo-chip ${filter === kind ? 'active' : ''}`}
            style={{ color: TODO_LABELS[kind].color }}
            onClick={() => setFilter(kind)}
          >
            {TODO_LABELS[kind].label} {counts[kind]}
          </button>
        ))}
      </div>

      <ul className="todo-list">
        {visible.map(item => (
          <li key={item.id}>
            <button className="todo-item" onClick={() => onOpen(item.fileName, item.line)}>
              <span className="todo-kind" style={{ color: TODO_LABELS[item.kind].color }}>
                <ListTodo size={12} />
                {TODO_LABELS[item.kind].label}
              </span>
              <span className="todo-text">{item.text}</span>
              <span className="todo-where">
                {item.fileName}:{item.line}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
};

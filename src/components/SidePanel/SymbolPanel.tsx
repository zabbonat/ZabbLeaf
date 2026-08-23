import React, { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { LatexSymbol, searchSymbols } from '../../services/symbolPalette';

interface SymbolPanelProps {
  onInsert: (symbol: LatexSymbol) => void;
}

/**
 * Symbols by name rather than by memory.
 *
 * Search matches the command and a set of plain words in English and Italian,
 * so "circa", "approx" and "≈" all land on \approx. Clicking inserts at the
 * caret — and adds the $...$ around it when the caret is not already in maths,
 * which is where these otherwise fail to compile.
 */
export const SymbolPanel: React.FC<SymbolPanelProps> = ({ onInsert }) => {
  const [query, setQuery] = useState('');
  const groups = useMemo(() => searchSymbols(query), [query]);
  const total = groups.reduce((sum, group) => sum + group.symbols.length, 0);

  return (
    <div className="symbol-panel">
      <div className="symbol-search">
        <Search size={14} color="#7b8593" />
        <input
          type="text"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="integral, freccia, approx, sum..."
          aria-label="Search symbols"
        />
      </div>

      {total === 0 ? (
        <div className="panel-empty">
          <p>No symbol matches "{query}".</p>
          <p className="panel-empty-hint">Try the English or the Italian word, or part of the command.</p>
        </div>
      ) : (
        groups.map(group => (
          <div key={group.name} className="symbol-group">
            <div className="symbol-group-name">{group.name}</div>
            <div className="symbol-grid">
              {group.symbols.map(symbol => (
                <button
                  key={symbol.command}
                  className="symbol-button"
                  onClick={() => onInsert(symbol)}
                  title={`${symbol.command}${symbol.math ? '  (maths)' : ''}`}
                >
                  <span className="symbol-glyph">{symbol.glyph}</span>
                  <span className="symbol-command">{symbol.command.replace(/\{.*\}/, '')}</span>
                </button>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
};

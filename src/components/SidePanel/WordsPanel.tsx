import React from 'react';
import { SectionCount, WordCount, formatCount } from '../../services/textStats';

interface WordsPanelProps {
  fileName: string;
  count: WordCount;
  sections: SectionCount[];
  projectWords: number;
  onJump: (line: number) => void;
}

/**
 * The word count broken down the way it is actually needed.
 *
 * "The paper is 8,000 words" is never the question — "is the introduction
 * still twice as long as the discussion" is. Sections are clickable, so the
 * long one can be opened straight from the number.
 */
export const WordsPanel: React.FC<WordsPanelProps> = ({
  fileName,
  count,
  sections,
  projectWords,
  onJump
}) => {
  const longest = Math.max(...sections.map(section => section.words), 1);

  return (
    <div className="words-panel">
      <div className="words-headline">
        <div className="stats-number">{formatCount(count.words)}</div>
        <div className="stats-caption">words in {fileName}</div>
      </div>

      <dl className="stats-details">
        <div>
          <dt>Whole project</dt>
          <dd>{formatCount(projectWords)} words</dd>
        </div>
        <div>
          <dt>Characters</dt>
          <dd>{formatCount(count.characters)}</dd>
        </div>
        <div>
          <dt>Maths</dt>
          <dd>
            {count.inlineMath} inline, {count.displayMath} displayed
          </dd>
        </div>
        <div>
          <dt>Floats</dt>
          <dd>
            {count.figures} figure{count.figures === 1 ? '' : 's'}, {count.tables} table
            {count.tables === 1 ? '' : 's'}
          </dd>
        </div>
      </dl>

      {sections.length > 0 && (
        <div className="words-sections">
          <div className="words-sections-title">By section</div>
          {sections.map(section => (
            <button
              key={`${section.line}-${section.title}`}
              className="words-section"
              style={{ paddingLeft: `${8 + section.level * 10}px` }}
              onClick={() => onJump(section.line)}
              title={`Go to line ${section.line}`}
            >
              <span className="words-section-name">{section.title}</span>
              <span className="words-section-count">{formatCount(section.words)}</span>
              <span
                className="words-section-bar"
                style={{ width: `${(section.words / longest) * 100}%` }}
              />
            </button>
          ))}
        </div>
      )}

      <p className="stats-note">
        Counted like texcount: the preamble, commands and displayed maths do not count, the text
        inside \textbf or \caption does, and each $...$ counts as one word.
      </p>
    </div>
  );
};

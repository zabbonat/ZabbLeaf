import React from 'react';
import { Flame, TrendingUp } from 'lucide-react';
import { WritingSummary } from '../../services/writingStats';
import { formatCount } from '../../services/textStats';

interface StatsPanelProps {
  summary: WritingSummary;
}

/**
 * What was written, and when.
 *
 * The total word count says nothing about a day spent rewriting, so the number
 * that leads here is words added today. The bars behind it are the last two
 * weeks: the point is to see the gaps, which is the part that a total hides.
 */
export const StatsPanel: React.FC<StatsPanelProps> = ({ summary }) => {
  const peak = Math.max(...summary.recent.map(day => day.added), 1);

  const weekday = (date: string) => {
    // A YYYY-MM-DD parsed as local time, not as UTC midnight.
    const [year, month, day] = date.split('-').map(Number);
    return new Date(year, month - 1, day).toLocaleDateString(undefined, { weekday: 'short' });
  };

  return (
    <div className="stats-panel">
      <div className="stats-headline">
        <div className="stats-number">{formatCount(summary.todayAdded)}</div>
        <div className="stats-caption">
          words written today
          {summary.todayNet !== summary.todayAdded && (
            <span className="stats-net">
              {summary.todayNet >= 0 ? '+' : ''}
              {formatCount(summary.todayNet)} net
            </span>
          )}
        </div>
      </div>

      <div className="stats-row">
        <div className="stats-tile">
          <Flame size={14} color={summary.streak > 0 ? '#d1a054' : '#4d5560'} />
          <div>
            <strong>{summary.streak}</strong>
            <span>day streak</span>
          </div>
        </div>
        <div className="stats-tile">
          <TrendingUp size={14} color="#6fa8cc" />
          <div>
            <strong>{formatCount(summary.weekAdded)}</strong>
            <span>this week</span>
          </div>
        </div>
      </div>

      <div className="stats-chart">
        <div className="stats-chart-label">Last {summary.recent.length} days</div>
        <div className="stats-bars">
          {summary.recent.map((day, index) => (
            <div
              key={day.date}
              className="stats-bar-slot"
              title={`${day.date}: ${formatCount(day.added)} words`}
            >
              <div
                className={`stats-bar ${index === summary.recent.length - 1 ? 'today' : ''}`}
                style={{ height: `${Math.max((day.added / peak) * 100, day.added > 0 ? 6 : 2)}%` }}
              />
              {index % 3 === 0 && <span className="stats-bar-tick">{weekday(day.date)}</span>}
            </div>
          ))}
        </div>
      </div>

      <dl className="stats-details">
        <div>
          <dt>Project total</dt>
          <dd>{formatCount(summary.total)} words</dd>
        </div>
        <div>
          <dt>Best day</dt>
          <dd>
            {summary.bestDay
              ? `${formatCount(summary.bestDay.added)} on ${summary.bestDay.date}`
              : 'Not yet'}
          </dd>
        </div>
      </dl>

      <p className="stats-note">
        Counted from the .tex files of this project only, and only while ZabbLeaf is open.
      </p>
    </div>
  );
};

/**
 * How much writing actually happened, per day and per project.
 *
 * A thesis is written in the days nobody counts. The word total alone hides
 * that: it barely moves during a rewrite and jumps when a paragraph is pasted
 * in. So two numbers are kept per day — the words added and the net change —
 * and the streak of days on which anything was written at all.
 */

const STATS_KEY = 'zabbleaf_writing_stats';
/** A year of days per project is a few kilobytes; older entries are dropped. */
const MAX_DAYS = 365;

interface DayRecord {
  /** Word total the first time we looked today. */
  first: number;
  /** Word total the last time we looked. */
  last: number;
  /** Words added, ignoring deletions, so a rewrite still counts as work. */
  added: number;
}

type ProjectRecords = Record<string, DayRecord>;
type AllRecords = Record<string, ProjectRecords>;

export interface DayStat {
  date: string;
  added: number;
  net: number;
  total: number;
}

export interface WritingSummary {
  todayAdded: number;
  todayNet: number;
  total: number;
  /** Consecutive days ending today (or yesterday) with something written. */
  streak: number;
  /** Newest last, for the sparkline. */
  recent: DayStat[];
  bestDay: DayStat | null;
  weekAdded: number;
}

/** Local date, not UTC: a day ends when the user's day ends. */
export function todayKey(when: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
}

function dayKeyOffset(days: number): string {
  const when = new Date();
  when.setDate(when.getDate() - days);
  return todayKey(when);
}

class WritingStatsService {
  private records: AllRecords = {};

  constructor() {
    try {
      this.records = JSON.parse(localStorage.getItem(STATS_KEY) || '{}');
    } catch {
      this.records = {};
    }
  }

  private persist() {
    try {
      localStorage.setItem(STATS_KEY, JSON.stringify(this.records));
    } catch {
      // A full quota should never stop someone from writing.
    }
  }

  /**
   * Records the current word total. Safe to call often — the first call of the
   * day sets the baseline, later ones only move the counters.
   */
  record(projectId: string, words: number) {
    if (!projectId || !Number.isFinite(words)) return;

    const project = this.records[projectId] || (this.records[projectId] = {});
    const key = todayKey();
    const day = project[key];

    if (!day) {
      // The baseline is where the day started, so opening a finished document
      // does not read as 8,000 words written this morning.
      project[key] = { first: words, last: words, added: 0 };
    } else {
      if (words > day.last) day.added += words - day.last;
      day.last = words;
    }

    const keys = Object.keys(project).sort();
    if (keys.length > MAX_DAYS) {
      for (const old of keys.slice(0, keys.length - MAX_DAYS)) delete project[old];
    }
    this.persist();
  }

  private day(projectId: string, key: string): DayStat {
    const record = this.records[projectId]?.[key];
    return {
      date: key,
      added: record?.added || 0,
      net: record ? record.last - record.first : 0,
      total: record?.last || 0
    };
  }

  summary(projectId: string, days = 14): WritingSummary {
    const recent: DayStat[] = [];
    for (let offset = days - 1; offset >= 0; offset -= 1) {
      recent.push(this.day(projectId, dayKeyOffset(offset)));
    }

    const today = this.day(projectId, todayKey());
    const project = this.records[projectId] || {};
    const known = Object.keys(project).sort();
    const total = known.length ? project[known[known.length - 1]].last : 0;

    // A day that is still young should not break a streak, so counting starts
    // at today when something was written and at yesterday otherwise.
    let streak = 0;
    let offset = today.added > 0 ? 0 : 1;
    while (offset < MAX_DAYS) {
      const record = project[dayKeyOffset(offset)];
      if (!record || record.added <= 0) break;
      streak += 1;
      offset += 1;
    }

    const bestDay = Object.keys(project)
      .map(key => this.day(projectId, key))
      .sort((a, b) => b.added - a.added)[0];

    return {
      todayAdded: today.added,
      todayNet: today.net,
      total,
      streak,
      recent,
      bestDay: bestDay && bestDay.added > 0 ? bestDay : null,
      weekAdded: recent.slice(-7).reduce((sum, day) => sum + day.added, 0)
    };
  }

  clear(projectId: string) {
    delete this.records[projectId];
    this.persist();
  }
}

export const writingStats = new WritingStatsService();

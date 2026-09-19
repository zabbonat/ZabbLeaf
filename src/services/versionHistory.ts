/**
 * Version History Service
 * Stores local snapshots of file content for rollback and review.
 */

export interface VersionSnapshot {
  id: string;
  timestamp: number;
  fileName: string;
  content: string;
  message: string;
  projectId: string;
}

const HISTORY_KEY = 'zabbleaf_version_history';
const MAX_VERSIONS = 50;

/**
 * Fifty snapshots of a 200 KB chapter stringify to over 10 MB, which is twice
 * WebKit's per-origin quota — and blowing that quota does not just lose history,
 * it makes every other `zabbleaf_*` write on the origin fail too.
 */
const MAX_HISTORY_BYTES = 1_500_000;

/**
 * Corrupt or hand-edited storage reaches us as arbitrary JSON. A stored `null`
 * used to make `history.push` throw, and a stored `[null]` throws on the first
 * `s.projectId` in any of the filters below.
 */
function isSnapshot(value: unknown): value is VersionSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<VersionSnapshot>;
  return typeof candidate.id === 'string' && typeof candidate.content === 'string';
}

export class VersionHistoryService {
  private history: VersionSnapshot[] = [];

  constructor() {
    this.loadHistory();
  }

  private loadHistory() {
    try {
      const stored = localStorage.getItem(HISTORY_KEY);
      if (stored) {
        const parsed: unknown = JSON.parse(stored);
        this.history = Array.isArray(parsed) ? parsed.filter(isSnapshot) : [];
      }
    } catch {
      this.history = [];
    }
  }

  private saveHistory() {
    // A snapshot is taken on every successful compile and auto-compile fires two
    // seconds after typing stops, so an afternoon's work pushed the origin past
    // WebKit's ~5 MB quota. The unguarded setItem then threw out of saveSnapshot
    // and rejected handleCompile — which is why the success toast quietly
    // stopped appearing — and with the quota gone, clicking a project on the
    // home screen did nothing because overleafApi.addProject threw as well.
    // Evict oldest-first until the payload both fits the budget and is accepted.
    while (this.history.length > 0) {
      if (this.history.length > MAX_VERSIONS) {
        this.history = this.history.slice(-MAX_VERSIONS);
      }

      const payload = JSON.stringify(this.history);
      if (payload.length <= MAX_HISTORY_BYTES) {
        try {
          localStorage.setItem(HISTORY_KEY, payload);
          return;
        } catch {
          // Something else on the origin is holding the quota; drop the oldest
          // snapshot and retry rather than losing every version we have.
        }
      }

      this.history = this.history.slice(1);
    }

    try {
      localStorage.removeItem(HISTORY_KEY);
    } catch {
      // Nothing left to store and nowhere to store it. The editor keeps working.
    }
  }

  /**
   * Saves a snapshot of the current file content.
   *
   * The returned snapshot is not always added to the history: a file too large
   * to ever fit the budget is refused, and text identical to this file's newest
   * snapshot returns that one instead of recording a duplicate.
   */
  saveSnapshot(projectId: string, fileName: string, content: string, message?: string): VersionSnapshot {
    const snapshot: VersionSnapshot = {
      id: `v-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      fileName,
      content,
      message: message || `Edited ${fileName}`,
      projectId
    };

    // One chapter larger than the whole budget would send saveHistory's eviction
    // loop through every other snapshot and still not fit, so a single big file
    // would wipe the history it could never join.
    if (JSON.stringify(snapshot).length > MAX_HISTORY_BYTES) {
      return snapshot;
    }

    // Auto-compile fires whenever the timer expires, including on a document
    // nobody changed, so without this the budget fills with identical copies and
    // evicts the versions someone might actually want back.
    for (let index = this.history.length - 1; index >= 0; index -= 1) {
      const prior = this.history[index];
      if (prior.projectId !== projectId || prior.fileName !== fileName) continue;
      if (prior.content === content) return prior;
      break;
    }

    this.history.push(snapshot);
    this.saveHistory();
    return snapshot;
  }

  /**
   * Gets all snapshots for a project, sorted newest first.
   */
  getProjectHistory(projectId: string): VersionSnapshot[] {
    return this.history
      .filter(s => s.projectId === projectId)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Gets all snapshots for a specific file in a project.
   */
  getFileHistory(projectId: string, fileName: string): VersionSnapshot[] {
    return this.history
      .filter(s => s.projectId === projectId && s.fileName === fileName)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Returns the content of a specific snapshot.
   */
  getSnapshot(snapshotId: string): VersionSnapshot | undefined {
    return this.history.find(s => s.id === snapshotId);
  }

  /**
   * Clears all history for a project.
   */
  clearProjectHistory(projectId: string) {
    this.history = this.history.filter(s => s.projectId !== projectId);
    this.saveHistory();
  }

  /**
   * Returns formatted time ago string.
   */
  static timeAgo(timestamp: number): string {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }
}

export const versionHistory = new VersionHistoryService();

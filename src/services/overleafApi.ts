/**
 * Overleaf API Service
 * Manages the local project list. Real file sync is handled by gitSync.ts.
 */

export interface OverleafProject {
  id: string;
  name: string;
  lastUpdated: string;
  owner: string;
  isLocal: boolean;
  syncStatus: 'synced' | 'local-changes' | 'online-only' | 'offline-only';
}

const LOCAL_PROJECTS_KEY = 'zabbleaf_local_projects';

/** The stand-in name given to a project added from a URL, before anything better is known. */
export function placeholderName(projectId: string): string {
  return `Project ${projectId.substring(0, 6)}…`;
}

/** True while the name is still the generated one, i.e. safe to replace. */
export function isPlaceholderName(name: string): boolean {
  return /^Project [A-Za-z0-9]{1,8}…?\.{0,3}$/.test(name.trim());
}

/**
 * Storage can hand back anything that survived a crash or an older build. A
 * stored `null` made every method below throw on `localProjects.find`, and a
 * stored `[null]` throws on the first `p.id`.
 */
function isProject(value: unknown): value is OverleafProject {
  if (typeof value !== 'object' || value === null) return false;
  return typeof (value as Partial<OverleafProject>).id === 'string';
}

export class OverleafApiService {
  private localProjects: OverleafProject[] = [];

  constructor() {
    this.loadLocalProjects();
  }

  private loadLocalProjects() {
    try {
      const stored = localStorage.getItem(LOCAL_PROJECTS_KEY);
      if (stored) {
        const parsed: unknown = JSON.parse(stored);
        this.localProjects = Array.isArray(parsed) ? parsed.filter(isProject) : [];
      }
    } catch {
      this.localProjects = [];
    }
  }

  private saveLocalProjects() {
    try {
      localStorage.setItem(LOCAL_PROJECTS_KEY, JSON.stringify(this.localProjects));
    } catch {
      // A full quota threw out of addProject before App.tsx ever reached
      // setFiles, so clicking a project on the home screen did nothing at all
      // and said nothing either. A list that cannot be remembered across
      // restarts must still let this session open the project.
    }
  }

  /**
   * Returns all locally tracked projects.
   */
  async getProjects(): Promise<OverleafProject[]> {
    return [...this.localProjects];
  }

  /**
   * Adds a project to the local tracking list.
   */
  addProject(project: OverleafProject) {
    // Avoid duplicates
    if (!this.localProjects.find(p => p.id === project.id)) {
      this.localProjects.push(project);
      this.saveLocalProjects();
    }
  }

  /**
   * Updates a project's sync status and metadata.
   */
  updateProject(projectId: string, updates: Partial<OverleafProject>) {
    this.localProjects = this.localProjects.map(p =>
      p.id === projectId ? { ...p, ...updates } : p
    );
    this.saveLocalProjects();
  }

  /**
   * Removes a project from local tracking.
   */
  removeProject(projectId: string) {
    this.localProjects = this.localProjects.filter(p => p.id !== projectId);
    this.saveLocalProjects();
  }

  /**
   * Creates a new local project.
   */
  createLocalProject(name: string): OverleafProject {
    const project: OverleafProject = {
      id: `local-${Date.now()}`,
      name,
      lastUpdated: new Date().toISOString(),
      owner: 'Me',
      isLocal: true,
      syncStatus: 'offline-only'
    };
    this.localProjects.push(project);
    this.saveLocalProjects();
    return project;
  }
}

export const overleafApi = new OverleafApiService();

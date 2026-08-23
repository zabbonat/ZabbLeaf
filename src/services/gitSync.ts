import { invoke } from '@tauri-apps/api/tauri';

export interface OverleafCredentials {
  email: string;
  gitToken: string;
}

export interface ProjectFile {
  name: string;
  content: string;
}

export interface SyncResult {
  success: boolean;
  message: string;
}

interface GitOutcome {
  success: boolean;
  message: string;
  code: number;
  stdout: string;
  stderr: string;
}

const CREDENTIALS_KEY = 'zabbleaf_git_credentials';

/**
 * GitSyncService — thin wrapper over the Rust backend.
 *
 * All git and filesystem work happens in `src-tauri/src/main.rs`; this class
 * only holds credentials and turns backend errors into messages the UI can show.
 * Projects live in ~/.zabbleaf/projects/<projectId>/.
 */
export class GitSyncService {
  private credentials: OverleafCredentials | null = null;
  private projectsRoot = '';
  private gitVersion = '';

  /** Must be called once before any operation. */
  async init(): Promise<void> {
    this.loadCredentials();

    try {
      this.projectsRoot = await invoke<string>('zl_projects_root');
      console.log(`[GitSync] Projects stored at: ${this.projectsRoot}`);
    } catch (err) {
      console.error('[GitSync] Could not prepare the projects directory:', err);
    }

    try {
      this.gitVersion = await invoke<string>('zl_git_available');
      console.log(`[GitSync] ${this.gitVersion}`);
    } catch (err) {
      console.error('[GitSync] git is not available:', err);
    }
  }

  /** Empty when git could not be found on this machine. */
  getGitVersion(): string {
    return this.gitVersion;
  }

  /**
   * Installs git. Unlike a TeX engine this one is not optional: without it
   * ZabbLeaf cannot reach Overleaf at all.
   */
  async installGit(): Promise<{ success: boolean; message: string; log: string }> {
    try {
      const result = await invoke<{ success: boolean; message: string; log: string }>('zl_install_git');
      if (result.success) {
        try {
          this.gitVersion = await invoke<string>('zl_git_available');
        } catch {
          // Installed but still not reachable; the caller reports the message.
        }
      }
      return result;
    } catch (err: any) {
      const message = String(err?.message || err);
      return { success: false, message, log: message };
    }
  }

  getProjectsRoot(): string {
    return this.projectsRoot;
  }

  private loadCredentials() {
    try {
      const stored = localStorage.getItem(CREDENTIALS_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as OverleafCredentials;
        if (parsed?.gitToken) {
          this.credentials = parsed;
          console.log(`[GitSync] Restored credentials for ${parsed.email}`);
        }
      }
    } catch {
      // Corrupt entry — the user simply re-enters the token.
    }
  }

  setCredentials(creds: OverleafCredentials) {
    this.credentials = creds;
    try {
      localStorage.setItem(CREDENTIALS_KEY, JSON.stringify(creds));
    } catch (err) {
      console.error('[GitSync] Could not persist credentials:', err);
    }
    console.log(`[GitSync] Credentials set for ${creds.email}`);
  }

  getCredentials(): OverleafCredentials | null {
    return this.credentials;
  }

  clearCredentials() {
    this.credentials = null;
    localStorage.removeItem(CREDENTIALS_KEY);
  }

  /** Accepts a bare id or any Overleaf URL and returns the git remote. */
  getOverleafGitUrl(projectId: string): string {
    return `https://git.overleaf.com/${extractProjectId(projectId)}`;
  }

  /** True once the project has actually been cloned to disk. */
  async hasProject(projectId: string): Promise<boolean> {
    try {
      return await invoke<boolean>('zl_project_exists', { projectId });
    } catch (err) {
      console.error('[GitSync] project_exists failed:', err);
      return false;
    }
  }

  /** Clones the project into ~/.zabbleaf/projects/<projectId>. */
  async cloneProject(projectId: string): Promise<SyncResult> {
    if (!this.credentials?.gitToken) {
      return { success: false, message: 'Connect your Overleaf account first.' };
    }
    if (!navigator.onLine) {
      return { success: false, message: 'You are offline — connect to the internet to download this project.' };
    }

    const gitUrl = this.getOverleafGitUrl(projectId);
    console.log(`[GitSync] Cloning ${gitUrl}`);

    try {
      const outcome = await invoke<GitOutcome>('zl_clone_project', {
        projectId,
        gitUrl,
        token: this.credentials.gitToken
      });
      console.log(`[GitSync] Clone finished: success=${outcome.success} code=${outcome.code}`);
      if (!outcome.success) console.error(`[GitSync] ${outcome.stderr}`);
      return { success: outcome.success, message: outcome.message };
    } catch (err: any) {
      console.error('[GitSync] Clone failed:', err);
      return { success: false, message: String(err?.message || err) };
    }
  }

  /** Commits local edits, pulls with rebase, then pushes. */
  async syncProject(projectId: string): Promise<SyncResult> {
    if (!this.credentials?.gitToken) {
      return { success: false, message: 'Connect your Overleaf account first.' };
    }
    if (!navigator.onLine) {
      return { success: false, message: 'Device is offline. Changes are saved locally.' };
    }

    try {
      const outcome = await invoke<GitOutcome>('zl_sync_project', {
        projectId,
        gitUrl: this.getOverleafGitUrl(projectId),
        token: this.credentials.gitToken,
        email: this.credentials.email,
        message: `ZabbLeaf offline sync: ${new Date().toLocaleString()}`
      });
      if (!outcome.success) console.error(`[GitSync] ${outcome.stderr}`);
      return { success: outcome.success, message: outcome.message };
    } catch (err: any) {
      console.error('[GitSync] Sync failed:', err);
      return { success: false, message: String(err?.message || err) };
    }
  }

  /** What a sync would publish: the changed files and a unified diff. */
  async getChanges(projectId: string): Promise<{ files: string[]; diff: string }> {
    try {
      return await invoke<{ files: string[]; diff: string }>('zl_project_changes', { projectId });
    } catch (err) {
      console.error('[GitSync] Could not read changes:', err);
      return { files: [], diff: '' };
    }
  }

  /** Reads every text file in the project, recursively. */
  async readProjectFiles(projectId: string): Promise<ProjectFile[]> {
    try {
      const files = await invoke<ProjectFile[]>('zl_read_project_files', { projectId });
      console.log(`[GitSync] Read ${files.length} files for ${projectId}`);
      return files;
    } catch (err) {
      console.error('[GitSync] readProjectFiles failed:', err);
      return [];
    }
  }

  async writeFile(projectId: string, fileName: string, content: string): Promise<void> {
    try {
      await invoke('zl_write_project_file', { projectId, relPath: fileName, content });
    } catch (err) {
      console.error(`[GitSync] Could not write ${fileName}:`, err);
    }
  }

  /** Removes one file from disk, so git sees the deletion on the next sync. */
  async deleteFile(projectId: string, fileName: string): Promise<void> {
    try {
      await invoke('zl_delete_project_file', { projectId, relPath: fileName });
    } catch (err) {
      console.error(`[GitSync] Could not delete ${fileName}:`, err);
    }
  }

  /** Removes the local copy so the next open re-downloads it. */
  async deleteProject(projectId: string): Promise<void> {
    try {
      await invoke('zl_delete_project', { projectId });
    } catch (err) {
      console.error('[GitSync] Could not delete the local copy:', err);
    }
  }
}

/**
 * Pulls the project id out of anything the user is likely to paste:
 * https://www.overleaf.com/project/<id>, .../project/<id>/, /read/<token>,
 * https://git.overleaf.com/<id>, or the bare id.
 */
export function extractProjectId(input: string): string {
  const raw = (input || '').trim();
  if (!raw) return '';

  const withoutQuery = raw.split(/[?#]/)[0].replace(/\/+$/, '');

  const match = withoutQuery.match(/(?:overleaf\.com\/(?:project\/|read\/)?)([A-Za-z0-9_-]+)/i);
  if (match) return match[1];

  // Not a URL — assume it is already an id.
  return withoutQuery.split('/').filter(Boolean).pop() || '';
}

/**
 * Overleaf project ids are 24 hex characters. Checking the shape keeps typos
 * and stray text from becoming a doomed clone against git.overleaf.com — the
 * length is left loose in case Overleaf ever widens the format.
 */
export function isValidProjectId(id: string): boolean {
  return /^[A-Za-z0-9_-]{16,}$/.test(id);
}

export const gitSyncEngine = new GitSyncService();

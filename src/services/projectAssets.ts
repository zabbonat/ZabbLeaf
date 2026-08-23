/**
 * Figures, which until now ZabbLeaf could not see at all.
 *
 * The editor only ever loaded text files, so adding an image meant leaving the
 * app, copying the file into ~/.zabbleaf/projects/<id>/ with the file manager
 * and typing the path by hand. Pasting a screenshot — the single most common
 * way a figure enters a document — was impossible.
 *
 * The bytes go through the Rust side: the webview has no business writing into
 * the repository, and a base64 round trip is the only way to hand it a Blob.
 */

import { invoke } from '@tauri-apps/api/tauri';

export interface ProjectAsset {
  name: string;
  bytes: number;
}

/** Where pasted images land unless the document says otherwise. */
export const FIGURES_DIR = 'figures';

const EXTENSION_FOR_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/tiff': 'tif',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf'
};

export const ASSET_EXTENSIONS = [
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tif', 'tiff', 'svg', 'eps', 'pdf'
];

export function isAssetName(name: string): boolean {
  const extension = name.split('.').pop()?.toLowerCase() || '';
  return ASSET_EXTENSIONS.includes(extension);
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    // The result is a data: URL; only the part after the comma is the payload.
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('That image could not be read.'));
    reader.readAsDataURL(blob);
  });
}

/** A name that says where it came from, and sorts by when. */
function pastedName(type: string): string {
  const extension = EXTENSION_FOR_TYPE[type] || 'png';
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${FIGURES_DIR}/pasted-${stamp}.${extension}`;
}

export class ProjectAssetService {
  /** Every image in the project, which the file tree lists on its own. */
  async list(projectId: string): Promise<ProjectAsset[]> {
    try {
      return await invoke<ProjectAsset[]>('zl_list_project_assets', { projectId });
    } catch (err) {
      console.error('[Assets] Listing failed:', err);
      return [];
    }
  }

  /**
   * Stores a pasted or dropped image. Returns the path it was actually given,
   * which is not always the one asked for: an existing figure is never
   * overwritten, it gets a -1 suffix instead.
   */
  async save(projectId: string, blob: Blob, name?: string): Promise<string> {
    const base64Data = await toBase64(blob);
    if (!base64Data) throw new Error('That image is empty.');

    return invoke<string>('zl_write_project_asset', {
      projectId,
      relPath: name || pastedName(blob.type),
      base64Data
    });
  }

  /** Copies a file dragged in from the desktop, which arrives as a path. */
  async importFromPath(projectId: string, sourcePath: string): Promise<string> {
    return invoke<string>('zl_import_project_asset', {
      projectId,
      sourcePath,
      destDir: FIGURES_DIR
    });
  }

  /** Reads one back as a data URL, so the file tree can show a thumbnail. */
  async readDataUrl(projectId: string, relPath: string): Promise<string | null> {
    try {
      const base64Data = await invoke<string>('zl_read_project_asset', { projectId, relPath });
      const extension = relPath.split('.').pop()?.toLowerCase() || 'png';
      const type =
        Object.entries(EXTENSION_FOR_TYPE).find(([, ext]) => ext === extension)?.[0] ||
        'image/png';
      return `data:${type};base64,${base64Data}`;
    } catch (err) {
      console.error('[Assets] Preview failed:', err);
      return null;
    }
  }
}

/** fig:experiment-setup out of figures/experiment-setup.png. */
export function labelFor(path: string): string {
  const stem = path.split('/').pop()?.replace(/\.[^.]+$/, '') || 'figure';
  return `fig:${stem.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
}

/**
 * The block that goes into the document. Written out in full rather than as a
 * bare \includegraphics: a figure without a caption and a label is a figure
 * that cannot be referred to, and adding them later never happens.
 */
export function figureBlock(path: string): string {
  return [
    '\\begin{figure}[htbp]',
    '  \\centering',
    `  \\includegraphics[width=0.8\\textwidth]{${path}}`,
    '  \\caption{Caption}',
    `  \\label{${labelFor(path)}}`,
    '\\end{figure}',
    ''
  ].join('\n');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const projectAssets = new ProjectAssetService();

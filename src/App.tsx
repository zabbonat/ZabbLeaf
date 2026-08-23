import React, { useState, useEffect, useCallback, useRef } from 'react';
import { SyncToolbar, CompilerEngine, CompilerOption } from './components/SyncToolbar/SyncToolbar';
import { FileTree, FileNode } from './components/FileTree/FileTree';
import { LaTeXEditor } from './components/Editor/LaTeXEditor';
import { PDFPreview } from './components/PDFViewer/PDFPreview';
import { AuthModal } from './components/AuthModal/AuthModal';
import { ProjectList } from './components/ProjectList/ProjectList';
import { ChangesModal } from './components/ChangesModal/ChangesModal';
import { LaTeXSetupBanner, LaTeXReadyNotice, GitMissingBanner } from './components/LaTeXSetup/LaTeXSetupBanner';
import { VersionHistory } from './components/VersionHistory/VersionHistory';
import { overleafAuth } from './services/overleafAuth';
import { OverleafProject, overleafApi, isPlaceholderName } from './services/overleafApi';
import { latexCompiler, deriveProjectName } from './services/latexCompiler';
import {
  collectCitations,
  collectLabels,
  findRootDocuments,
  defaultRootDocument
} from './services/latexSymbols';
import { overleafCompiler } from './services/overleafCompiler';
import { localTeXCompiler, TeXEngine, DetectedEngine } from './services/localTeXCompiler';
import { versionHistory, VersionSnapshot } from './services/versionHistory';
import { gitSyncEngine, extractProjectId, isValidProjectId } from './services/gitSync';
import './styles/main.css';

type AppView = 'home' | 'editor';

const DEFAULT_LATEX = `\\documentclass{article}
\\usepackage[utf8]{inputenc}
\\title{ZabbLeaf: Ultra-Lightweight Offline Overleaf IDE}
\\author{Diletta Abbonato (Zabbonat)}
\\date{\\today}

\\begin{document}

\\maketitle

\\begin{abstract}
ZabbLeaf is a modern, open-source desktop application designed for offline LaTeX editing with seamless Overleaf Git synchronization. It compiles documents locally and synchronizes with your Overleaf projects when internet is available.
\\end{abstract}

\\section{Introduction}
Working on scientific papers often requires working on the go without reliable internet access. ZabbLeaf allows researchers to edit LaTeX documents offline using a rich Monaco editor and live PDF preview.

\\subsection{Motivation}
Traditional cloud-based editors like Overleaf require constant internet access. ZabbLeaf bridges this gap by providing a fully functional offline environment.

\\section{Offline Git Sync Architecture}
When connectivity is restored, ZabbLeaf pushes local commits directly to Overleaf Git remotes using conflict-resilient operational transformation logic.

\\section{Conclusion}
ZabbLeaf provides a seamless bridge between offline editing and online collaboration through Overleaf.

\\end{document}`;

export const App: React.FC = () => {
  const [currentView, setCurrentView] = useState<AppView>('home');
  const [isOnline, setIsOnline] = useState<boolean>(navigator.onLine);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [isCompiling, setIsCompiling] = useState<boolean>(false);
  const [isAuthOpen, setIsAuthOpen] = useState<boolean>(false);
  const [isLoggedIn, setIsLoggedIn] = useState<boolean>(overleafAuth.isLoggedIn());
  // Project the user asked to open before connecting an account; opened again
  // as soon as credentials are saved.
  const [pendingProject, setPendingProject] = useState<OverleafProject | null>(null);

  const [currentProject, setCurrentProject] = useState<OverleafProject | null>(null);
  const [files, setFiles] = useState<FileNode[]>([
    { id: '1', name: 'main.tex', type: 'file', content: DEFAULT_LATEX },
    { id: '2', name: 'references.bib', type: 'file', content: '@article{zabbleaf2026,\n  author={Abbonato, Diletta},\n  title={ZabbLeaf Desktop IDE},\n  year={2026}\n}' }
  ]);

  const [activeFileId, setActiveFileId] = useState<string>('1');
  const [folderPath, setFolderPath] = useState<string>('');
  const [notification, setNotification] = useState<string | null>(null);
  const [compiledPdfUrl, setCompiledPdfUrl] = useState<string | null>(null);
  const [compiledIsPdf, setCompiledIsPdf] = useState<boolean>(false);
  const [compileLog, setCompileLog] = useState<string>('');
  const [snapshots, setSnapshots] = useState<VersionSnapshot[]>([]);

  // Compiler Engines State
  const [selectedCompiler, setSelectedCompiler] = useState<CompilerEngine>('html-preview');
  const [detectedLocalEngines, setDetectedLocalEngines] = useState<DetectedEngine[]>([]);
  const [isInstallingTex, setIsInstallingTex] = useState<boolean>(false);
  const [isGitMissing, setIsGitMissing] = useState<boolean>(false);
  const [isInstallingGit, setIsInstallingGit] = useState<boolean>(false);
  const [texJustInstalled, setTexJustInstalled] = useState<string>('');
  // Which file gets compiled. Not necessarily main.tex, and not necessarily the
  // one being edited: a chapter fragment has no preamble of its own.
  const [chosenRoot, setChosenRoot] = useState<string>('');
  const [changes, setChanges] = useState<{ files: string[]; diff: string } | null>(null);
  const [revealLine, setRevealLine] = useState<{ line: number; nonce: number } | null>(null);
  const [autoCompile, setAutoCompile] = useState<boolean>(
    () => localStorage.getItem('zabbleaf_auto_compile') !== '0'
  );
  const [texSetupDismissed, setTexSetupDismissed] = useState<boolean>(
    () => localStorage.getItem('zabbleaf_tex_setup_dismissed') === '1'
  );

  // The online handler is registered once at mount, so it must read the current
  // project through refs rather than a value captured back then.
  const currentProjectRef = useRef<OverleafProject | null>(null);
  currentProjectRef.current = currentProject;
  const isSyncingRef = useRef(false);
  isSyncingRef.current = isSyncing;

  const activeFile = files.find(f => f.id === activeFileId) || files[0];
  const projectFiles = files.map(f => ({ name: f.name, content: f.content || '' }));
  const citations = collectCitations(projectFiles);
  const labels = collectLabels(projectFiles);
  const rootDocuments = findRootDocuments(projectFiles);
  const projectId = currentProject?.id || 'local-default';
  const rootDocument =
    chosenRoot && files.some(f => f.name === chosenRoot)
      ? chosenRoot
      : defaultRootDocument(rootDocuments, activeFile?.name || '');

  // Initialize git sync engine and detect local TeX installations on startup
  useEffect(() => {
    gitSyncEngine.init().then(() => {
      // Credentials live in the sync engine, so the header must reflect what it
      // actually restored rather than a stale "logged in" flag.
      setIsLoggedIn(!!gitSyncEngine.getCredentials()?.gitToken);
      setIsGitMissing(!gitSyncEngine.getGitVersion());
    }).catch(console.error);

    localTeXCompiler.detectEngines().then(applyDetectedEngines);
  }, []);

  const applyDetectedEngines = (engines: DetectedEngine[]) => {
    setDetectedLocalEngines(engines);
    if (engines.length > 0) {
      const pdflatex = engines.find(e => e.engine === 'pdflatex');
      setSelectedCompiler(pdflatex ? 'pdflatex' : engines[0].engine);
    }
  };

  const handleInstallTeX = async () => {
    setIsInstallingTex(true);
    setNotification('⬇️ Installing LaTeX — this takes a few minutes...');

    const result = await localTeXCompiler.install();
    const engines = localTeXCompiler.getDetectedEngines();
    applyDetectedEngines(engines);
    setIsInstallingTex(false);

    if (result.success && engines.length > 0) {
      setTexJustInstalled(engines[0].version);
      showNotification(`✅ ${result.message}`);
    } else {
      setCompileLog(`${result.message}\n\n${result.log}`);
      showNotification(`❌ ${result.message}`);
    }
  };

  const handleInstallGit = async () => {
    setIsInstallingGit(true);
    setNotification('⬇️ Installing git...');

    const result = await gitSyncEngine.installGit();
    setIsInstallingGit(false);
    setIsGitMissing(!gitSyncEngine.getGitVersion());

    showNotification(result.success ? `✅ ${result.message}` : `❌ ${result.message}`);
    if (!result.success) setCompileLog(`${result.message}

${result.log}`);
  };

  const handleChooseRoot = (fileName: string) => {
    setChosenRoot(fileName);
    localStorage.setItem(`zabbleaf_root_${projectId}`, fileName);
  };

  const handleDismissTexSetup = () => {
    setTexSetupDismissed(true);
    localStorage.setItem('zabbleaf_tex_setup_dismissed', '1');
  };

  const compilerOptions: CompilerOption[] = [
    {
      id: 'html-preview',
      label: 'Quick Text Preview',
      description: 'Rough offline text preview, not a real PDF. No TeX required.',
      available: true
    },
    {
      id: 'overleaf-cloud',
      label: 'Push to Overleaf & open',
      description: 'Pushes your changes, then opens the project in your browser where Overleaf compiles it.',
      available: overleafCompiler.isAvailable()
    },
    {
      id: 'pdflatex',
      label: `pdflatex ${detectedLocalEngines.some(e => e.engine === 'pdflatex') ? '(Local)' : '(Not Installed)'}`,
      description: 'Standard TeX Live / MiKTeX pdflatex compiler.',
      available: detectedLocalEngines.some(e => e.engine === 'pdflatex')
    },
    {
      id: 'xelatex',
      label: `xelatex ${detectedLocalEngines.some(e => e.engine === 'xelatex') ? '(Local)' : '(Not Installed)'}`,
      description: 'XeLaTeX engine for custom TTF/OTF fonts.',
      available: detectedLocalEngines.some(e => e.engine === 'xelatex')
    },
    {
      id: 'lualatex',
      label: `lualatex ${detectedLocalEngines.some(e => e.engine === 'lualatex') ? '(Local)' : '(Not Installed)'}`,
      description: 'LuaLaTeX engine with modern Lua scripting.',
      available: detectedLocalEngines.some(e => e.engine === 'lualatex')
    }
  ];

  // Monitor network connectivity
  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      showNotification('📶 Back online.');
      // The whole point of the app: pending work goes up on its own as soon as
      // there is a connection, without waiting for anyone to press a button.
      void syncPendingOnReconnect();
    };
    const handleOffline = () => {
      setIsOnline(false);
      showNotification('⚡ Offline mode active. Edits are saved locally.');
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Load version history when project changes
  useEffect(() => {
    setSnapshots(versionHistory.getProjectHistory(projectId));
  }, [projectId]);

  // Without clearing the previous timer, an earlier notification's timeout wipes
  // a newer message off the screen part-way through — which is how a failed sync
  // right after another action ends up showing nothing at all.
  const notificationTimer = useRef<number | undefined>(undefined);

  const showNotification = (msg: string) => {
    setNotification(msg);
    window.clearTimeout(notificationTimer.current);
    notificationTimer.current = window.setTimeout(() => setNotification(null), 4500);
  };

  // Editing fires on every keystroke; writing through to disk that often would
  // stutter the editor, so coalesce writes per file.
  const saveTimers = useRef<Record<string, number>>({});

  const queueSave = (project: string, fileName: string, content: string) => {
    const key = `${project}:${fileName}`;
    window.clearTimeout(saveTimers.current[key]);
    saveTimers.current[key] = window.setTimeout(() => {
      delete saveTimers.current[key];
      gitSyncEngine.writeFile(project, fileName, content).catch(console.error);
    }, 400);
  };

  const handleCompile = useCallback(async () => {
    setIsCompiling(true);
    const content = activeFile?.content || '';

    if (selectedCompiler === 'html-preview') {
      const result = await latexCompiler.compile(content);
      setIsCompiling(false);

      if (result.success && result.pdfUrl) {
        setCompiledPdfUrl(result.pdfUrl);
        setCompiledIsPdf(false);
        setCompileLog(result.log);
        versionHistory.saveSnapshot(projectId, activeFile?.name || 'main.tex', content, `Compiled ${activeFile?.name}`);
        setSnapshots(versionHistory.getProjectHistory(projectId));
        showNotification(`✅ Quick Preview generated in ${result.compileTimeMs.toFixed(0)}ms`);
      } else {
        setCompileLog(result.log);
        showNotification('❌ Compilation failed. Check the log output.');
      }
    } else if (selectedCompiler === 'overleaf-cloud') {
      if (!currentProject) {
        setIsCompiling(false);
        showNotification('⚠️ Open a project to compile with Overleaf Cloud.');
        return;
      }
      // This pushes to the real Overleaf project, so never do it silently.
      const confirmed = window.confirm(
        `Compiling on Overleaf pushes your local changes to "${currentProject.name}" ` +
        `and opens the project in your browser, where Overleaf compiles it.\n\n` +
        `Overleaf blocks embedding, so the PDF cannot appear inside ZabbLeaf.\n\nPush and open now?`
      );
      if (!confirmed) {
        setIsCompiling(false);
        return;
      }

      const fileList = files.map(f => ({ name: f.name, content: f.content || '' }));
      const result = await overleafCompiler.compile(currentProject.id, fileList);
      setIsCompiling(false);
      setCompileLog(result.log);
      showNotification(
        result.success
          ? '🌐 Pushed to Overleaf and opened in your browser.'
          : `❌ ${result.errors[0] || 'Overleaf compilation failed.'}`
      );
    } else {
      // Local TeX compilation (pdflatex, xelatex, lualatex). The engine reads
      // files from disk, so flush the editor first — and compile the whole
      // project directory so \input, .bib and class files resolve.
      const fileName = rootDocument;
      for (const f of files) {
        await gitSyncEngine.writeFile(projectId, f.name, f.content || '');
      }

      const result = await localTeXCompiler.compile(projectId, fileName, selectedCompiler as TeXEngine);
      setIsCompiling(false);
      setCompileLog(result.log);

      if (result.success && result.pdfUrl) {
        setCompiledPdfUrl(result.pdfUrl);
        setCompiledIsPdf(true);
        versionHistory.saveSnapshot(projectId, fileName, content, `Compiled with ${selectedCompiler}`);
        setSnapshots(versionHistory.getProjectHistory(projectId));
        showNotification(`✅ Compiled ${fileName} with ${selectedCompiler}.`);
      } else {
        showNotification(`❌ ${result.errors[0] || `${selectedCompiler} compilation failed.`}`);
      }
    }
  }, [activeFile, currentProject, files, projectId, selectedCompiler, rootDocument]);

  /**
   * Attaches a locally-created project to an existing Overleaf project.
   *
   * Overleaf's Git interface cannot create projects — it only accepts pushes to
   * ones that already exist — so the user makes an empty project on overleaf.com
   * and we clone it, move the local files in, and carry on as a normal project.
   */
  const handleLinkToOverleaf = async (localProject: OverleafProject): Promise<string | null> => {
    if (!gitSyncEngine.getCredentials()?.gitToken) {
      setPendingProject(localProject);
      setIsAuthOpen(true);
      showNotification('🔑 Connect your Overleaf account first.');
      return null;
    }

    const url = window.prompt(
      'Paste the URL of the Overleaf project to link this to.\n\n' +
      'Create it on overleaf.com first (New Project → Blank Project) — Overleaf\'s Git ' +
      'interface cannot create projects, only sync with existing ones.'
    );
    if (!url) return null;

    const remoteId = extractProjectId(url);
    if (!isValidProjectId(remoteId)) {
      showNotification('❌ That does not look like an Overleaf project URL.');
      return null;
    }

    setIsSyncing(true);
    setNotification('⬇️ Linking to Overleaf...');

    // Remember whether this copy already existed: rolling back must not delete
    // a project the user had downloaded before, along with any local edits.
    const alreadyHadCopy = await gitSyncEngine.hasProject(remoteId);
    const cloned = await gitSyncEngine.cloneProject(remoteId);
    if (!cloned.success) {
      setIsSyncing(false);
      showNotification(`❌ ${cloned.message}`);
      return null;
    }

    // A blank Overleaf project still ships its own main.tex. Never silently
    // destroy remote content the user may care about.
    const remoteFiles = await gitSyncEngine.readProjectFiles(remoteId);
    const clashes = remoteFiles.filter(remote => {
      const local = files.find(f => f.name === remote.name);
      return local && (local.content || '') !== remote.content;
    });

    if (clashes.length > 0) {
      const proceed = window.confirm(
        `The Overleaf project already contains:\n\n  ${clashes.map(c => c.name).join('\n  ')}\n\n` +
        `Linking replaces ${clashes.length === 1 ? 'it' : 'them'} with your local version. Continue?`
      );
      if (!proceed) {
        if (!alreadyHadCopy) await gitSyncEngine.deleteProject(remoteId);
        setIsSyncing(false);
        showNotification('Linking cancelled — nothing was changed.');
        return null;
      }
    }

    for (const f of files) {
      await gitSyncEngine.writeFile(remoteId, f.name, f.content || '');
    }

    // The project takes on the Overleaf id from here on; the old local entry
    // would otherwise linger in the list as a duplicate.
    const linked: OverleafProject = {
      ...localProject,
      id: remoteId,
      isLocal: true,
      syncStatus: 'local-changes',
      lastUpdated: new Date().toISOString()
    };
    overleafApi.removeProject(localProject.id);
    overleafApi.addProject(linked);
    setCurrentProject(linked);

    setIsSyncing(false);
    showNotification('🔗 Linked to Overleaf. Syncing...');
    return remoteId;
  };

  const autoCompileTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    // Deliberately never for 'overleaf-cloud': that engine pushes to the real
    // project, which must stay a decision, not a side effect of typing.
    if (!autoCompile || selectedCompiler === 'overleaf-cloud') return;
    if (currentView !== 'editor' || isCompiling) return;

    window.clearTimeout(autoCompileTimer.current);
    autoCompileTimer.current = window.setTimeout(() => handleCompile(), 2000);
    return () => window.clearTimeout(autoCompileTimer.current);
  }, [activeFile?.content, activeFileId, autoCompile, selectedCompiler, currentView]);

  const handleToggleAutoCompile = () => {
    const next = !autoCompile;
    setAutoCompile(next);
    localStorage.setItem('zabbleaf_auto_compile', next ? '1' : '0');
  };

  /** Pushes silently when the network returns, if there is anything waiting. */
  const syncPendingOnReconnect = async () => {
    const project = currentProjectRef.current;
    if (!project || isSyncingRef.current) return;
    if (!gitSyncEngine.getCredentials()?.gitToken) return;
    if (!(await gitSyncEngine.hasProject(project.id))) return;

    const pending = await gitSyncEngine.getChanges(project.id);
    if (pending.files.length === 0) return;

    setIsSyncing(true);
    setNotification('🔄 Back online — syncing your changes...');
    const result = await gitSyncEngine.syncProject(project.id);
    setIsSyncing(false);
    showNotification(result.success ? `✅ ${result.message}` : `❌ ${result.message}`);
  };

  /** Opens a compiler error's file at its line. */
  const handleJumpToError = (fileName: string, line: number) => {
    const target = files.find(f => f.name === fileName || f.name.endsWith(`/${fileName}`));
    if (target) setActiveFileId(target.id);
    setRevealLine({ line, nonce: Date.now() });
  };

  const handleSync = async () => {
    if (!currentProject) return;

    // Linking changes which project we are syncing, and setCurrentProject only
    // takes effect on the next render — so track the id explicitly.
    let syncId = currentProject.id;

    // A project with no git repository has no Overleaf counterpart yet: either
    // it was created locally, or its local copy was removed.
    if (!(await gitSyncEngine.hasProject(syncId))) {
      if (syncId.startsWith('local-')) {
        const wantsLink = window.confirm(
          `"${currentProject.name}" only exists on this computer — it is not linked to any Overleaf project yet.\n\n` +
          `Link it to one now?`
        );
        if (!wantsLink) {
          showNotification('ℹ️ This project is local only. Link it to an Overleaf project to sync.');
          return;
        }

        const linkedId = await handleLinkToOverleaf(currentProject);
        if (!linkedId) return;
        syncId = linkedId;
      } else {
        const wantsClone = window.confirm(
          `The local copy of "${currentProject.name}" is missing.\n\nDownload it from Overleaf again?`
        );
        if (!wantsClone) return;

        setIsSyncing(true);
        const res = await gitSyncEngine.cloneProject(syncId);
        setIsSyncing(false);
        if (!res.success) {
          showNotification(`❌ ${res.message}`);
          return;
        }
      }
    }

    // Show what is about to go up before it goes up.
    for (const f of files) {
      if (f.isModified) await gitSyncEngine.writeFile(syncId, f.name, f.content || '');
    }
    const pending = await gitSyncEngine.getChanges(syncId);
    if (pending.files.length > 0 && !changes) {
      setChanges(pending);
      return;
    }
    setChanges(null);

    setIsSyncing(true);
    setNotification('🔄 Syncing with Overleaf...');

    // Flush every edit to disk before git looks at the working tree.
    for (const f of files) {
      if (f.isModified) {
        await gitSyncEngine.writeFile(syncId, f.name, f.content || '');
      }
    }

    const result = await gitSyncEngine.syncProject(syncId);

    // Reload from disk so a rebase that brought in remote edits is reflected.
    const updatedFiles = await gitSyncEngine.readProjectFiles(syncId);
    if (updatedFiles.length > 0) {
      setFiles(updatedFiles.map(f => ({
        id: f.name,
        name: f.name,
        type: 'file',
        content: f.content,
        isModified: false,
        lastSynced: new Date().toISOString()
      })));
      if (!updatedFiles.find(f => f.name === activeFileId)) {
        setActiveFileId(updatedFiles[0].name);
      }
    }

    overleafApi.updateProject(syncId, {
      syncStatus: result.success ? 'synced' : 'local-changes',
      lastUpdated: new Date().toISOString()
    });

    setIsSyncing(false);
    showNotification(result.success ? `✅ ${result.message}` : `❌ ${result.message}`);
  };

  const handleLogin = () => {
    setIsAuthOpen(true);
  };

  /**
   * Forgets the Overleaf credentials. Downloaded projects are deliberately left
   * on disk: they are the user's documents, and signing out is not a request to
   * delete them.
   */
  const handleLogout = () => {
    const confirmed = window.confirm(
      'Sign out of Overleaf?\n\n' +
      'Your Git token will be removed from this computer and you will need to paste it again to sync.\n\n' +
      'Projects you have already downloaded stay on your computer and can still be edited offline.'
    );
    if (!confirmed) return;

    gitSyncEngine.clearCredentials();
    overleafAuth.logout();
    setIsLoggedIn(false);
    setPendingProject(null);
    showNotification('👋 Signed out. Your local projects are untouched.');
  };

  const handleContentChange = (newContent: string | undefined) => {
    const content = newContent || '';
    setFiles(prev => prev.map(f =>
      f.id === activeFileId ? { ...f, content, isModified: true } : f
    ));
    if (currentProject && activeFile) {
      queueSave(currentProject.id, activeFile.name, content);
    }
  };

  const handleNewFile = (fileName: string) => {
    const newId = Date.now().toString();
    const defaultContent = fileName.endsWith('.tex')
      ? `% ${fileName}\n\\section{${fileName.replace('.tex', '')}}\n\nWrite content here...\n`
      : `% ${fileName}\n`;
    setFiles(prev => [...prev, { id: newId, name: fileName, type: 'file', content: defaultContent }]);
    setActiveFileId(newId);
    if (currentProject) {
      gitSyncEngine.writeFile(currentProject.id, fileName, defaultContent).catch(console.error);
    }
    showNotification(`📄 Created "${fileName}"`);
  };

  const handleDeleteFile = (idToDelete: string) => {
    if (files.length <= 1) return;
    const target = files.find(f => f.id === idToDelete);
    if (!target) return;

    if (!window.confirm(`Delete "${target.name}"?\n\nIt is removed from your computer, and from Overleaf on the next sync.`)) {
      return;
    }

    setFiles(prev => prev.filter(f => f.id !== idToDelete));
    if (activeFileId === idToDelete) {
      setActiveFileId(files.filter(f => f.id !== idToDelete)[0].id);
    }

    // Also remove it from disk. Dropping it from the list alone left the file
    // in place, so git saw no deletion and it reappeared on the next open.
    if (currentProject) {
      gitSyncEngine.deleteFile(currentProject.id, target.name).catch(console.error);
    }
    showNotification(`🗑️ Deleted "${target.name}"`);
  };

  const handleOpenFolder = async () => {
    try {
      if ('showDirectoryPicker' in window) {
        const dirHandle = await (window as any).showDirectoryPicker();
        setFolderPath(dirHandle.name);
        showNotification(`📁 Opened: ${dirHandle.name}`);
      } else {
        showNotification('⚠️ Folder picker is not supported in this browser. Use Tauri desktop app.');
      }
    } catch { /* cancelled */ }
  };

  const handleOpenProject = async (project: OverleafProject) => {
    console.log(`[OPEN-PROJECT] id="${project.id}" name="${project.name}" local=${project.isLocal}`);
    setCurrentProject(project);
    setCurrentView('editor');
    setFiles([]);
    setActiveFileId('');
    overleafApi.addProject(project);

    setChosenRoot(localStorage.getItem(`zabbleaf_root_${project.id}`) || '');

    const alreadyOnDisk = await gitSyncEngine.hasProject(project.id);
    console.log(`[OPEN-PROJECT] Already cloned: ${alreadyOnDisk}`);

    if (!alreadyOnDisk && !project.isLocal) {
      if (!gitSyncEngine.getCredentials()?.gitToken) {
        // Reopen this project automatically once the token is saved.
        setPendingProject(project);
        setIsAuthOpen(true);
        showNotification('🔑 Connect your Overleaf account to download this project.');
        return;
      }

      setIsSyncing(true);
      setNotification('⬇️ Downloading project from Overleaf...');
      const res = await gitSyncEngine.cloneProject(project.id);
      setIsSyncing(false);
      console.log(`[OPEN-PROJECT] Clone: success=${res.success} message="${res.message}"`);

      if (!res.success) {
        showNotification(`❌ ${res.message}`);
        return;
      }
    }

    const loaded = await gitSyncEngine.readProjectFiles(project.id);
    console.log(`[OPEN-PROJECT] Loaded ${loaded.length} files: ${loaded.map(f => f.name).join(', ')}`);

    if (loaded.length > 0) {
      setFiles(loaded.map(f => ({
        id: f.name,
        name: f.name,
        type: 'file',
        content: f.content,
        isModified: false,
        lastSynced: new Date().toISOString()
      })));
      setActiveFileId(loaded[0].name);

      // A project added from a URL starts out named after its id. Overleaf's
      // Git interface never sends the real name, so take one from the document
      // instead — and only while the placeholder is still untouched, so a name
      // the user chose is never overwritten.
      let opened = project;
      if (isPlaceholderName(project.name)) {
        const derived = deriveProjectName(loaded);
        if (derived) {
          opened = { ...project, name: derived };
          setCurrentProject(opened);
        }
      }

      overleafApi.updateProject(project.id, {
        isLocal: true,
        syncStatus: 'synced',
        name: opened.name
      });
      showNotification(`✅ Opened "${opened.name}" — ${loaded.length} file${loaded.length === 1 ? '' : 's'}.`);
      return;
    }

    // Nothing readable on disk: a brand-new local project, or an Overleaf
    // project whose repository holds no text files.
    setFiles([{ id: 'main.tex', name: 'main.tex', type: 'file', content: DEFAULT_LATEX }]);
    setActiveFileId('main.tex');
    await gitSyncEngine.writeFile(project.id, 'main.tex', DEFAULT_LATEX);
    showNotification(
      project.isLocal
        ? `📄 Created "${project.name}" with a starter main.tex.`
        : '⚠️ This Overleaf project has no text files — starting from a blank main.tex.'
    );
  };

  const handleSaveCredentials = (email: string, _token: string, _projectId: string) => {
    setIsLoggedIn(true);
    showNotification(`🔒 Account connected: ${email}`);

    if (pendingProject) {
      const retry = pendingProject;
      setPendingProject(null);
      handleOpenProject(retry);
    }
  };

  const handleNewProject = () => {
    const name = prompt('Enter project name:');
    if (name) {
      const project: OverleafProject = {
        id: `local-${Date.now()}`,
        name,
        lastUpdated: new Date().toISOString(),
        owner: 'Me',
        isLocal: true,
        syncStatus: 'offline-only'
      };
      overleafApi.addProject(project);
      handleOpenProject(project);
    }
  };

  const handleRestoreVersion = (snapshot: VersionSnapshot) => {
    const file = files.find(f => f.name === snapshot.fileName);
    if (file) {
      setFiles(prev => prev.map(f => f.name === snapshot.fileName ? { ...f, content: snapshot.content, isModified: true } : f));
      setActiveFileId(file.id);
      showNotification(`↩️ Restored "${snapshot.fileName}" to version from ${new Date(snapshot.timestamp).toLocaleTimeString()}`);
    }
  };

  // HOME VIEW: Project List
  if (currentView === 'home') {
    return (
      <div className="zabbleaf-app">
        {notification && (
          <div style={{
            position: 'fixed', bottom: '20px', right: '20px',
            background: '#262b32', color: '#f2f5f8', border: '1px solid #6fa8cc',
            padding: '12px 20px', borderRadius: '10px', boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
            zIndex: 999, fontSize: '0.85rem'
          }}>
            {notification}
          </div>
        )}
        <div style={{ padding: '0 32px' }}>
          {isGitMissing && (
            <GitMissingBanner isInstalling={isInstallingGit} onInstall={handleInstallGit} />
          )}
          {texJustInstalled ? (
            <LaTeXReadyNotice version={texJustInstalled} />
          ) : (
            <LaTeXSetupBanner
              isInstalled={detectedLocalEngines.length > 0}
              isInstalling={isInstallingTex}
              isDismissed={texSetupDismissed}
              onInstall={handleInstallTeX}
              onDismiss={handleDismissTexSetup}
            />
          )}
        </div>

        <ProjectList
          isLoggedIn={isLoggedIn}
          onOpenProject={handleOpenProject}
          onLogin={handleLogin}
          onLogout={handleLogout}
          onNewProject={handleNewProject}
          accountEmail={gitSyncEngine.getCredentials()?.email}
        />

        {/* Also needed here: the login button on this screen opens it. */}
        <AuthModal
          isOpen={isAuthOpen}
          onClose={() => setIsAuthOpen(false)}
          onSaveCredentials={handleSaveCredentials}
          savedEmail={overleafAuth.getEmail()}
        />
      </div>
    );
  }

  // EDITOR VIEW
  return (
    <div className="zabbleaf-app">
      <SyncToolbar
        isOnline={isOnline}
        isSyncing={isSyncing}
        isCompiling={isCompiling}
        onSync={handleSync}
        onCompile={handleCompile}
        onOpenAuth={() => setIsAuthOpen(true)}
        onLogout={handleLogout}
        isLoggedIn={isLoggedIn}
        onHome={() => setCurrentView('home')}
        projectName={currentProject?.name || 'Local Project'}
        selectedCompiler={selectedCompiler}
        compilerOptions={compilerOptions}
        onCompilerChange={setSelectedCompiler}
        rootDocument={rootDocument}
        rootDocuments={rootDocuments}
        onRootDocumentChange={handleChooseRoot}
        autoCompile={autoCompile}
        onToggleAutoCompile={handleToggleAutoCompile}
      />

      {notification && (
        <div style={{
          position: 'fixed', bottom: '20px', right: '20px',
          background: '#262b32', color: '#f2f5f8', border: '1px solid #6fa8cc',
          padding: '12px 20px', borderRadius: '10px', boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
          zIndex: 999, fontSize: '0.85rem'
        }}>
          {notification}
        </div>
      )}

      <div className="workspace-container">
        <FileTree
          files={files}
          activeFileId={activeFileId}
          onSelectFile={setActiveFileId}
          onNewFile={handleNewFile}
          onDeleteFile={handleDeleteFile}
          onOpenFolder={handleOpenFolder}
          currentFolderPath={folderPath}
        />

        <div className="editor-pdf-split">
          <LaTeXEditor
            fileName={activeFile?.name || 'untitled.tex'}
            content={activeFile?.content || ''}
            onChange={handleContentChange}
            citations={citations}
            labels={labels}
            revealLine={revealLine}
          />

          <PDFPreview
            compiledUrl={compiledPdfUrl}
            compileLog={compileLog}
            isCompiling={isCompiling}
            isPdf={compiledIsPdf}
            onJumpToError={handleJumpToError}
          />
        </div>

        <VersionHistory
          snapshots={snapshots}
          onRestore={handleRestoreVersion}
        />
      </div>

      <AuthModal
        isOpen={isAuthOpen}
        onClose={() => setIsAuthOpen(false)}
        onSaveCredentials={handleSaveCredentials}
        savedEmail={overleafAuth.getEmail()}
      />

      <ChangesModal
        isOpen={!!changes}
        projectName={currentProject?.name || 'Overleaf'}
        files={changes?.files || []}
        diff={changes?.diff || ''}
        isSyncing={isSyncing}
        onConfirm={handleSync}
        onClose={() => setChanges(null)}
      />
    </div>
  );
};

export default App;

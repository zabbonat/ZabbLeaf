import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { appWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { SyncToolbar, CompilerEngine, CompilerOption } from './components/SyncToolbar/SyncToolbar';
import { FileTree, FileNode } from './components/FileTree/FileTree';
import { LaTeXEditor, EditorInsertion } from './components/Editor/LaTeXEditor';
import { PDFPreview } from './components/PDFViewer/PDFPreview';
import { AuthModal } from './components/AuthModal/AuthModal';
import { ProjectList } from './components/ProjectList/ProjectList';
import { NewProjectModal } from './components/ProjectList/NewProjectModal';
import { ChangesModal } from './components/ChangesModal/ChangesModal';
import { LaTeXSetupBanner, LaTeXReadyNotice, GitMissingBanner } from './components/LaTeXSetup/LaTeXSetupBanner';
import { SidePanel, SidePanelTab } from './components/SidePanel/SidePanel';
import { PaneDivider, CollapsedRail } from './components/Layout/PaneDivider';
import { overleafAuth } from './services/overleafAuth';
import { OverleafProject, overleafApi, isPlaceholderName } from './services/overleafApi';
import { latexCompiler, deriveProjectName } from './services/latexCompiler';
import {
  collectCitations,
  collectLabels,
  findRootDocuments,
  defaultRootDocument
} from './services/latexSymbols';
import { buildProjectSources } from './services/latexCompletions';
import { overleafCompiler } from './services/overleafCompiler';
import { localTeXCompiler, TeXEngine, DetectedEngine } from './services/localTeXCompiler';
import { versionHistory, VersionSnapshot } from './services/versionHistory';
import { gitSyncEngine, extractProjectId, isValidProjectId } from './services/gitSync';
import { usePanelLayout } from './hooks/usePanelLayout';
import { useDebouncedValue } from './hooks/useDebouncedValue';
import { countWords, countBySection, countProjectWords } from './services/textStats';
import { collectTodos } from './services/todoScanner';
import { writingStats } from './services/writingStats';
import { LatexSymbol } from './services/symbolPalette';
import { ProjectTemplate } from './services/projectTemplates';
import {
  projectAssets,
  ProjectAsset,
  figureBlock,
  isAssetName
} from './services/projectAssets';
import { PanelLeft, PanelRight } from 'lucide-react';
import './styles/main.css';
import './styles/panels.css';

type AppView = 'home' | 'editor';

/**
 * localStorage is not always there to be written to — a browser profile with
 * site data blocked throws outright rather than returning null, and a throw out
 * of a lazy useState initializer takes the whole app down to a white screen. A
 * preference that cannot be stored is a preference that falls back to its
 * default, not a crash.
 */
const remember = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // The setting simply does not survive this session.
  }
};

const recall = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

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
  /**
   * The same PDF as raw bytes. pdf.js renders from these, which makes a
   * recompile a state update instead of an iframe navigation that throws away
   * the reader's scroll position; `compiledPdfUrl` stays behind for Download
   * and for the HTML preview, which has no bytes.
   */
  const [compiledPdfData, setCompiledPdfData] = useState<Uint8Array | null>(null);
  const [compiledIsPdf, setCompiledIsPdf] = useState<boolean>(false);
  const [compileLog, setCompileLog] = useState<string>('');
  /** Which pass the engine is on, from the backend's progress events. */
  const [compileStep, setCompileStep] = useState<string>('');
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
    () => recall('zabbleaf_auto_compile') !== '0'
  );
  const [texSetupDismissed, setTexSetupDismissed] = useState<boolean>(
    () => recall('zabbleaf_tex_setup_dismissed') === '1'
  );

  // Panels: widths, and which of them are open.
  const { layout, toggle, show, resizeSidebar, resizePanel, resizeSplit, reset } = usePanelLayout();
  const [sidePanelTab, setSidePanelTab] = useState<SidePanelTab>('todo');
  const splitRef = useRef<HTMLDivElement | null>(null);

  // Figures, which the editor cannot open as text and so never listed.
  const [assets, setAssets] = useState<ProjectAsset[]>([]);
  const [insertion, setInsertion] = useState<EditorInsertion | null>(null);
  const [installingPackage, setInstallingPackage] = useState<string>('');
  const [isNewProjectOpen, setIsNewProjectOpen] = useState<boolean>(false);
  const [writingTick, setWritingTick] = useState<number>(0);

  // The online handler is registered once at mount, so it must read the current
  // project through refs rather than a value captured back then.
  const currentProjectRef = useRef<OverleafProject | null>(null);
  currentProjectRef.current = currentProject;
  const isSyncingRef = useRef(false);
  isSyncingRef.current = isSyncing;

  // Read from inside handleCompile's `finally`, which runs long after the render
  // that started the compile: a value captured then is exactly the stale one
  // that re-armed an auto-compile the user had just turned off.
  const autoCompileRef = useRef(autoCompile);
  autoCompileRef.current = autoCompile;
  const selectedCompilerRef = useRef<CompilerEngine>(selectedCompiler);
  selectedCompilerRef.current = selectedCompiler;
  const currentViewRef = useRef<AppView>(currentView);
  currentViewRef.current = currentView;

  /**
   * Bumped by every path that leaves the current project.
   *
   * Opening is a long chain of awaits and the Home button stays live during it,
   * so a second project could finish first; project A's files were then set
   * under project B's identity and the first keystroke wrote A's document into
   * B's repository, where the next sync pushed it to B's Overleaf project.
   */
  const openGeneration = useRef(0);

  const activeFile = files.find(f => f.id === activeFileId) || files[0];
  const projectId = currentProject?.id || 'local-default';

  // The current file is counted live — the status bar should react as you
  // type — while anything that walks every file in the project waits until
  // typing stops, which on a thesis is the difference between smooth and not.
  const activeContent = activeFile?.content || '';
  const wordCount = useMemo(() => countWords(activeContent), [activeContent]);
  const settledContent = useDebouncedValue(activeContent);
  const sections = useMemo(() => countBySection(settledContent), [settledContent]);

  const settledFiles = useDebouncedValue(files);
  const settled = useMemo(
    () => settledFiles.map(f => ({ name: f.name, content: f.content || '' })),
    [settledFiles]
  );

  // Every one of these regex-scans every .tex and .bib in the project. Running
  // them on the render path scanned the whole thesis per keystroke and handed
  // LaTeXEditor fresh array identities each time, re-running its unknown-
  // reference marker pass as well. Depending on `citations.length` rather than
  // the array also left the To-do list stale when a label was renamed without
  // changing the count.
  const citations = useMemo(() => collectCitations(settled), [settled]);
  const labels = useMemo(() => collectLabels(settled), [settled]);
  const completionSources = useMemo(() => buildProjectSources(settled, assets), [settled, assets]);
  const todos = useMemo(() => collectTodos(settled, citations, labels), [settled, citations, labels]);
  const projectWords = useMemo(() => countProjectWords(settled), [settled]);

  /**
   * Deliberately on the live `files`, not on `settled`.
   *
   * `useDebouncedValue` keeps the *previous* value until its timer fires, so for
   * 600 ms after a project opens `settled` still holds the project the user just
   * left. Recompiling in that window picked that project's root and failed with
   * "main.tex does not exist in this project". This is a `\documentclass`
   * substring test per .tex file, not one of the project-wide regex passes
   * above, so running it per keystroke costs nothing worth debouncing.
   */
  const rootDocuments = useMemo(
    () => findRootDocuments(files.map(f => ({ name: f.name, content: f.content || '' }))),
    [files]
  );

  const rootDocument =
    chosenRoot && files.some(f => f.name === chosenRoot)
      ? chosenRoot
      : defaultRootDocument(rootDocuments, activeFile?.name || '');

  const writingSummary = useMemo(
    () => writingStats.summary(projectId),
    [projectId, writingTick]
  );

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
    remember(`zabbleaf_root_${projectId}`, fileName);
  };

  const handleDismissTexSetup = () => {
    setTexSetupDismissed(true);
    remember('zabbleaf_tex_setup_dismissed', '1');
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
  // The text waiting behind each timer. Closing the window within 400 ms of the
  // last keystroke used to drop that edit from disk entirely, and because sync
  // only writes files React still marks modified, it was gone from the next
  // session too.
  const pendingSaves = useRef<Record<string, { project: string; fileName: string; content: string }>>({});
  // A save that has started failing is worth saying once, not per keystroke.
  const saveFailed = useRef(false);

  const queueSave = (project: string, fileName: string, content: string) => {
    const key = `${project}:${fileName}`;
    window.clearTimeout(saveTimers.current[key]);
    pendingSaves.current[key] = { project, fileName, content };
    saveTimers.current[key] = window.setTimeout(async () => {
      delete saveTimers.current[key];
      delete pendingSaves.current[key];
      const result = await gitSyncEngine.writeFile(project, fileName, content);
      if (result.success) {
        saveFailed.current = false;
      } else if (!saveFailed.current) {
        saveFailed.current = true;
        showNotification(`❌ Could not save ${fileName}: ${result.message}`);
      }
    }, 400);
  };

  // Read by flushPendingSaves, which is a stable callback the close handler
  // registered once at mount and so cannot close over the current file list.
  const filesRef = useRef<FileNode[]>(files);
  filesRef.current = files;

  /** Finishes every debounced write that has not fired yet. */
  const flushPendingSaves = useCallback(async () => {
    const outstanding = Object.values(pendingSaves.current);
    pendingSaves.current = {};
    for (const key of Object.keys(saveTimers.current)) {
      window.clearTimeout(saveTimers.current[key]);
    }
    saveTimers.current = {};

    const writes = [...outstanding];

    // `isModified` is the superset the queue is not, and the compile and sync
    // flushes already use it: handleRestoreVersion marks a file modified without
    // ever going through queueSave, so a restored version was dropped on the
    // next Home, project switch or quit with nothing on screen to say so.
    const project = currentProjectRef.current;
    if (project) {
      const queued = new Set(writes.map(w => `${w.project}:${w.fileName}`));
      for (const f of filesRef.current) {
        if (!f.isModified) continue;
        const key = `${project.id}:${f.name}`;
        if (queued.has(key)) continue;
        writes.push({ project: project.id, fileName: f.name, content: f.content || '' });
      }
    }

    await Promise.all(
      writes.map(save => gitSyncEngine.writeFile(save.project, save.fileName, save.content))
    );
  }, []);

  // `isCompiling` is state, so a check against it inside a timer callback reads
  // the value from the render that armed the timer: an armed auto-compile
  // survived into a compile the user had started by hand and fired a second
  // one. The in-flight guard has to be a ref, read the moment a compile starts.
  const compileInFlight = useRef(false);
  const compileAgain = useRef(false);
  const autoCompileTimer = useRef<number | undefined>(undefined);
  // The timer calls through a ref so it always runs the newest handleCompile:
  // a stale one closes over an older `files` and writes it back over newer
  // on-disk content.
  const handleCompileRef = useRef<() => void>(() => {});
  /**
   * Set by Stop when the backend had nothing to kill yet.
   *
   * The pre-compile flush blocks on the project's repository lock while a sync
   * holds it, so Stop can land before `zl_compile_project` has registered a
   * process. `zl_cancel_compile` then returns false and the engine runs to
   * completion; without this flag its PDF and log replaced the ones the user
   * pressed Stop to keep.
   */
  const stopRequested = useRef(false);

  /**
   * Set when a compile was asked for outright rather than by the idle timer.
   *
   * Installing a missing package recompiles to show the fix worked. That queues
   * behind the compile still running, and re-arming only when auto-compile is on
   * dropped it: with the setting off the user got "✅ Installed fontspec" over
   * the same failing log and the same diagnostic.
   */
  const compileRequested = useRef(false);

  const handleCompile = useCallback(async () => {
    if (compileInFlight.current) {
      compileAgain.current = true;
      return;
    }
    compileInFlight.current = true;
    // The compile it asked for is starting now, so the flag has done its job.
    compileRequested.current = false;
    stopRequested.current = false;
    setIsCompiling(true);
    const content = activeFile?.content || '';

    // Every path out of this project bumps the generation. A compile is the one
    // long-running handler that had no such guard, so a slow engine finishing
    // after the user pressed Home wrote its PDF, log and version snapshot into
    // whatever project was opened next.
    const generation = openGeneration.current;
    const stale = () => openGeneration.current !== generation;

    try {
      if (selectedCompiler === 'html-preview') {
        const result = await latexCompiler.compile(content);
        if (stale()) return;

        if (result.success && result.pdfUrl) {
          setCompiledPdfUrl(result.pdfUrl);
          setCompiledIsPdf(false);
          // The quick preview is HTML. Leaving the last engine's bytes in place
          // would keep the canvas viewer showing a document nobody asked for.
          setCompiledPdfData(null);
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
          showNotification('⚠️ Open a project to compile with Overleaf Cloud.');
          return;
        }
        // This pushes to the real Overleaf project, so never do it silently.
        const confirmed = window.confirm(
          `Compiling on Overleaf pushes your local changes to "${currentProject.name}" ` +
          `and opens the project in your browser, where Overleaf compiles it.\n\n` +
          `Overleaf blocks embedding, so the PDF cannot appear inside ZabbLeaf.\n\nPush and open now?`
        );
        if (!confirmed) return;

        const fileList = files.map(f => ({ name: f.name, content: f.content || '' }));
        const result = await overleafCompiler.compile(currentProject.id, fileList);
        // The push already happened, so the user is told either way — but the
        // log belongs to a project that may no longer be the one on screen.
        if (!stale()) setCompileLog(result.log);
        showNotification(
          result.success
            ? '🌐 Pushed to Overleaf and opened in your browser.'
            : `❌ ${result.errors[0] || 'Overleaf compilation failed.'}`
        );
      } else {
        // Local TeX compilation (pdflatex, xelatex, lualatex). The engine reads
        // files from disk, so flush the editor first — and compile the whole
        // project directory so \input, .bib and class files resolve.
        //
        // `isModified` rather than a pending save timer: handleRestoreVersion
        // marks a file modified without ever queuing a save, so a compile right
        // after restoring a version would otherwise use the stale disk copy.
        const fileName = rootDocument;
        for (const f of files) {
          if (!f.isModified) continue;
          const written = await gitSyncEngine.writeFile(projectId, f.name, f.content || '');
          if (!written.success) {
            // Compiling on text we failed to save would report errors about a
            // document the user cannot see. The `finally` clears isCompiling.
            showNotification(`❌ Could not save ${f.name}: ${written.message}`);
            return;
          }
        }

        // The flush above can sit on the repository lock for the length of a
        // sync; starting an engine for a project the user has since left only
        // holds that lock longer for the project they moved to.
        if (stale()) return;

        const result = await localTeXCompiler.compile(projectId, fileName, selectedCompiler as TeXEngine);
        if (stale()) return;

        // A Stop is not a failure: the engine was killed on purpose and the
        // last good PDF, log and diagnostics are still the truth on screen.
        // Nulling compiledPdfData here blanks the preview, which is precisely
        // what the cancelled flag exists to prevent. `stopRequested` covers the
        // Stop that arrived before the backend had a process to report killing.
        if (result.cancelled || stopRequested.current) return;

        setCompileLog(result.log);

        if (result.success && result.pdfUrl) {
          setCompiledPdfUrl(result.pdfUrl);
          setCompiledIsPdf(true);
          setCompiledPdfData(result.pdfData);
          versionHistory.saveSnapshot(projectId, fileName, content, `Compiled with ${selectedCompiler}`);
          setSnapshots(versionHistory.getProjectHistory(projectId));
          showNotification(`✅ Compiled ${fileName} with ${selectedCompiler}.`);
        } else {
          showNotification(`❌ ${result.errors[0] || `${selectedCompiler} compilation failed.`}`);
        }
      }
    } finally {
      compileInFlight.current = false;
      setIsCompiling(false);
      setCompileStep('');
      const requested = compileRequested.current;
      compileRequested.current = false;
      if (compileAgain.current) {
        compileAgain.current = false;
        // Edits that arrived while the engine ran would otherwise never
        // compile: the auto-compile effect does not re-run when isCompiling
        // clears. 400 ms, not 2000 — the user already paused for two seconds
        // before this compile began, and sharing autoCompileTimer means a
        // keystroke still pushes it back out.
        //
        // Every condition the auto-compile effect checks is re-checked here,
        // through refs so this sees the settings as they are now rather than as
        // they were when the compile started. Turning auto-compile off during a
        // slow run still got one more compile, and switching the dropdown —
        // which stays live while compiling — to Overleaf Cloud popped the "Push
        // and open now?" confirm as a side effect of typing, which is exactly
        // what that engine's exclusion from auto-compile exists to prevent.
        // `requested` overrides only the auto-compile setting: an explicit ask
        // is not the idle timer, so turning that setting off must not discard
        // it. The other two conditions hold either way — the project is gone,
        // or the engine is the one that pushes to Overleaf.
        const canQueue =
          !stale() &&
          (requested || autoCompileRef.current) &&
          selectedCompilerRef.current !== 'overleaf-cloud' &&
          currentViewRef.current === 'editor';
        if (canQueue) {
          window.clearTimeout(autoCompileTimer.current);
          autoCompileTimer.current = window.setTimeout(() => handleCompileRef.current(), 400);
        }
      }
    }
  }, [activeFile, currentProject, files, projectId, selectedCompiler, rootDocument]);

  useEffect(() => {
    handleCompileRef.current = handleCompile;
  }, [handleCompile]);

  /** Kills the running engine. Only reachable for a real TeX process. */
  const handleCancelCompile = useCallback(async () => {
    // Deliberately does not clear isCompiling: the in-flight promise resolves
    // with cancelled:true on its own, and clearing early would let a new
    // compile start before the engine has actually died.
    compileAgain.current = false;
    // Set before the call, not after it: the engine can finish between the two.
    stopRequested.current = true;
    const stopped = await localTeXCompiler.cancel(projectId);
    if (!stopped) {
      // No engine to kill: the compile is still in its pre-engine phase,
      // blocked behind another project operation on the repository lock, or it
      // finished in the moment between the click and this call. Either way the
      // flag above is what makes this Stop stick — handleCompile drops the
      // result when it arrives instead of replacing the PDF on screen — and the
      // spinner stays up until it does, so say so rather than looking hung.
      showNotification('⏹️ Stop requested — this compile will be discarded when it finishes.');
    }
  }, [projectId]);

  // html-preview finishes in milliseconds and overleaf-cloud is a push that
  // must not be interrupted half-way, so neither gets a Stop button.
  const canCancelCompile =
    selectedCompiler === 'pdflatex' ||
    selectedCompiler === 'xelatex' ||
    selectedCompiler === 'lualatex';

  // Which pass the engine is on. Filtered by project because the listener
  // outlives any one compile, and a leftover label from the project the user
  // just left would sit in the toolbar as if it were still running.
  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;

    listen<{ projectId: string; label: string }>('zl://compile-progress', event => {
      if (event.payload.projectId !== projectId) return;
      setCompileStep(event.payload.label);
    })
      .then(unlisten => {
        if (cancelled) unlisten();
        else dispose = unlisten;
      })
      .catch(console.error);

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [projectId]);

  // Leaving a project must not leave its engine running: it holds the repo lock
  // the next project's clone or sync needs, and its output is already orphaned.
  useEffect(
    () => () => {
      // Not user-initiated: this must kill a running engine without arming a
      // Stop, or switching away and back inside the arming window silently
      // cancels the returning project's first compile.
      void localTeXCompiler.cancel(projectId, false);
    },
    [projectId]
  );

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
    // destroy remote content the user may care about — and a read we could not
    // perform is not evidence that there is nothing there.
    const remote = await gitSyncEngine.readProjectFiles(remoteId);
    if (!remote.success) {
      if (!alreadyHadCopy) await gitSyncEngine.deleteProject(remoteId);
      setIsSyncing(false);
      showNotification(`❌ Could not read the Overleaf project: ${remote.message}`);
      return null;
    }

    const clashes = remote.files.filter(file => {
      const local = files.find(f => f.name === file.name);
      return local && (local.content || '') !== file.content;
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
      const written = await gitSyncEngine.writeFile(remoteId, f.name, f.content || '');
      if (!written.success) {
        // Stop rather than roll back: the clone is already partly populated and
        // deleting it would destroy the copies that did land.
        setIsSyncing(false);
        showNotification(`❌ Could not copy ${f.name} into the Overleaf project: ${written.message}`);
        return null;
      }
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

  useEffect(() => {
    // Deliberately never for 'overleaf-cloud': that engine pushes to the real
    // project, which must stay a decision, not a side effect of typing.
    if (!autoCompile || selectedCompiler === 'overleaf-cloud') return;
    // No isCompiling check here on purpose: it is state read from the render
    // that armed the timer, so it was never the value that mattered. The
    // in-flight ref inside handleCompile is the real guard, and it re-arms
    // itself for the edits that arrived while the engine ran.
    if (currentView !== 'editor') return;

    window.clearTimeout(autoCompileTimer.current);
    autoCompileTimer.current = window.setTimeout(() => handleCompileRef.current(), 2000);
    return () => window.clearTimeout(autoCompileTimer.current);
  }, [activeFile?.content, activeFileId, autoCompile, selectedCompiler, currentView]);

  const handleToggleAutoCompile = () => {
    const next = !autoCompile;
    setAutoCompile(next);
    remember('zabbleaf_auto_compile', next ? '1' : '0');
  };

  /** Pushes silently when the network returns, if there is anything waiting. */
  const syncPendingOnReconnect = async () => {
    const project = currentProjectRef.current;
    if (!project || isSyncingRef.current) return;
    if (!gitSyncEngine.getCredentials()?.gitToken) return;
    if (!(await gitSyncEngine.hasProject(project.id))) return;

    const pending = await gitSyncEngine.getChanges(project.id);
    // A read that failed is not the same as nothing to push; pushing anyway
    // would skip the review the user is entitled to.
    if (!pending.success || pending.files.length === 0) return;

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

  // -------------------------------------------------------------------------
  // Panels, figures, symbols
  // -------------------------------------------------------------------------

  /** Ctrl+B and Ctrl+J, the two people already expect from an editor. */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      const key = event.key.toLowerCase();
      if (key !== 'b' && key !== 'j') return;
      event.preventDefault();
      toggle(key === 'b' ? 'files' : 'panel');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggle]);

  /** Opens the side panel on a given tab, wherever it was left. */
  const openPanel = (tab: SidePanelTab) => {
    setSidePanelTab(tab);
    show('panel');
  };

  const refreshAssets = useCallback(async (id: string) => {
    setAssets(await projectAssets.list(id));
  }, []);

  /** Types something in at the caret of the editor. */
  const insertIntoEditor = (text: string, math = false) => {
    setInsertion({ text, math, nonce: Date.now() });
  };

  const handleInsertSymbol = (symbol: LatexSymbol) => {
    insertIntoEditor(symbol.command, symbol.math);
  };

  /**
   * Stores a pasted image and hands the editor the block to write.
   *
   * Returning the whole figure environment rather than the path is deliberate:
   * a figure with no caption and no label cannot be referred to, and adding
   * them afterwards never happens.
   */
  const handlePasteImage = useCallback(
    async (blob: Blob): Promise<string | null> => {
      try {
        const path = await projectAssets.save(projectId, blob);
        await refreshAssets(projectId);
        showNotification(`🖼️ Saved ${path}`);
        return figureBlock(path);
      } catch (err: any) {
        showNotification(`❌ ${String(err?.message || err)}`);
        return null;
      }
    },
    [projectId, refreshAssets]
  );

  /** The Add button in the file tree, for people who never paste. */
  const handleAddImageFile = async (file: File) => {
    if (!isAssetName(file.name)) {
      showNotification('⚠️ That is not an image. PNG, JPG, PDF and EPS work.');
      return;
    }
    try {
      const path = await projectAssets.save(projectId, file, `figures/${file.name}`);
      await refreshAssets(projectId);
      insertIntoEditor(figureBlock(path));
      showNotification(`🖼️ Added ${path}`);
    } catch (err: any) {
      showNotification(`❌ ${String(err?.message || err)}`);
    }
  };

  const handleDeleteAsset = async (path: string) => {
    if (!window.confirm(`Delete "${path}"?\n\nIt goes from your computer, and from Overleaf on the next sync.`)) {
      return;
    }
    const removed = await gitSyncEngine.deleteFile(projectId, path);
    if (!removed.success) {
      showNotification(`❌ Could not delete ${path}: ${removed.message}`);
      return;
    }
    await refreshAssets(projectId);
    showNotification(`🗑️ Deleted ${path}`);
  };

  /**
   * Images dropped onto the window.
   *
   * The webview hands us paths rather than files — Tauri intercepts the drop
   * before the DOM sees it — so the copying happens on the Rust side.
   */
  useEffect(() => {
    if (currentView !== 'editor') return;
    // The cleanup used to fire while the registration promise was still
    // pending, so in StrictMode and on any project switch during the IPC round
    // trip the old listener stayed attached: one dropped image was imported
    // twice and two figure blocks were inserted.
    let cancelled = false;
    let dispose: (() => void) | undefined;

    appWindow
      .onFileDropEvent(async event => {
        if (event.payload.type !== 'drop') return;
        const images = event.payload.paths.filter(isAssetName);
        if (images.length === 0) {
          showNotification('⚠️ Only images can be dropped in: PNG, JPG, PDF, EPS.');
          return;
        }

        const added: string[] = [];
        for (const source of images) {
          try {
            added.push(await projectAssets.importFromPath(projectId, source));
          } catch (err: any) {
            showNotification(`❌ ${String(err?.message || err)}`);
          }
        }
        if (added.length === 0) return;

        await refreshAssets(projectId);
        insertIntoEditor(added.map(figureBlock).join('\n'));
        showNotification(`🖼️ Added ${added.join(', ')}`);
      })
      .then(unlisten => {
        if (cancelled) unlisten();
        else dispose = unlisten;
      })
      .catch(console.error);

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [currentView, projectId, refreshAssets]);

  /**
   * Finishes outstanding writes before the window goes away.
   *
   * Tauri's wrapper closes the window itself once this handler resolves unless
   * preventDefault was called, so the flush has to happen inside it; the
   * explicit close() that follows is routed straight to the runtime's window
   * teardown and does not raise this event again.
   */
  const closing = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;

    appWindow
      .onCloseRequested(async event => {
        // An impatient second click on the X does raise it again; running the
        // flush twice would re-write files the first pass already saved.
        event.preventDefault();
        if (closing.current) return;
        closing.current = true;

        try {
          // A write that hangs must not make the window impossible to close.
          await Promise.race([
            flushPendingSaves(),
            new Promise<void>(resolve => window.setTimeout(resolve, 3000))
          ]);
        } finally {
          try {
            await appWindow.close();
          } catch (err) {
            // Leaving the latch set would make the X dead for the rest of the
            // session; better to let the next click try again.
            closing.current = false;
            console.error('[App] Could not close the window:', err);
          }
        }
      })
      .then(unlisten => {
        if (cancelled) unlisten();
        else dispose = unlisten;
      })
      .catch(console.error);

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [flushPendingSaves]);

  /** Installs the package a compiler error asked for, then recompiles. */
  const handleInstallPackage = async (packageName: string) => {
    setInstallingPackage(packageName);
    setNotification(`📦 Installing ${packageName}...`);
    const result = await localTeXCompiler.installPackage(packageName);
    setInstallingPackage('');
    showNotification(result.success ? `✅ ${result.message}` : `❌ ${result.message}`);
    if (result.success) {
      // Marked before the call so that if a compile is still running, the queued
      // re-arm knows this one was asked for rather than timed out into.
      compileRequested.current = true;
      handleCompile();
    }
  };

  /**
   * Records the word total for the streak and the daily chart.
   *
   * Two things this must not do: write to localStorage on every keystroke, and
   * record the moment a project opens with no files in it yet — that would set
   * the day's baseline to zero, and the whole document would then count as
   * written this morning.
   */
  const lastRecorded = useRef<{ id: string; at: number }>({ id: '', at: 0 });
  useEffect(() => {
    if (currentView !== 'editor' || !projectId || files.length === 0) return;

    const now = Date.now();
    const previous = lastRecorded.current;
    // A different project always records at once: its baseline is what matters.
    if (previous.id === projectId && now - previous.at < 10000) return;

    lastRecorded.current = { id: projectId, at: now };
    writingStats.record(projectId, projectWords);
    setWritingTick(tick => tick + 1);
  }, [projectWords, projectId, currentView, files.length]);

  const handleSync = async () => {
    if (!currentProject) return;
    // The Sync button stays live until setIsSyncing(true) far below, so a
    // double click started two syncs against the same repository.
    if (isSyncingRef.current) return;

    // Opening another project mid-sync must not let this one's reload land
    // under the new project's identity.
    const generation = openGeneration.current;
    const stale = () => openGeneration.current !== generation;

    // Linking changes which project we are syncing, and setCurrentProject only
    // takes effect on the next render — so track the id explicitly.
    let syncId = currentProject.id;

    // git reads the working tree, not the editor. Reports the first failure
    // rather than pushing a document whose newest text never reached disk.
    const flushModified = async (id: string): Promise<boolean> => {
      for (const f of files) {
        if (!f.isModified) continue;
        const written = await gitSyncEngine.writeFile(id, f.name, f.content || '');
        if (!written.success) {
          showNotification(`❌ Could not save ${f.name}: ${written.message}`);
          return false;
        }
      }
      return true;
    };

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
    if (!(await flushModified(syncId))) return;

    const pending = await gitSyncEngine.getChanges(syncId);
    if (!pending.success) {
      // Reading this as "nothing to review" is how a push happened without the
      // diff ever being shown.
      showNotification(`❌ Could not read what has changed: ${pending.message}`);
      return;
    }
    if (pending.files.length > 0 && !changes) {
      setChanges({ files: pending.files, diff: pending.diff });
      return;
    }
    setChanges(null);

    setIsSyncing(true);
    setNotification('🔄 Syncing with Overleaf...');

    // Flush again: the review modal has been on screen, and the editor stayed
    // live behind it.
    if (!(await flushModified(syncId))) {
      setIsSyncing(false);
      return;
    }

    const result = await gitSyncEngine.syncProject(syncId);

    // Reload from disk so a rebase that brought in remote edits is reflected.
    const updated = await gitSyncEngine.readProjectFiles(syncId);
    // Another project was opened while git ran; these files belong to the one
    // the user just left, and setting them now would put them under the new
    // project's id — where the next sync would push them to its Overleaf copy.
    if (!stale() && updated.success && updated.files.length > 0) {
      setFiles(updated.files.map(f => ({
        id: f.name,
        name: f.name,
        type: 'file',
        content: f.content,
        isModified: false,
        lastSynced: new Date().toISOString()
      })));
      if (!updated.files.find(f => f.name === activeFileId)) {
        setActiveFileId(updated.files[0].name);
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
      void gitSyncEngine.writeFile(currentProject.id, fileName, defaultContent).then(written => {
        if (!written.success) showNotification(`❌ Could not create ${fileName}: ${written.message}`);
      });
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
      // Drop the debounced write for this file first. Writes run on the backend's
      // blocking pool behind a per-project lock, so one issued before the delete
      // could land after it and recreate the file — and `git add -A` on the next
      // sync would push the deleted file straight back up to Overleaf.
      const pendingKey = `${currentProject.id}:${target.name}`;
      window.clearTimeout(saveTimers.current[pendingKey]);
      delete saveTimers.current[pendingKey];
      delete pendingSaves.current[pendingKey];

      void gitSyncEngine.deleteFile(currentProject.id, target.name).then(removed => {
        if (!removed.success) showNotification(`❌ Could not delete ${target.name}: ${removed.message}`);
      });
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

  /** Turns a file list from disk into editor state. */
  const asFileNodes = (loaded: { name: string; content: string }[]): FileNode[] =>
    loaded.map(f => ({
      id: f.name,
      name: f.name,
      type: 'file' as const,
      content: f.content,
      isModified: false,
      lastSynced: new Date().toISOString()
    }));

  const handleOpenProject = async (project: OverleafProject, template?: ProjectTemplate) => {
    const generation = ++openGeneration.current;
    const stale = () => openGeneration.current !== generation;

    // The previous project's queued compile must not fire into this one.
    compileAgain.current = false;
    window.clearTimeout(autoCompileTimer.current);

    // Whatever the previous project still had queued belongs to the previous
    // project's directory, and queueSave's key namespaces it by id — but an
    // unflushed write racing this project's read is a lost edit either way.
    await flushPendingSaves();
    if (stale()) return;

    console.log(`[OPEN-PROJECT] id="${project.id}" name="${project.name}" local=${project.isLocal}`);
    setCurrentProject(project);
    setCurrentView('editor');
    setFiles([]);
    setActiveFileId('');
    setAssets([]);

    // The previous project's PDF, log and pending diff describe a document that
    // is no longer open: its clickable error list points at files the editor
    // cannot show, and its bytes would keep rendering in the preview pane.
    localTeXCompiler.reset();
    latexCompiler.reset();
    setCompiledPdfUrl(null);
    setCompiledPdfData(null);
    setCompiledIsPdf(false);
    setCompileLog('');
    setCompileStep('');
    setChanges(null);

    overleafApi.addProject(project);

    setChosenRoot(recall(`zabbleaf_root_${project.id}`) || '');

    const alreadyOnDisk = await gitSyncEngine.hasProject(project.id);
    if (stale()) return;
    console.log(`[OPEN-PROJECT] Already cloned: ${alreadyOnDisk}`);

    // `isLocal` is set true on every successful open, so gating the re-download
    // on it made this branch dead from the second open onwards — and a missing
    // clone then fell through to the starter branch below, which wrote
    // DEFAULT_LATEX over whatever the repository actually held.
    const isOverleafProject = !project.id.startsWith('local-');

    if (!alreadyOnDisk && isOverleafProject) {
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
      if (stale()) return;
      console.log(`[OPEN-PROJECT] Clone: success=${res.success} message="${res.message}"`);

      if (!res.success) {
        showNotification(`❌ ${res.message}`);
        return;
      }
    }

    const read = await gitSyncEngine.readProjectFiles(project.id);
    if (stale()) return;

    if (!read.success) {
      // Falling through from here is what wrote a blank main.tex over a project
      // we had merely failed to read.
      showNotification(`❌ Could not read this project's files: ${read.message}`);
      return;
    }

    const loaded = read.files;
    console.log(`[OPEN-PROJECT] Loaded ${loaded.length} files: ${loaded.map(f => f.name).join(', ')}`);

    // Figures are not text, so they never come back with the files above.
    refreshAssets(project.id).catch(console.error);

    if (loaded.length > 0) {
      setFiles(asFileNodes(loaded));
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

    // Nothing readable on disk. Only a genuinely new project gets a starter
    // document: an existing Overleaf project that reads as empty is far more
    // likely to be one whose files we could not see than one that has none.
    const isNew = template !== undefined || !isOverleafProject;
    if (!isNew) {
      showNotification('⚠️ This Overleaf project has no text files yet.');
      return;
    }

    const starter = template
      ? template.files
      : [{ name: 'main.tex', content: DEFAULT_LATEX }];

    // writeNewFile rather than writeFile: if anything is already at that path
    // it is the user's document, not ours to replace.
    let clobbered = false;
    for (const file of starter) {
      const written = await gitSyncEngine.writeNewFile(project.id, file.name, file.content);
      if (stale()) return;
      if (!written.success) {
        showNotification(`❌ Could not create ${file.name}: ${written.message}`);
        return;
      }
      if (!written.written) clobbered = true;
    }

    if (clobbered) {
      // Something was there after all, so show that rather than the starter.
      const reread = await gitSyncEngine.readProjectFiles(project.id);
      if (stale()) return;
      if (reread.success && reread.files.length > 0) {
        setFiles(asFileNodes(reread.files));
        setActiveFileId(reread.files[0].name);
        showNotification(
          `✅ Opened "${project.name}" — ${reread.files.length} file${reread.files.length === 1 ? '' : 's'} already on disk.`
        );
        return;
      }
    }

    setFiles(
      starter.map(file => ({
        id: file.name,
        name: file.name,
        type: 'file' as const,
        content: file.content
      }))
    );
    setActiveFileId(starter[0].name);

    showNotification(
      template
        ? `📄 Created "${project.name}" from the ${template.name.toLowerCase()} template.`
        : `📄 Created "${project.name}" with a starter main.tex.`
    );
  };

  /**
   * Leaving the editor for the project list.
   *
   * Bumping the generation is what stops an open() still running in the
   * background from landing its files after the user has moved on.
   */
  const handleGoHome = useCallback(async () => {
    openGeneration.current += 1;
    // A compile still running re-arms itself from its `finally`, which runs
    // after this. The generation check there covers it, but dropping the queued
    // run and the armed timer here is what stops the auto-compile effect's
    // already-returned cleanup from leaving a live timer behind.
    compileAgain.current = false;
    window.clearTimeout(autoCompileTimer.current);
    await flushPendingSaves();
    setCurrentView('home');
  }, [flushPendingSaves]);

  const handleSaveCredentials = (email: string, _token: string, _projectId: string) => {
    setIsLoggedIn(true);
    showNotification(`🔒 Account connected: ${email}`);

    if (pendingProject) {
      const retry = pendingProject;
      setPendingProject(null);
      handleOpenProject(retry);
    }
  };

  const handleNewProject = () => setIsNewProjectOpen(true);

  /** Creates a local project from a template, then opens it. */
  const handleCreateProject = (name: string, template: ProjectTemplate) => {
    setIsNewProjectOpen(false);
    const project: OverleafProject = {
      id: `local-${Date.now()}`,
      name,
      lastUpdated: new Date().toISOString(),
      owner: 'Me',
      isLocal: true,
      syncStatus: 'offline-only'
    };
    overleafApi.addProject(project);
    handleOpenProject(project, template);
  };

  const handleRestoreVersion = (snapshot: VersionSnapshot) => {
    const file = files.find(f => f.name === snapshot.fileName);
    if (file) {
      setFiles(prev => prev.map(f => f.name === snapshot.fileName ? { ...f, content: snapshot.content, isModified: true } : f));
      setActiveFileId(file.id);
      // Marking it modified is not enough on its own: nothing else writes it
      // through, so a restore the user was happy with existed only in memory
      // until the next compile or sync.
      if (currentProject) queueSave(currentProject.id, snapshot.fileName, snapshot.content);
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

        <NewProjectModal
          isOpen={isNewProjectOpen}
          onClose={() => setIsNewProjectOpen(false)}
          onCreate={handleCreateProject}
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
        onCancelCompile={handleCancelCompile}
        canCancelCompile={canCancelCompile}
        compileStep={compileStep}
        onOpenAuth={() => setIsAuthOpen(true)}
        onLogout={handleLogout}
        isLoggedIn={isLoggedIn}
        onHome={handleGoHome}
        projectName={currentProject?.name || 'Local Project'}
        selectedCompiler={selectedCompiler}
        compilerOptions={compilerOptions}
        onCompilerChange={setSelectedCompiler}
        rootDocument={rootDocument}
        rootDocuments={rootDocuments}
        onRootDocumentChange={handleChooseRoot}
        autoCompile={autoCompile}
        onToggleAutoCompile={handleToggleAutoCompile}
        collapsed={layout.collapsed}
        onTogglePanel={toggle}
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
        {layout.collapsed.files ? (
          <CollapsedRail
            label="Files"
            side="left"
            icon={<PanelLeft size={15} />}
            onExpand={() => show('files')}
          />
        ) : (
          <>
            <FileTree
              files={files}
              activeFileId={activeFileId}
              onSelectFile={setActiveFileId}
              onNewFile={handleNewFile}
              onDeleteFile={handleDeleteFile}
              onOpenFolder={handleOpenFolder}
              currentFolderPath={folderPath}
              width={layout.sidebarWidth}
              assets={assets}
              onAddImage={handleAddImageFile}
              onInsertAsset={path => insertIntoEditor(figureBlock(path))}
              onDeleteAsset={handleDeleteAsset}
            />
            <PaneDivider
              onDrag={resizeSidebar}
              onReset={() => reset('sidebar')}
              title="File list width"
            />
          </>
        )}

        <div className="editor-pdf-split" ref={splitRef}>
          {!layout.collapsed.editor && (
            <div
              className="split-pane"
              style={{
                flex: layout.collapsed.pdf ? '1 1 auto' : `0 0 ${layout.editorRatio * 100}%`
              }}
            >
              <LaTeXEditor
                fileName={activeFile?.name || 'untitled.tex'}
                // Namespaced by project and percent-encoded: two projects each
                // holding a main.tex would otherwise share one Monaco model and
                // one undo stack, and a '#' or '?' in a name would parse as a
                // URI fragment and collide with another file.
                modelPath={`inmemory://zabbleaf/${projectId}/${encodeURIComponent(activeFile?.name || 'untitled.tex')}`}
                content={activeFile?.content || ''}
                onChange={handleContentChange}
                citations={citations}
                labels={labels}
                sources={completionSources}
                revealLine={revealLine}
                insertion={insertion}
                onPasteImage={handlePasteImage}
                wordCount={wordCount}
                onOpenWordDetails={() => openPanel('words')}
              />
            </div>
          )}

          {!layout.collapsed.editor && !layout.collapsed.pdf && (
            <PaneDivider
              onDrag={delta => resizeSplit(delta, splitRef.current?.clientWidth || 0)}
              onReset={() => reset('split')}
              title="Editor and PDF"
            />
          )}

          {!layout.collapsed.pdf && (
            <div className="split-pane" style={{ flex: '1 1 auto' }}>
              <PDFPreview
                compiledUrl={compiledPdfUrl}
                pdfData={compiledPdfData}
                compileLog={compileLog}
                isCompiling={isCompiling}
                isPdf={compiledIsPdf}
                compileStep={compileStep}
                // PDFPreview renders Stop on the mere presence of the callback,
                // so the engines that cannot be stopped must not be given one.
                onCancelCompile={canCancelCompile ? handleCancelCompile : undefined}
                onJumpToError={handleJumpToError}
                onInstallPackage={handleInstallPackage}
                installingPackage={installingPackage}
              />
            </div>
          )}
        </div>

        {layout.collapsed.panel ? (
          <CollapsedRail
            label="Panel"
            side="right"
            icon={<PanelRight size={15} />}
            onExpand={() => show('panel')}
          />
        ) : (
          <>
            <PaneDivider
              onDrag={resizePanel}
              onReset={() => reset('panel')}
              title="Side panel width"
            />
            <SidePanel
              width={layout.panelWidth}
              tab={sidePanelTab}
              onTabChange={setSidePanelTab}
              onClose={() => toggle('panel')}
              snapshots={snapshots}
              onRestore={handleRestoreVersion}
              todos={todos}
              onOpenTodo={handleJumpToError}
              onInsertSymbol={handleInsertSymbol}
              fileName={activeFile?.name || 'untitled.tex'}
              wordCount={wordCount}
              sections={sections}
              projectWords={projectWords}
              onJumpToLine={line => setRevealLine({ line, nonce: Date.now() })}
              writing={writingSummary}
            />
          </>
        )}
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

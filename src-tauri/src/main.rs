// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Backend for ZabbLeaf's Overleaf Git integration.
//!
//! Everything git- and disk-related lives here instead of in the webview:
//! the frontend used to drive `git` through the shell allowlist and touch files
//! through the scoped `fs` API, which made failures silent and directory walks
//! non-recursive. Running it in Rust gives us real errors, recursive reads and
//! full control over the environment `git` is spawned with.
//!
//! Projects live in `~/.zabbleaf/projects/<projectId>/`.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Keeps a console window from flashing up for every `git` invocation.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Anything bigger than this is not something the editor should try to open.
const MAX_TEXT_FILE_BYTES: u64 = 4 * 1024 * 1024;

/// Extensions we consider editable text in a LaTeX project.
const TEXT_EXTENSIONS: &[&str] = &[
    "tex", "bib", "cls", "sty", "bst", "txt", "md", "markdown", "cfg", "def", "ltx", "dtx", "ins",
    "csv", "tsv", "json", "yml", "yaml", "toml", "rnw", "rmd", "clo", "lco", "ist",
];

#[derive(serde::Serialize)]
struct GitOutcome {
    success: bool,
    message: String,
    code: i32,
    stdout: String,
    stderr: String,
}

impl GitOutcome {
    fn ok(message: impl Into<String>) -> Self {
        GitOutcome {
            success: true,
            message: message.into(),
            code: 0,
            stdout: String::new(),
            stderr: String::new(),
        }
    }
}

#[derive(serde::Serialize)]
struct ProjectFile {
    name: String,
    content: String,
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .ok_or_else(|| "Could not determine the home directory.".to_string())
}

fn projects_root() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".zabbleaf").join("projects"))
}

/// LaTeX writes a pile of .aux/.log/.out files next to the sources. Keeping them
/// out of the cloned repository is what stops `git add -A` from pushing build
/// artifacts to the user's Overleaf project.
fn build_root() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".zabbleaf").join("build"))
}

fn build_dir(project_id: &str) -> Result<PathBuf, String> {
    Ok(build_root()?.join(sanitize_project_id(project_id)?))
}

/// Project ids come from user-pasted URLs, so they must never be able to escape
/// the projects root.
fn sanitize_project_id(project_id: &str) -> Result<String, String> {
    let id = project_id.trim();
    if id.is_empty() {
        return Err("Missing project id.".to_string());
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("Invalid project id: {}", id));
    }
    Ok(id.to_string())
}

fn project_dir(project_id: &str) -> Result<PathBuf, String> {
    Ok(projects_root()?.join(sanitize_project_id(project_id)?))
}

/// Joins a project-relative path, refusing anything that would climb out.
fn safe_join(base: &Path, rel_path: &str) -> Result<PathBuf, String> {
    let normalized = rel_path.replace('\\', "/");
    let mut out = base.to_path_buf();
    for part in normalized.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." || part.contains(':') {
            return Err(format!("Invalid file path: {}", rel_path));
        }
        out.push(part);
    }
    if out == base {
        return Err(format!("Invalid file path: {}", rel_path));
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}

/// Strips any `user:pass@` already present so we never stack credentials.
fn clean_url(git_url: &str) -> Result<String, String> {
    let rest = git_url
        .strip_prefix("https://")
        .ok_or_else(|| format!("Only https:// git URLs are supported (got {})", git_url))?;
    let (authority, path) = match rest.find('/') {
        Some(idx) => (&rest[..idx], &rest[idx..]),
        None => (rest, ""),
    };
    let host = match authority.rfind('@') {
        Some(idx) => &authority[idx + 1..],
        None => authority,
    };
    Ok(format!("https://{}{}", host, path))
}

/// Overleaf's git bridge authenticates with `git` as the username and the
/// generated token as the password.
fn auth_url(git_url: &str, token: &str) -> Result<String, String> {
    if token.trim().is_empty() {
        return Err("Missing Overleaf git token.".to_string());
    }
    let clean = clean_url(git_url)?;
    let rest = clean.strip_prefix("https://").unwrap_or(&clean);
    Ok(format!("https://git:{}@{}", percent_encode(token.trim()), rest))
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

fn redact(text: &str, secret: &str) -> String {
    let secret = secret.trim();
    if secret.is_empty() {
        return text.to_string();
    }
    text.replace(secret, "***")
        .replace(&percent_encode(secret), "***")
}

/// Where Git for Windows lands. A freshly installed git is not on the PATH of an
/// already-running process, and on macOS a Finder-launched app never sees the
/// shell's PATH at all — so look in the usual places before giving up.
fn git_search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();

    #[cfg(windows)]
    {
        for var in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
            if let Some(base) = std::env::var_os(var) {
                let root = PathBuf::from(base);
                dirs.push(root.join("Git").join("cmd"));
                dirs.push(root.join("Programs").join("Git").join("cmd"));
            }
        }
    }

    #[cfg(not(windows))]
    {
        for base in ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"] {
            dirs.push(PathBuf::from(base));
        }
    }

    dirs
}

/// Cached because run_git is called several times per sync, but invalidatable:
/// installing git mid-session has to be able to change the answer.
static GIT_PROGRAM: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

fn resolve_git_program() -> String {
    if matches!(
        run_tool("git", &["--version".to_string()], &std::env::temp_dir(), &[]),
        Ok((0, _))
    ) {
        return "git".to_string();
    }
    for dir in git_search_dirs() {
        let candidate = dir.join(engine_file_name("git"));
        if candidate.is_file() {
            return candidate.to_string_lossy().to_string();
        }
    }
    "git".to_string()
}

fn git_program() -> String {
    let mut cached = GIT_PROGRAM.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(program) = cached.as_ref() {
        return program.clone();
    }
    let resolved = resolve_git_program();
    *cached = Some(resolved.clone());
    resolved
}

/// Called after an install, so the next call looks at the disk again.
fn forget_git_program() {
    *GIT_PROGRAM.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

/// Runs git with credential prompting completely disabled.
///
/// This is the difference between a bad token failing in a second with a real
/// message and Git Credential Manager silently waiting for input that a webview
/// can never provide.
fn run_git(args: &[String], cwd: Option<&Path>, secret: &str) -> Result<GitOutcome, String> {
    let mut command = Command::new(git_program());
    command
        .arg("-c")
        .arg("credential.helper=")
        .arg("-c")
        .arg("core.askPass=")
        .arg("-c")
        .arg("http.lowSpeedLimit=1000")
        .arg("-c")
        .arg("http.lowSpeedTime=60")
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env_remove("GIT_ASKPASS")
        .env_remove("SSH_ASKPASS");

    if let Some(dir) = cwd {
        command.current_dir(dir);
    }

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let output = command.output().map_err(|e| {
        format!(
            "Could not run git: {}. Make sure git is installed and on your PATH.",
            e
        )
    })?;

    let stdout = redact(&String::from_utf8_lossy(&output.stdout), secret);
    let stderr = redact(&String::from_utf8_lossy(&output.stderr), secret);
    let code = output.status.code().unwrap_or(-1);

    Ok(GitOutcome {
        success: code == 0,
        message: if code == 0 {
            String::new()
        } else {
            friendly_error(&stderr, &stdout)
        },
        code,
        stdout,
        stderr,
    })
}

/// Turns git's stderr into something a user can act on.
fn friendly_error(stderr: &str, stdout: &str) -> String {
    let combined = format!("{}\n{}", stderr, stdout);
    let lower = combined.to_lowercase();

    if lower.contains("authentication failed")
        || lower.contains("could not read username")
        || lower.contains("could not read password")
        || lower.contains("invalid username or password")
    {
        return "Authentication failed. Generate a fresh Git token in Overleaf \
                (Account Settings > Git Integration) and paste it again."
            .to_string();
    }
    if lower.contains("no git access") {
        return "No Git access to this project. Check the project URL, and make sure \
                this Overleaf account can open the project."
            .to_string();
    }
    // git phrases this as "repository '<url>' not found", so the words are not
    // adjacent — match them separately.
    if (lower.contains("repository") && lower.contains("not found"))
        || lower.contains("project does not exist")
        || lower.contains("404")
    {
        return "Project not found. Check the project URL and that this Overleaf \
                account has access to it."
            .to_string();
    }
    if lower.contains("could not resolve host") || lower.contains("failed to connect") {
        return "Cannot reach git.overleaf.com. Check your internet connection.".to_string();
    }
    if lower.contains("premium feature") || lower.contains("upgrade") {
        return "Overleaf reports that Git integration is not enabled for this account."
            .to_string();
    }
    if lower.contains("conflict") || lower.contains("could not apply") {
        // Pointing at Overleaf would be misleading: the local commit still
        // conflicts on the next rebase, so the conflict has to be settled in the
        // project folder, which is an ordinary git repository.
        return "Overleaf changed the same lines you did. Nothing was lost — your local \
                commit is intact and the rebase was undone. Resolve the conflict in the \
                project folder with git, then sync again."
            .to_string();
    }

    // Unrecognised failure: show git's own first complaint rather than the whole
    // transcript, which does not fit in a notification.
    combined
        .lines()
        .map(str::trim)
        .find(|line| line.starts_with("fatal:") || line.starts_with("error:"))
        .map(|line| line.to_string())
        .unwrap_or_else(|| {
            let detail = combined.trim();
            if detail.is_empty() {
                "git failed without any output.".to_string()
            } else {
                detail.lines().next().unwrap_or(detail).to_string()
            }
        })
}

fn current_branch(dir: &Path) -> String {
    run_git(
        &["rev-parse".to_string(), "--abbrev-ref".to_string(), "HEAD".to_string()],
        Some(dir),
        "",
    )
    .ok()
    .filter(|out| out.success)
    .map(|out| out.stdout.trim().to_string())
    .filter(|branch| !branch.is_empty() && branch != "HEAD")
    .unwrap_or_else(|| "master".to_string())
}

/// True when a remote URL still carries `user:password@` in front of the host.
///
/// `run_git` redacts the token out of its own output, so the verification below
/// can never see the secret itself — it has to look for the userinfo instead,
/// which survives redaction as `https://git:***@…`.
fn remote_needs_cleaning(url: &str) -> bool {
    match url.strip_prefix("https://") {
        Some(rest) => rest.split('/').next().unwrap_or(rest).contains('@'),
        None => false,
    }
}

/// Puts the tokenless URL back on `origin` and checks that it stuck.
///
/// Returning a bool rather than swallowing the result is the point: a `?`
/// between the authenticated set-url and the restore used to return straight
/// out of the command and leave the plaintext Overleaf token in .git/config,
/// where it survived Sign out while the user was told it had been removed from
/// this computer.
fn clear_remote_credentials(dir: &Path, clean: &str, secret: &str) -> bool {
    for _ in 0..2 {
        let _ = run_git(
            &[
                "remote".to_string(),
                "set-url".to_string(),
                "origin".to_string(),
                clean.to_string(),
            ],
            Some(dir),
            secret,
        );
        match run_git(
            &[
                "remote".to_string(),
                "get-url".to_string(),
                "origin".to_string(),
            ],
            Some(dir),
            secret,
        ) {
            Ok(out) if out.success && !remote_needs_cleaning(out.stdout.trim()) => return true,
            _ => continue,
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Getting off the GTK main loop
// ---------------------------------------------------------------------------

/// Moves a command body onto the blocking pool.
///
/// A plain `#[tauri::command] fn` is called inline on the GTK main loop, so a
/// pdflatex run of 0.4-8.7 seconds was 0.4-8.7 seconds in which WebKitGTK could
/// not present a frame or answer the compositor's ping — which is what the user
/// saw as the window freezing. Only the reply comes back through the event
/// loop, and Tauri serialises that reply on the async runtime too.
async fn offload<T, F>(work: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    // `JoinHandle<T>` resolves to `tauri::Result<T>`, so the join error is
    // unwrapped here and the tail is already the command's own Result.
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| format!("Background work did not finish: {}", e))?
}

/// One lock per project, handed out on demand.
///
/// These commands used to serialise for free by all running on the GTK main
/// thread. On the blocking pool a `pull --rebase` can interleave with a write of
/// the same file and lose an edit, so repository work now takes a per-project
/// lock instead of relying on an accident of the event loop.
#[derive(Default, Clone)]
struct RepoLocks(Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>);

impl RepoLocks {
    fn for_project(&self, project_id: &str) -> Arc<Mutex<()>> {
        let mut locks = self.0.lock().unwrap_or_else(|e| e.into_inner());
        Arc::clone(
            locks
                .entry(project_id.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(()))),
        )
    }
}

/// Runs `work` holding the project's repository lock.
///
/// A poisoned lock is recovered rather than propagated: a panic in one command
/// must not make every later sync of that project fail.
fn with_repo<T>(
    repos: &RepoLocks,
    project_id: &str,
    work: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let lock = repos.for_project(project_id);
    let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
    work()
}

/// Makes a running compile killable from a thread other than the one waiting on
/// it: Stop arrives as its own command, and a newer compile has to end the one
/// already running rather than queue behind it and fight over the same .aux.
#[derive(Default, Clone)]
struct CompileRegistry(Arc<Mutex<RegistryState>>);

#[derive(Default)]
struct RegistryState {
    running: HashMap<String, RunningCompile>,
    /// Stops that arrived while the compile they were aimed at was still being
    /// prepared, so there was no slot to raise the flag on. See
    /// `pending_cancel_applies`.
    pending_cancels: HashMap<String, Instant>,
}

/// How long a Stop that found nothing running stays armed for a compile that is
/// still starting up.
///
/// Long enough to cover the frontend's file flush parking on the repository lock
/// behind a sync, short enough that a Stop which merely raced the end of a run
/// cannot silently kill the next compile the user asks for.
const PENDING_CANCEL_WINDOW: Duration = Duration::from_secs(10);

/// Whether a Stop with nothing to stop still applies to a compile registering now.
///
/// The Stop button is on screen from the moment the frontend starts flushing the
/// editor to disk, which is seconds before `compile_project` reaches `begin` when
/// a sync is holding the repository lock. Without this the click was a silent
/// no-op and the compile the user stopped ran to completion anyway.
fn pending_cancel_applies(requested: Instant, now: Instant) -> bool {
    now.saturating_duration_since(requested) < PENDING_CANCEL_WINDOW
}

struct RunningCompile {
    generation: u64,
    cancelled: Arc<AtomicBool>,
    child: Option<Arc<Mutex<Child>>>,
}

/// Held by the thread running the compile. Dropping it frees the slot, but only
/// while the slot is still this run's: a finished run that cleared a newer run's
/// slot would make the next Stop kill nothing.
struct CompileTicket {
    registry: CompileRegistry,
    project_id: String,
    generation: u64,
    cancelled: Arc<AtomicBool>,
}

/// Process-wide, so two projects compiling at once cannot be handed the same
/// generation and clear each other's slots.
static COMPILE_GENERATION: AtomicU64 = AtomicU64::new(0);

impl CompileRegistry {
    fn begin(&self, project_id: &str) -> CompileTicket {
        let generation = COMPILE_GENERATION.fetch_add(1, Ordering::Relaxed) + 1;

        let mut slots = self.0.lock().unwrap_or_else(|e| e.into_inner());
        Self::cancel_running(&mut slots, project_id);

        // A Stop pressed before this run had a slot belongs to this run: it is
        // taken over here rather than left to expire, so the engine is never
        // started for a compile the user already stopped. Removing it either way
        // keeps a stale flag from reaching a later compile.
        let stopped_before_it_started = slots
            .pending_cancels
            .remove(project_id)
            .map_or(false, |at| pending_cancel_applies(at, Instant::now()));
        let cancelled = Arc::new(AtomicBool::new(stopped_before_it_started));

        slots.running.insert(
            project_id.to_string(),
            RunningCompile {
                generation,
                cancelled: Arc::clone(&cancelled),
                child: None,
            },
        );

        CompileTicket {
            registry: self.clone(),
            project_id: project_id.to_string(),
            generation,
            cancelled,
        }
    }

    /// Raises the flag first and kills second, so the waiting thread can never
    /// read a child we killed on purpose back as an ordinary engine failure.
    /// False means nothing was running.
    ///
    /// This is the form sync and delete use: they only need the working tree to
    /// themselves, so a project with nothing compiling is already what they
    /// wanted and must not leave a Stop armed for the next compile.
    fn cancel(&self, project_id: &str) -> bool {
        let mut slots = self.0.lock().unwrap_or_else(|e| e.into_inner());
        Self::cancel_running(&mut slots, project_id)
    }

    /// The user's Stop, which unlike `cancel` is remembered when it finds
    /// nothing: "nothing running" also covers a compile that has not finished
    /// registering yet, and that Stop used to vanish. Still returns false there,
    /// so the frontend can tell "stopped it" from "there was nothing".
    fn stop(&self, project_id: &str) -> bool {
        let mut slots = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if Self::cancel_running(&mut slots, project_id) {
            return true;
        }
        // Armed under the same lock `begin` takes, so a compile registering at
        // this moment either sees the flag or was already killed above.
        slots
            .pending_cancels
            .insert(project_id.to_string(), Instant::now());
        false
    }

    fn cancel_running(slots: &mut RegistryState, project_id: &str) -> bool {
        match slots.running.get_mut(project_id) {
            Some(running) => {
                running.cancelled.store(true, Ordering::SeqCst);
                if let Some(child) = running.child.take() {
                    kill_child(&child);
                }
                true
            }
            None => false,
        }
    }
}

impl CompileTicket {
    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    fn set_child(&self, child: &Arc<Mutex<Child>>) {
        let mut slots = self.registry.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(running) = slots.running.get_mut(&self.project_id) {
            if running.generation == self.generation {
                running.child = Some(Arc::clone(child));
            }
        }
    }

    fn clear_child(&self) {
        let mut slots = self.registry.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(running) = slots.running.get_mut(&self.project_id) {
            if running.generation == self.generation {
                running.child = None;
            }
        }
    }
}

impl Drop for CompileTicket {
    fn drop(&mut self) {
        let mut slots = self.registry.0.lock().unwrap_or_else(|e| e.into_inner());
        if slots
            .running
            .get(&self.project_id)
            .map_or(false, |running| running.generation == self.generation)
        {
            slots.running.remove(&self.project_id);
        }
    }
}

/// Kill and reap. Without the `wait()` the dead engine stays a zombie for the
/// life of the app, and on Windows the process handle is not released.
fn kill_child(child: &Arc<Mutex<Child>>) {
    let mut held = child.lock().unwrap_or_else(|e| e.into_inner());
    let _ = held.kill();
    let _ = held.wait();
}

/// Stops whatever is compiling for this project. Returns false when nothing was
/// running, so the frontend can tell "stopped it" from "there was nothing".
///
/// `user_initiated` picks which of the two forms to use, because only a real
/// Stop click may leave an arming behind. Leaving a project also calls this, to
/// release the repo lock the next project needs; routing that through `stop`
/// armed a cancel that the same project's next compile then consumed, so
/// switching away and back produced no PDF, no log and no error at all.
#[tauri::command]
async fn zl_cancel_compile(
    project_id: String,
    user_initiated: bool,
    compiles: tauri::State<'_, CompileRegistry>,
) -> Result<bool, String> {
    // Microseconds of work under a mutex, so this deliberately does not go to
    // the blocking pool: Stop has to beat the compile it is stopping.
    let id = sanitize_project_id(&project_id)?;
    Ok(if user_initiated {
        compiles.stop(&id)
    } else {
        compiles.cancel(&id)
    })
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn zl_git_available() -> Result<String, String> {
    let out = run_git(&["--version".to_string()], None, "")?;
    if out.success {
        Ok(out.stdout.trim().to_string())
    } else {
        Err("git is not available on this system.".to_string())
    }
}

#[tauri::command]
fn zl_projects_root() -> Result<String, String> {
    let root = projects_root()?;
    fs::create_dir_all(&root)
        .map_err(|e| format!("Cannot create {}: {}", root.display(), e))?;
    Ok(root.to_string_lossy().to_string())
}

/// True only for a directory that actually holds a git repository, so a leftover
/// empty folder from a failed clone never looks like a downloaded project.
#[tauri::command]
fn zl_project_exists(project_id: String) -> Result<bool, String> {
    Ok(project_dir(&project_id)?.join(".git").is_dir())
}

/// Keeps compiler byproducts out of the user's Overleaf project.
///
/// `-output-directory` redirects most of them, but epstopdf ignores it and
/// writes `<figure>-eps-converted-to.pdf` next to the source. Those would be
/// committed and pushed on the next sync. `.git/info/exclude` is the right
/// place for this: it is local-only and never travels to Overleaf, unlike a
/// .gitignore, which would show up in the user's project.
fn write_local_excludes(dir: &Path) {
    let info = dir.join(".git").join("info");
    if fs::create_dir_all(&info).is_err() {
        return;
    }

    let path = info.join("exclude");
    let existing = fs::read_to_string(&path).unwrap_or_default();
    if existing.contains("eps-converted-to") {
        return;
    }

    let rules = [
        "",
        "# Added by ZabbLeaf: LaTeX byproducts that must not reach Overleaf.",
        "*-eps-converted-to.pdf",
        "*.synctex.gz",
        "*.fls",
        "*.fdb_latexmk",
        "",
    ]
    .join("\n");

    let _ = fs::write(&path, format!("{}{}", existing, rules));
}

#[tauri::command]
async fn zl_clone_project(
    project_id: String,
    git_url: String,
    token: String,
    repos: tauri::State<'_, RepoLocks>,
) -> Result<GitOutcome, String> {
    // `State` is a borrow of managed state and cannot cross the spawn; the
    // inner handle is an Arc, so it is cloned out first.
    let repos = repos.inner().clone();
    offload(move || clone_project(project_id, git_url, token, repos)).await
}

fn clone_project(
    project_id: String,
    git_url: String,
    token: String,
    repos: RepoLocks,
) -> Result<GitOutcome, String> {
    let id = sanitize_project_id(&project_id)?;
    with_repo(&repos, &id, || clone_project_locked(&project_id, &git_url, &token))
}

fn clone_project_locked(
    project_id: &str,
    git_url: &str,
    token: &str,
) -> Result<GitOutcome, String> {
    let root = projects_root()?;
    fs::create_dir_all(&root).map_err(|e| format!("Cannot create {}: {}", root.display(), e))?;

    let dir = project_dir(project_id)?;

    if dir.join(".git").is_dir() {
        return Ok(GitOutcome::ok("Project is already downloaded."));
    }
    // A partially written directory would make `git clone` bail out with
    // "destination path already exists".
    if dir.exists() {
        fs::remove_dir_all(&dir)
            .map_err(|e| format!("Cannot clear {}: {}", dir.display(), e))?;
    }

    let clean = clean_url(git_url)?;
    let authenticated = auth_url(git_url, token)?;

    // Full clone, not shallow: Overleaf rejects pushes from shallow clones and
    // these projects are small.
    let outcome = run_git(
        &[
            "clone".to_string(),
            authenticated,
            dir.to_string_lossy().to_string(),
        ],
        Some(&root),
        token,
    )?;

    // `git clone` writes the authenticated URL into .git/config before it
    // fetches, so a clone that fails *after* creating the repository leaves the
    // plaintext token there exactly as a successful one does — "Clone succeeded,
    // but checkout failed" (exit 128) on a name the filesystem rejects, a full
    // disk, or the app killed mid-clone. Purging only on success left that token
    // on disk for good: the retry sees .git and returns "already downloaded", so
    // nothing ever revisits it, and Sign out only clears localStorage.
    if dir.join(".git").is_dir() && !clear_remote_credentials(&dir, &clean, token) {
        // Nothing of the user's is in a fresh clone, so throwing it away costs
        // them nothing and is far better than leaving a plaintext Overleaf token
        // on disk. Whether that actually worked decides what the user is told.
        let removal = fs::remove_dir_all(&dir).err().map(|e| e.to_string());
        return Err(discarded_clone_message(&dir, removal.as_deref()));
    }

    if outcome.success {
        write_local_excludes(&dir);
        return Ok(GitOutcome::ok("Project downloaded from Overleaf."));
    }

    // Leave nothing behind that would confuse the next attempt: a half-cloned
    // repository still has a .git, which `zl_project_exists` reports as a
    // downloaded project and which makes the retry return "already downloaded"
    // over a tree that was never checked out.
    if dir.exists() {
        if let Err(e) = fs::remove_dir_all(&dir) {
            return Ok(GitOutcome {
                success: false,
                message: format!(
                    "{} The incomplete download in {} could not be removed ({}); \
                     delete that folder before trying again.",
                    outcome.message,
                    dir.display(),
                    e
                ),
                ..outcome
            });
        }
    }
    Ok(outcome)
}

/// What to tell the user when the token could not be scrubbed out of a fresh
/// clone's .git/config.
///
/// The old wording said the download "was discarded" whatever happened to
/// `remove_dir_all`, so on Windows — where an antivirus or indexer holding a
/// file open is the likeliest reason the scrub failed in the first place — the
/// user was told the token-bearing directory was gone while it was still there.
fn discarded_clone_message(dir: &Path, removal_error: Option<&str>) -> String {
    match removal_error {
        None => format!(
            "Could not remove your Overleaf token from the downloaded project's git \
             configuration, so the download was discarded. Check the permissions on {} \
             and try again.",
            dir.display()
        ),
        Some(error) => format!(
            "Could not remove your Overleaf token from the downloaded project's git \
             configuration, and the download could not be deleted either ({}). Your \
             Overleaf token is still in {}: delete that folder, then generate a fresh \
             token on Overleaf.",
            error,
            dir.join(".git").join("config").display()
        ),
    }
}

#[tauri::command]
async fn zl_sync_project(
    project_id: String,
    git_url: String,
    token: String,
    email: String,
    message: String,
    compiles: tauri::State<'_, CompileRegistry>,
    repos: tauri::State<'_, RepoLocks>,
) -> Result<GitOutcome, String> {
    let compiles = compiles.inner().clone();
    let repos = repos.inner().clone();
    offload(move || sync_project(project_id, git_url, token, email, message, compiles, repos)).await
}

fn sync_project(
    project_id: String,
    git_url: String,
    token: String,
    email: String,
    message: String,
    compiles: CompileRegistry,
    repos: RepoLocks,
) -> Result<GitOutcome, String> {
    let id = sanitize_project_id(&project_id)?;
    // A rebase must never rewrite the working tree while an engine is reading
    // it, and killing the engine is cheaper than making Sync wait minutes for a
    // compile to finish.
    compiles.cancel(&id);
    with_repo(&repos, &id, || {
        sync_project_locked(&project_id, &git_url, &token, &email, &message)
    })
}

fn sync_project_locked(
    project_id: &str,
    git_url: &str,
    token: &str,
    email: &str,
    message: &str,
) -> Result<GitOutcome, String> {
    let dir = project_dir(project_id)?;
    if !dir.join(".git").is_dir() {
        // Either a project created locally (never linked to Overleaf) or one
        // whose local copy went missing. Both are recoverable, so say what is
        // actually wrong rather than blaming a download.
        return Err(
            "This project is not linked to an Overleaf project, so there is nothing to sync with."
                .to_string(),
        );
    }

    // Applied here too, so projects cloned before this existed are covered.
    write_local_excludes(&dir);

    let clean = clean_url(git_url)?;
    let authenticated_url = auth_url(git_url, token)?;
    let branch = current_branch(&dir);

    // Everything that runs while the token is on `origin` lives in here, so that
    // the `?` on a run_git that cannot even start git — removed mid-session, a
    // stale cached GIT_PROGRAM, a fork failure under memory pressure — leaves
    // through the cleanup below instead of returning straight out of the
    // command with the token still in .git/config.
    // Records the moment the token actually reaches .git/config, so the cleanup
    // below can tell a stranded token from a git that never started. A later
    // run_git can fail to spawn just as the first one can, and by then the URL
    // is already on disk.
    let token_written = std::cell::Cell::new(false);

    let authenticated = || -> Result<GitOutcome, String> {
        let set_remote = run_git(
            &[
                "remote".to_string(),
                "set-url".to_string(),
                "origin".to_string(),
                authenticated_url.clone(),
            ],
            Some(&dir),
            token,
        )?;
        if !set_remote.success {
            return Ok(set_remote);
        }
        token_written.set(true);

        let _ = run_git(&["add".to_string(), "-A".to_string()], Some(&dir), token)?;

        let status = run_git(
            &["status".to_string(), "--porcelain".to_string()],
            Some(&dir),
            token,
        )?;
        // A failing `git status` returns empty stdout, which used to read as
        // "nothing to commit": the user's edits were never committed while the
        // pull and the push went ahead regardless.
        if !status.success {
            return Ok(status);
        }

        if !status.stdout.trim().is_empty() {
            let author = if email.trim().is_empty() {
                "zabbleaf@localhost".to_string()
            } else {
                email.trim().to_string()
            };
            let name = author.split('@').next().unwrap_or("ZabbLeaf").to_string();
            let commit_message = if message.trim().is_empty() {
                "ZabbLeaf offline sync".to_string()
            } else {
                message.trim().to_string()
            };

            let commit = run_git(
                &[
                    "-c".to_string(),
                    format!("user.name={}", name),
                    "-c".to_string(),
                    format!("user.email={}", author),
                    "commit".to_string(),
                    "-m".to_string(),
                    commit_message,
                ],
                Some(&dir),
                token,
            )?;
            if !commit.success {
                return Ok(commit);
            }
        }

        let pull = run_git(
            &[
                "pull".to_string(),
                "--rebase".to_string(),
                "origin".to_string(),
                branch.clone(),
            ],
            Some(&dir),
            token,
        )?;
        if !pull.success {
            // Never leave the repo mid-rebase.
            let _ = run_git(
                &["rebase".to_string(), "--abort".to_string()],
                Some(&dir),
                token,
            );
            return Ok(pull);
        }

        let push = run_git(
            &["push".to_string(), "origin".to_string(), branch.clone()],
            Some(&dir),
            token,
        )?;
        if push.success {
            Ok(GitOutcome::ok("Synced with Overleaf."))
        } else {
            Ok(push)
        }
    };

    let result = authenticated();

    // Unconditional, and its failure outranks whatever the sync itself reported:
    // a token left on disk is the worse outcome. Nothing is deleted here — the
    // local commit is the user's work — so name the file they have to fix.
    if !clear_remote_credentials(&dir, &clean, token) {
        return Err(sync_cleanup_error(
            result.err(),
            token_written.get(),
            &dir.join(".git").join("config"),
        ));
    }

    result
}

/// The error to report when the token could not be scrubbed from .git/config.
///
/// Which message is right turns on whether the token ever reached the file, not
/// on whether the sync failed. `run_git` Errs only when git could not be started
/// at all, which is also the one thing that stops the scrub running — but that
/// can happen to any call in the sequence, not just the first. Deciding from the
/// error alone was wrong in both directions: it blamed the config file's
/// permissions for a missing git before the URL was ever set, and it stayed
/// silent about a token genuinely stranded on disk when git vanished mid-sync.
fn sync_cleanup_error(sync_error: Option<String>, token_written: bool, config: &Path) -> String {
    match (token_written, sync_error) {
        // Nothing was ever written, so the sync's own failure is the whole story.
        (false, Some(cause)) => cause,
        // The token is on disk. Say so first — it outranks the sync outcome —
        // but keep the cause, which is usually what explains the scrub failing.
        (_, cause) => {
            let warning = format!(
                "Could not remove your Overleaf token from {}. Your changes are committed \
                 locally and nothing was lost, but that file still holds the token: delete \
                 it or rotate the token on Overleaf before syncing again.",
                config.display()
            );
            match cause {
                Some(cause) => format!("{}\n\n{}", warning, cause),
                None => warning,
            }
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectChanges {
    /// Porcelain status lines, one per changed file.
    files: Vec<String>,
    /// Unified diff, so the user can see what a sync would publish.
    diff: String,
}

/// Shows what a sync would push, before it pushes it.
#[tauri::command]
async fn zl_project_changes(
    project_id: String,
    repos: tauri::State<'_, RepoLocks>,
) -> Result<ProjectChanges, String> {
    let repos = repos.inner().clone();
    offload(move || project_changes(project_id, repos)).await
}

fn project_changes(project_id: String, repos: RepoLocks) -> Result<ProjectChanges, String> {
    let id = sanitize_project_id(&project_id)?;
    with_repo(&repos, &id, || project_changes_locked(&project_id))
}

fn project_changes_locked(project_id: &str) -> Result<ProjectChanges, String> {
    let dir = project_dir(project_id)?;
    if !dir.join(".git").is_dir() {
        return Err("This project is not linked to an Overleaf project.".to_string());
    }

    // Intent-to-add records new files without staging their content, which is
    // what makes them appear in the diff below.
    let _ = run_git(
        &["add".to_string(), "-A".to_string(), "-N".to_string()],
        Some(&dir),
        "",
    );

    let status = run_git(
        &["status".to_string(), "--porcelain".to_string()],
        Some(&dir),
        "",
    )?;
    let diff = run_git(&["diff".to_string(), "HEAD".to_string()], Some(&dir), "")?;

    Ok(ProjectChanges {
        files: status
            .stdout
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect(),
        diff: diff.stdout,
    })
}

#[tauri::command]
async fn zl_read_project_files(
    project_id: String,
    repos: tauri::State<'_, RepoLocks>,
) -> Result<Vec<ProjectFile>, String> {
    let repos = repos.inner().clone();
    offload(move || read_project_files(project_id, repos)).await
}

fn read_project_files(project_id: String, repos: RepoLocks) -> Result<Vec<ProjectFile>, String> {
    let id = sanitize_project_id(&project_id)?;
    with_repo(&repos, &id, || {
        let dir = project_dir(&project_id)?;
        let mut files: Vec<ProjectFile> = Vec::new();
        if !dir.is_dir() {
            return Ok(files);
        }

        collect_files(&dir, &dir, &mut files)?;
        files.sort_by(|a, b| sort_rank(&a.name).cmp(&sort_rank(&b.name)).then(a.name.cmp(&b.name)));
        Ok(files)
    })
}

/// `main.tex` first, then the rest of the LaTeX sources, then everything else.
fn sort_rank(name: &str) -> u8 {
    let lower = name.to_lowercase();
    if lower == "main.tex" {
        0
    } else if lower.ends_with(".tex") {
        1
    } else {
        2
    }
}

fn is_text_file(path: &Path) -> bool {
    path.extension()
        .map(|ext| {
            let ext = ext.to_string_lossy().to_lowercase();
            TEXT_EXTENSIONS.iter().any(|known| *known == ext)
        })
        .unwrap_or(false)
}

fn collect_files(root: &Path, dir: &Path, out: &mut Vec<ProjectFile>) -> Result<(), String> {
    let entries =
        fs::read_dir(dir).map_err(|e| format!("Cannot read {}: {}", dir.display(), e))?;

    for entry in entries {
        // One unreadable entry — a dangling symlink, a file the OS refused to
        // stat, a file being rewritten at that instant — used to fail the whole
        // recursion, and an empty read is what made the app offer a blank
        // starter over a project that was really there. Skip the entry instead;
        // the read_dir on the project root above stays fatal, so a genuinely
        // unreadable project is still reported.
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let file_name = entry.file_name().to_string_lossy().to_string();
        // Skips .git and other dotfiles.
        if file_name.starts_with('.') {
            continue;
        }

        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };

        if file_type.is_dir() {
            let _ = collect_files(root, &path, out);
        } else if file_type.is_file() && is_text_file(&path) {
            if entry.metadata().map(|m| m.len()).unwrap_or(0) > MAX_TEXT_FILE_BYTES {
                continue;
            }
            let bytes = match fs::read(&path) {
                Ok(bytes) => bytes,
                Err(_) => continue,
            };
            let relative = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            out.push(ProjectFile {
                name: relative,
                content: String::from_utf8_lossy(&bytes).to_string(),
            });
        }
    }
    Ok(())
}

/// Distinguishes the scratch files of two saves that overlap in time.
static SAVE_SEQ: AtomicU64 = AtomicU64::new(0);

/// Flattened so a nested source path cannot create directories inside the build
/// folder, and sequenced so two saves of the same file that overlap cannot
/// rename each other's half-written content into place.
fn scratch_file_name(rel_path: &str, seq: u64) -> String {
    let flat: String = rel_path
        .chars()
        .map(|c| {
            if c == '/' || c == '\\' || c == ':' {
                '_'
            } else {
                c
            }
        })
        .collect();
    format!("{}.{}.zabbleaf-save", flat, seq)
}

/// Writes through a scratch file and a rename.
///
/// `queueSave` writes on a 400 ms debounce all day and `fs::write` truncates
/// before it writes, so a crash or a power loss in the middle left the user's
/// chapter at zero bytes. The scratch file lives in the build directory, which
/// is deliberately outside the repository, so a crash can never leave it
/// somewhere `git add -A` would push it to Overleaf.
fn write_atomically(
    project_id: &str,
    rel_path: &str,
    target: &Path,
    content: &str,
) -> Result<(), String> {
    if let Ok(scratch_dir) = build_dir(project_id) {
        if fs::create_dir_all(&scratch_dir).is_ok() {
            let seq = SAVE_SEQ.fetch_add(1, Ordering::Relaxed);
            let scratch = scratch_dir.join(scratch_file_name(rel_path, seq));
            if fs::write(&scratch, content).is_ok() && fs::rename(&scratch, target).is_ok() {
                return Ok(());
            }
            let _ = fs::remove_file(&scratch);
        }
    }
    // A rename across filesystems fails, and so does one into a directory the
    // scratch file cannot reach. Today's behaviour is still better than no save.
    fs::write(target, content).map_err(|e| format!("Cannot write {}: {}", target.display(), e))
}

fn write_project_file(
    project_id: String,
    rel_path: String,
    content: String,
    repos: RepoLocks,
) -> Result<(), String> {
    let id = sanitize_project_id(&project_id)?;
    with_repo(&repos, &id, || {
        let dir = project_dir(&project_id)?;
        fs::create_dir_all(&dir).map_err(|e| format!("Cannot create {}: {}", dir.display(), e))?;

        let target = safe_join(&dir, &rel_path)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Cannot create {}: {}", parent.display(), e))?;
        }
        write_atomically(&project_id, &rel_path, &target, &content)
    })
}

#[tauri::command]
async fn zl_write_project_file(
    project_id: String,
    rel_path: String,
    content: String,
    repos: tauri::State<'_, RepoLocks>,
) -> Result<(), String> {
    let repos = repos.inner().clone();
    offload(move || write_project_file(project_id, rel_path, content, repos)).await
}

fn write_new_project_file(
    project_id: String,
    rel_path: String,
    content: String,
    repos: RepoLocks,
) -> Result<bool, String> {
    let id = sanitize_project_id(&project_id)?;
    with_repo(&repos, &id, || {
        let dir = project_dir(&project_id)?;
        fs::create_dir_all(&dir).map_err(|e| format!("Cannot create {}: {}", dir.display(), e))?;

        let target = safe_join(&dir, &rel_path)?;
        if target.exists() {
            return Ok(false);
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Cannot create {}: {}", parent.display(), e))?;
        }
        write_atomically(&project_id, &rel_path, &target, &content)?;
        Ok(true)
    })
}

/// Writes a starter file only if nothing is there, reporting which happened.
///
/// The app offers a blank starter whenever a project reads as empty, and an
/// empty read has causes other than an empty project. A plain write then
/// replaced the user's real main.tex with the template and the next sync pushed
/// that to Overleaf.
#[tauri::command]
async fn zl_write_new_project_file(
    project_id: String,
    rel_path: String,
    content: String,
    repos: tauri::State<'_, RepoLocks>,
) -> Result<bool, String> {
    let repos = repos.inner().clone();
    offload(move || write_new_project_file(project_id, rel_path, content, repos)).await
}

fn delete_project_file(
    project_id: String,
    rel_path: String,
    repos: RepoLocks,
) -> Result<(), String> {
    let id = sanitize_project_id(&project_id)?;
    // The lock is about ordering, not about the removal itself, which is
    // microseconds: writes queue behind it on the blocking pool now, so a delete
    // that skipped it could run ahead of a save issued before it and let that
    // save recreate the file the user just deleted — after which `git add -A`
    // pushes it straight back to Overleaf.
    with_repo(&repos, &id, || {
        let dir = project_dir(&project_id)?;
        let target = safe_join(&dir, &rel_path)?;
        if target.is_file() {
            fs::remove_file(&target)
                .map_err(|e| format!("Cannot delete {}: {}", target.display(), e))?;
        }
        Ok(())
    })
}

/// Removes one file from the project.
///
/// Without this, deleting a file only dropped it from the list: `git add -A`
/// saw no removal, and the file came back the next time the project was opened.
#[tauri::command]
async fn zl_delete_project_file(
    project_id: String,
    rel_path: String,
    repos: tauri::State<'_, RepoLocks>,
) -> Result<(), String> {
    let repos = repos.inner().clone();
    offload(move || delete_project_file(project_id, rel_path, repos)).await
}

#[tauri::command]
async fn zl_delete_project(
    project_id: String,
    compiles: tauri::State<'_, CompileRegistry>,
    repos: tauri::State<'_, RepoLocks>,
) -> Result<(), String> {
    let compiles = compiles.inner().clone();
    let repos = repos.inner().clone();
    offload(move || delete_project(project_id, compiles, repos)).await
}

fn delete_project(
    project_id: String,
    compiles: CompileRegistry,
    repos: RepoLocks,
) -> Result<(), String> {
    let id = sanitize_project_id(&project_id)?;
    // `remove_dir_all` must never run out from under a live engine: on Windows
    // the open source file makes the delete fail outright, and everywhere else
    // the engine carries on writing into a directory that is being removed.
    compiles.cancel(&id);
    with_repo(&repos, &id, || {
        let dir = project_dir(&project_id)?;
        if dir.exists() {
            fs::remove_dir_all(&dir)
                .map_err(|e| format!("Cannot delete {}: {}", dir.display(), e))?;
        }
        Ok(())
    })
}

// ---------------------------------------------------------------------------
// Assets (figures)
// ---------------------------------------------------------------------------

/// Files a LaTeX project carries but the editor cannot open as text. They are
/// invisible to `zl_read_project_files`, which is why pasting a screenshot used
/// to mean leaving the app and copying it in with the file manager.
const ASSET_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "bmp", "webp", "tif", "tiff", "svg", "eps", "pdf",
];

/// Nothing bigger goes into a Git repository without the user meaning it.
const MAX_ASSET_BYTES: u64 = 25 * 1024 * 1024;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectAsset {
    name: String,
    bytes: u64,
}

fn is_asset_file(path: &Path) -> bool {
    path.extension()
        .map(|ext| {
            let ext = ext.to_string_lossy().to_lowercase();
            ASSET_EXTENSIONS.iter().any(|known| *known == ext)
        })
        .unwrap_or(false)
}

fn collect_assets(root: &Path, dir: &Path, out: &mut Vec<ProjectAsset>) -> Result<(), String> {
    let entries =
        fs::read_dir(dir).map_err(|e| format!("Cannot read {}: {}", dir.display(), e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Cannot read {}: {}", dir.display(), e))?;
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }

        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|e| format!("Cannot stat {}: {}", path.display(), e))?;

        if file_type.is_dir() {
            collect_assets(root, &path, out)?;
        } else if file_type.is_file() && is_asset_file(&path) {
            out.push(ProjectAsset {
                name: path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/"),
                bytes: entry.metadata().map(|m| m.len()).unwrap_or(0),
            });
        }
    }
    Ok(())
}

#[tauri::command]
async fn zl_list_project_assets(
    project_id: String,
    repos: tauri::State<'_, RepoLocks>,
) -> Result<Vec<ProjectAsset>, String> {
    let repos = repos.inner().clone();
    offload(move || list_project_assets(project_id, repos)).await
}

fn list_project_assets(project_id: String, repos: RepoLocks) -> Result<Vec<ProjectAsset>, String> {
    let id = sanitize_project_id(&project_id)?;
    with_repo(&repos, &id, || {
        let dir = project_dir(&project_id)?;
        let mut assets = Vec::new();
        if !dir.is_dir() {
            return Ok(assets);
        }
        collect_assets(&dir, &dir, &mut assets)?;
        assets.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(assets)
    })
}

/// Adds `-1`, `-2`, … to a name rather than overwriting a figure that a
/// document may already reference.
fn unique_asset_path(dir: &Path, rel_path: &str) -> Result<(PathBuf, String), String> {
    let candidate = safe_join(dir, rel_path)?;
    if !candidate.exists() {
        return Ok((candidate, rel_path.replace('\\', "/")));
    }

    let normalized = rel_path.replace('\\', "/");
    let (stem, extension) = match normalized.rsplit_once('.') {
        Some((stem, ext)) => (stem.to_string(), format!(".{}", ext)),
        None => (normalized.clone(), String::new()),
    };

    for suffix in 1..1000 {
        let next = format!("{}-{}{}", stem, suffix, extension);
        let path = safe_join(dir, &next)?;
        if !path.exists() {
            return Ok((path, next));
        }
    }
    Err(format!("Too many files named like {}", rel_path))
}

/// Writes a pasted image into the project. Returns the path it actually got,
/// which is what the `\includegraphics` line has to say.
#[tauri::command]
async fn zl_write_project_asset(
    project_id: String,
    rel_path: String,
    base64_data: String,
    repos: tauri::State<'_, RepoLocks>,
) -> Result<String, String> {
    let repos = repos.inner().clone();
    offload(move || write_project_asset(project_id, rel_path, base64_data, repos)).await
}

fn write_project_asset(
    project_id: String,
    rel_path: String,
    base64_data: String,
    repos: RepoLocks,
) -> Result<String, String> {
    let id = sanitize_project_id(&project_id)?;
    with_repo(&repos, &id, || {
        write_project_asset_locked(&project_id, &rel_path, &base64_data)
    })
}

fn write_project_asset_locked(
    project_id: &str,
    rel_path: &str,
    base64_data: &str,
) -> Result<String, String> {
    use base64::Engine as _;

    let dir = project_dir(project_id)?;
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create {}: {}", dir.display(), e))?;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data.trim())
        .map_err(|e| format!("That image could not be decoded: {}", e))?;
    if bytes.len() as u64 > MAX_ASSET_BYTES {
        return Err(format!(
            "That file is {} MB. The limit is {} MB, because it ends up in your Overleaf repository.",
            bytes.len() / (1024 * 1024),
            MAX_ASSET_BYTES / (1024 * 1024)
        ));
    }

    let (target, name) = unique_asset_path(&dir, rel_path)?;
    if !is_asset_file(&target) {
        return Err(format!("{} is not an image ZabbLeaf can store.", rel_path));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Cannot create {}: {}", parent.display(), e))?;
    }
    fs::write(&target, &bytes)
        .map_err(|e| format!("Cannot write {}: {}", target.display(), e))?;
    Ok(name)
}

/// Copies a file dragged in from the desktop. The webview only hands us the
/// path, so the copying has to happen on this side.
#[tauri::command]
async fn zl_import_project_asset(
    project_id: String,
    source_path: String,
    dest_dir: String,
    repos: tauri::State<'_, RepoLocks>,
) -> Result<String, String> {
    let repos = repos.inner().clone();
    offload(move || import_project_asset(project_id, source_path, dest_dir, repos)).await
}

fn import_project_asset(
    project_id: String,
    source_path: String,
    dest_dir: String,
    repos: RepoLocks,
) -> Result<String, String> {
    let id = sanitize_project_id(&project_id)?;
    with_repo(&repos, &id, || {
        import_project_asset_locked(&project_id, &source_path, &dest_dir)
    })
}

fn import_project_asset_locked(
    project_id: &str,
    source_path: &str,
    dest_dir: &str,
) -> Result<String, String> {
    let source = PathBuf::from(source_path);
    if !source.is_file() {
        return Err(format!("{} is not a file.", source_path));
    }
    if !is_asset_file(&source) {
        return Err(format!(
            "{} is not an image. Drop a PNG, JPG, PDF or EPS instead.",
            source
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| source_path.to_string())
        ));
    }
    let size = source.metadata().map(|m| m.len()).unwrap_or(0);
    if size > MAX_ASSET_BYTES {
        return Err(format!(
            "That file is {} MB. The limit is {} MB, because it ends up in your Overleaf repository.",
            size / (1024 * 1024),
            MAX_ASSET_BYTES / (1024 * 1024)
        ));
    }

    let file_name = source
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| "That file has no name.".to_string())?;
    let dir = project_dir(project_id)?;
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create {}: {}", dir.display(), e))?;

    let wanted = if dest_dir.trim().is_empty() {
        file_name
    } else {
        format!("{}/{}", dest_dir.trim_end_matches('/'), file_name)
    };
    let (target, name) = unique_asset_path(&dir, &wanted)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Cannot create {}: {}", parent.display(), e))?;
    }
    fs::copy(&source, &target)
        .map_err(|e| format!("Cannot copy {} into the project: {}", source_path, e))?;
    Ok(name)
}

/// Reads one figure back out, base64 encoded, so the file tree can preview it.
#[tauri::command]
async fn zl_read_project_asset(
    project_id: String,
    rel_path: String,
    repos: tauri::State<'_, RepoLocks>,
) -> Result<String, String> {
    let repos = repos.inner().clone();
    offload(move || read_project_asset(project_id, rel_path, repos)).await
}

fn read_project_asset(
    project_id: String,
    rel_path: String,
    repos: RepoLocks,
) -> Result<String, String> {
    let id = sanitize_project_id(&project_id)?;
    with_repo(&repos, &id, || {
        let dir = project_dir(&project_id)?;
        let target = safe_join(&dir, &rel_path)?;
        if !target.is_file() {
            return Err(format!("{} is not in this project.", rel_path));
        }
        if target.metadata().map(|m| m.len()).unwrap_or(0) > MAX_ASSET_BYTES {
            return Err(format!("{} is too large to preview.", rel_path));
        }
        let bytes =
            fs::read(&target).map_err(|e| format!("Cannot read {}: {}", target.display(), e))?;
        Ok(base64_encode(&bytes))
    })
}

// ---------------------------------------------------------------------------
// Local LaTeX compilation
// ---------------------------------------------------------------------------

const TEX_ENGINES: &[&str] = &["pdflatex", "xelatex", "lualatex"];

#[derive(serde::Serialize)]
struct DetectedEngine {
    engine: String,
    /// What to actually invoke: a bare name when it is on PATH, otherwise an
    /// absolute path.
    path: String,
    version: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallOutcome {
    success: bool,
    message: String,
    log: String,
}

/// Places a TeX distribution commonly lands when it is not on PATH — notably
/// right after installing, when the running process still has the old
/// environment.
fn tex_search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();

    #[cfg(windows)]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            dirs.push(
                PathBuf::from(&local)
                    .join("Programs")
                    .join("MiKTeX")
                    .join("miktex")
                    .join("bin")
                    .join("x64"),
            );
        }
        for base in ["C:\\Program Files\\MiKTeX", "C:\\Program Files (x86)\\MiKTeX"] {
            dirs.push(PathBuf::from(base).join("miktex").join("bin").join("x64"));
        }
        // TeX Live installs one directory per year.
        if let Ok(entries) = fs::read_dir("C:\\texlive") {
            for entry in entries.flatten() {
                dirs.push(entry.path().join("bin").join("windows"));
                dirs.push(entry.path().join("bin").join("win32"));
            }
        }
    }

    #[cfg(not(windows))]
    {
        dirs.push(PathBuf::from("/Library/TeX/texbin"));
        dirs.push(PathBuf::from("/usr/local/texlive/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
        for base in ["/usr/local/texlive", "/opt/texlive"] {
            if let Ok(entries) = fs::read_dir(base) {
                for entry in entries.flatten() {
                    if let Ok(inner) = fs::read_dir(entry.path().join("bin")) {
                        for arch in inner.flatten() {
                            dirs.push(arch.path());
                        }
                    }
                }
            }
        }
    }

    dirs
}

fn engine_file_name(engine: &str) -> String {
    if cfg!(windows) {
        format!("{}.exe", engine)
    } else {
        engine.to_string()
    }
}

/// Returns the command to invoke for an engine, plus its version banner.
fn resolve_engine(engine: &str) -> Option<(String, String)> {
    let mut candidates: Vec<String> = vec![engine.to_string()];
    for dir in tex_search_dirs() {
        let candidate = dir.join(engine_file_name(engine));
        if candidate.is_file() {
            candidates.push(candidate.to_string_lossy().to_string());
        }
    }

    for candidate in candidates {
        if let Ok((0, output)) = run_tool(
            &candidate,
            &["--version".to_string()],
            &std::env::temp_dir(),
            &[],
        ) {
            let version = output.lines().next().unwrap_or(engine).trim().to_string();
            return Some((candidate, version));
        }
    }
    None
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CompileOutcome {
    success: bool,
    /// True when the engine was killed because the user pressed Stop or a newer
    /// compile took over. Reporting that as a failure would wipe a perfectly
    /// good PDF off the screen and show an error the user caused on purpose.
    cancelled: bool,
    message: String,
    log: String,
    /// The finished PDF, base64 encoded, so the webview can show it without
    /// needing filesystem access to the build directory.
    pdf_base64: Option<String>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CompileProgress {
    project_id: String,
    label: String,
}

/// The status line the toolbar shows while the engine runs.
///
/// With the main thread free the spinner finally animates, but a multi-pass
/// bibliography build still looks identical to a hang unless the user can see
/// which pass is running. `total` is 0 until the first pass has told us whether
/// a bibliography is involved.
fn compile_step_label(tool: &str, step: u32, total: u32) -> String {
    if total == 0 && step == 0 {
        tool.to_string()
    } else if total == 0 {
        format!("{} — pass {}", tool, step)
    } else {
        format!("{} — pass {} of {}", tool, step, total)
    }
}

/// What to tell the user when no PDF came out.
///
/// A stopped compile is deliberately not phrased as a failure: it reports what
/// the user asked for, and the frontend leaves the previous PDF and log alone.
fn compile_failure_message(engine: &str, log: &str, end: ToolEnd) -> String {
    match end {
        ToolEnd::Cancelled => "Compile stopped.".to_string(),
        ToolEnd::TimedOut => timeout_message(engine, ToolLimits::engine().timeout),
        ToolEnd::Exited(_) => first_tex_error(log)
            .map(|err| format!("{} failed: {}", engine, err))
            .unwrap_or_else(|| format!("{} produced no PDF. See the log below.", engine)),
    }
}

fn ended_without_pdf(engine: &str, log: String, end: ToolEnd) -> CompileOutcome {
    CompileOutcome {
        success: false,
        cancelled: matches!(end, ToolEnd::Cancelled),
        message: compile_failure_message(engine, &log, end),
        log,
        pdf_base64: None,
    }
}

#[derive(Clone, Copy)]
struct ToolLimits {
    timeout: Duration,
    max_output_bytes: usize,
}

impl ToolLimits {
    /// A `--version` banner answers in about 2 ms; ten seconds only covers a
    /// cold disk or an antivirus first touch, and stops a broken engine wedging
    /// startup detection forever.
    fn probe() -> Self {
        ToolLimits {
            timeout: Duration::from_secs(10),
            max_output_bytes: 256 * 1024,
        }
    }

    /// A warm pdflatex pass is under half a second, but a cold lualatex font
    /// database build measured 8.7 s. Three minutes leaves room for that and for
    /// MiKTeX fetching a package mid-compile, while still ending a `\loop` that
    /// never terminates.
    fn engine() -> Self {
        ToolLimits {
            timeout: Duration::from_secs(180),
            max_output_bytes: 8 * 1024 * 1024,
        }
    }

    /// Installing a distribution is tens of minutes of downloading. The cap is
    /// only so a dead mirror cannot leave a child running for the whole session.
    fn install() -> Self {
        ToolLimits {
            timeout: Duration::from_secs(2 * 60 * 60),
            max_output_bytes: 8 * 1024 * 1024,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ToolEnd {
    Exited(i32),
    TimedOut,
    Cancelled,
}

/// The exit code the old `run_tool` would have reported.
///
/// `resolve_engine` reads `Ok((0, _))` as "this engine works", so a `--version`
/// probe that hung and was killed must never come back as 0.
fn tool_exit_code(end: ToolEnd) -> i32 {
    match end {
        ToolEnd::Exited(code) => code,
        ToolEnd::TimedOut | ToolEnd::Cancelled => -1,
    }
}

/// Distinguishable from a TeX error at a glance, because the fix is different:
/// a timeout means the engine was still running, not that the document is wrong.
fn timeout_message(program: &str, limit: Duration) -> String {
    format!(
        "{} did not finish within {} seconds and was stopped.",
        program,
        limit.as_secs()
    )
}

/// One pipe, drained on its own thread into a capped buffer.
struct PipeReader {
    buffer: Arc<Mutex<Vec<u8>>>,
    finished: Arc<AtomicBool>,
}

impl PipeReader {
    fn is_finished(&self) -> bool {
        self.finished.load(Ordering::Relaxed)
    }

    fn take(&self) -> Vec<u8> {
        let mut held = self.buffer.lock().unwrap_or_else(|e| e.into_inner());
        std::mem::take(&mut *held)
    }
}

/// Reads a child's pipe without ever blocking the poll loop.
///
/// The thread is deliberately never joined: a `\write18` grandchild (epstopdf,
/// ghostscript) inherits these pipes and can hold them open long after the
/// engine has been killed, so waiting on the reader would hang exactly the case
/// the kill exists to end. Reading continues past the cap rather than stopping,
/// because a full pipe would block the child instead of letting it finish.
fn drain<R>(stream: Option<R>, cap: usize) -> PipeReader
where
    R: std::io::Read + Send + 'static,
{
    let buffer = Arc::new(Mutex::new(Vec::new()));
    let finished = Arc::new(AtomicBool::new(true));

    if let Some(mut stream) = stream {
        finished.store(false, Ordering::Relaxed);
        let sink = Arc::clone(&buffer);
        let done = Arc::clone(&finished);
        std::thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            loop {
                match stream.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => {
                        let mut held = sink.lock().unwrap_or_else(|e| e.into_inner());
                        if held.len() < cap {
                            let room = cap - held.len();
                            held.extend_from_slice(&chunk[..read.min(room)]);
                        }
                    }
                }
            }
            done.store(true, Ordering::Relaxed);
        });
    }

    PipeReader { buffer, finished }
}

/// A runaway `\errmessage` loop emits gigabytes, and `run_tool` used to hold
/// three live copies of whatever it got. Cap it before it is ever a String, and
/// say so, rather than letting the tail vanish with no explanation. Under the
/// cap this is byte-for-byte the concatenation the log parsers already expect.
fn combine_tool_output(stdout: &[u8], stderr: &[u8], cap: usize) -> String {
    let total = stdout.len() + stderr.len();
    if total <= cap {
        return format!(
            "{}{}",
            String::from_utf8_lossy(stdout),
            String::from_utf8_lossy(stderr)
        );
    }

    // The head is what is kept: the first `!` line is what the diagnostics
    // parser looks for, and it is near the top of a TeX log.
    let from_stdout = stdout.len().min(cap);
    let from_stderr = (cap - from_stdout).min(stderr.len());
    let mut combined = String::from_utf8_lossy(&stdout[..from_stdout]).to_string();
    combined.push_str(&String::from_utf8_lossy(&stderr[..from_stderr]));
    combined.push_str(&format!(
        "\n[ZabbLeaf: output truncated — {} bytes were produced, the first {} are shown.]\n",
        total, cap
    ));
    combined
}

/// Runs a tool with a deadline, a kill handle and a cancellation check.
///
/// `Command::output()` had none of those, so a cold luaotfload font-database
/// build, MiKTeX's mid-compile package installer, or a TeX macro loop ran
/// unbounded with no way for the user to stop it.
fn run_tool_limited(
    program: &str,
    args: &[String],
    cwd: &Path,
    extra_env: &[(&str, String)],
    limits: ToolLimits,
    ticket: Option<&CompileTicket>,
) -> Result<(ToolEnd, String), String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        // `Command::output()` gave us this for free. `spawn()` does not: without
        // it the engine inherits the terminal and a TeX prompt waits forever for
        // input a webview can never supply.
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in extra_env {
        command.env(key, value);
    }

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut spawned = command
        .spawn()
        .map_err(|e| format!("Could not run {}: {}", program, e))?;
    let out = drain(spawned.stdout.take(), limits.max_output_bytes);
    let err = drain(spawned.stderr.take(), limits.max_output_bytes);

    let child = Arc::new(Mutex::new(spawned));
    if let Some(ticket) = ticket {
        ticket.set_child(&child);
    }

    let started = Instant::now();
    let end = loop {
        // Checked before try_wait: cancel() raises the flag and only then kills,
        // so a child killed on purpose is never read back as an engine failure.
        if ticket.map_or(false, |ticket| ticket.is_cancelled()) {
            kill_child(&child);
            break ToolEnd::Cancelled;
        }

        let status = {
            let mut held = child.lock().unwrap_or_else(|e| e.into_inner());
            held.try_wait()
                .map_err(|e| format!("Lost track of {}: {}", program, e))?
        };
        if let Some(status) = status {
            break ToolEnd::Exited(status.code().unwrap_or(-1));
        }

        if started.elapsed() >= limits.timeout {
            kill_child(&child);
            break ToolEnd::TimedOut;
        }
        std::thread::sleep(Duration::from_millis(25));
    };

    if let Some(ticket) = ticket {
        ticket.clear_child();
    }

    // A cancel that lands between the flag check and the try_wait above comes
    // back as a killed child's exit status, which would be reported as a failed
    // compile — the one thing the flag exists to prevent. The flag wins.
    let end = match end {
        ToolEnd::Exited(_) if ticket.map_or(false, |ticket| ticket.is_cancelled()) => {
            ToolEnd::Cancelled
        }
        end => end,
    };

    // The readers are detached, so give them a moment to flush the tail the
    // child wrote just before it ended — but only a moment: a grandchild holding
    // the pipe open must not hold up the reply.
    let grace = Instant::now();
    while !(out.is_finished() && err.is_finished()) && grace.elapsed() < Duration::from_millis(250)
    {
        std::thread::sleep(Duration::from_millis(10));
    }

    Ok((
        end,
        combine_tool_output(&out.take(), &err.take(), limits.max_output_bytes),
    ))
}

/// The shape the probe call sites still use: an exit code and the output.
fn run_tool(
    program: &str,
    args: &[String],
    cwd: &Path,
    extra_env: &[(&str, String)],
) -> Result<(i32, String), String> {
    run_tool_with(program, args, cwd, extra_env, ToolLimits::probe())
}

fn run_tool_with(
    program: &str,
    args: &[String],
    cwd: &Path,
    extra_env: &[(&str, String)],
    limits: ToolLimits,
) -> Result<(i32, String), String> {
    let (end, output) = run_tool_limited(program, args, cwd, extra_env, limits, None)?;
    Ok((tool_exit_code(end), output))
}

/// Probing three engines means up to nine `--version` spawns, which is exactly
/// the kind of work that used to stall the first paint of the editor.
///
/// The return type stays a bare `Vec` rather than gaining a `Result`: the
/// frontend reads the resolved value directly, and `invoke<T>` is untyped at the
/// boundary, so turning "no engines" into a rejected promise would be a silent
/// break `tsc` could not catch.
#[tauri::command]
async fn zl_detect_engines() -> Vec<DetectedEngine> {
    tauri::async_runtime::spawn_blocking(detect_engines)
        .await
        .unwrap_or_default()
}

fn detect_engines() -> Vec<DetectedEngine> {
    TEX_ENGINES
        .iter()
        .filter_map(|engine| {
            let (path, version) = resolve_engine(engine)?;
            Some(DetectedEngine {
                engine: engine.to_string(),
                path,
                version,
            })
        })
        .collect()
}

/// Builds the engine command line.
///
/// `-enable-installer` is what actually stops MiKTeX from opening a dialog for
/// every missing package: setting `[MPM]AutoInstall=1` does not, because 1 is
/// already the default and still means "ask". The flag is MiKTeX-only, and
/// TeX Live would reject the unknown option, so it is added only when the
/// engine's own version banner says MiKTeX.
fn tex_arguments(out_dir: &Path, file: &str, is_miktex: bool) -> Vec<String> {
    let mut args = vec![
        "-interaction=nonstopmode".to_string(),
        "-file-line-error".to_string(),
    ];
    if is_miktex {
        args.push("-enable-installer".to_string());
    }
    args.push(format!("-output-directory={}", out_dir.to_string_lossy()));
    args.push(file.to_string());
    args
}

/// Pulls the first real error out of a LaTeX log.
fn first_tex_error(log: &str) -> Option<String> {
    log.lines()
        .find(|line| line.starts_with('!'))
        .map(|line| line.trim_start_matches('!').trim().to_string())
}

#[tauri::command]
async fn zl_compile_project(
    project_id: String,
    engine: String,
    main_file: String,
    window: tauri::Window,
    compiles: tauri::State<'_, CompileRegistry>,
    repos: tauri::State<'_, RepoLocks>,
) -> Result<CompileOutcome, String> {
    // `State` is a borrow of managed state and cannot cross the spawn; both are
    // Arc handles, so they are cloned out first. `Window` is Send + 'static and
    // moves in as it is.
    let compiles = compiles.inner().clone();
    let repos = repos.inner().clone();
    offload(move || compile_project(project_id, engine, main_file, window, compiles, repos)).await
}

fn compile_project(
    project_id: String,
    engine: String,
    main_file: String,
    window: tauri::Window,
    compiles: CompileRegistry,
    repos: RepoLocks,
) -> Result<CompileOutcome, String> {
    if !TEX_ENGINES.contains(&engine.as_str()) {
        return Err(format!("Unknown TeX engine: {}", engine));
    }
    let id = sanitize_project_id(&project_id)?;

    // Registered before any of the pre-work, not after it: `resolve_engine`
    // spawns `--version` probes and the frontend has already been showing Stop
    // since it started flushing the editor to disk. A Stop that lands in that
    // window has no slot to raise a flag on, so it is inherited here instead of
    // being lost. Taken before the repo lock too, so a newer compile never waits
    // on the run it is replacing.
    let ticket = compiles.begin(&id);
    if ticket.is_cancelled() {
        // Stopped before it started; probing for an engine would only delay the
        // answer the user already asked for.
        return Ok(ended_without_pdf(&engine, String::new(), ToolEnd::Cancelled));
    }

    // Resolved rather than taken on faith: right after installing MiKTeX the
    // running process still has the old PATH, so the engine is only reachable
    // by its absolute path.
    let (program, version) = resolve_engine(&engine).ok_or_else(|| {
        format!(
            "{} is not installed. Install a TeX distribution to compile PDFs locally.",
            engine
        )
    })?;
    let is_miktex = version.to_lowercase().contains("miktex");

    let project = project_dir(&project_id)?;
    if !project.is_dir() {
        return Err("This project has no local files yet.".to_string());
    }
    // Guards against a crafted file name reaching the command line.
    let source = safe_join(&project, &main_file)?;
    if !source.is_file() {
        return Err(format!("{} does not exist in this project.", main_file));
    }

    // epstopdf will drop converted figures next to the sources, so make sure
    // they are ignored before they exist. This is the only write the compile
    // makes into the repository, so it is the only part that has to be
    // serialised against a sync — holding the lock for the whole compile would
    // instead make Sync look frozen for minutes.
    with_repo(&repos, &id, || {
        write_local_excludes(&project);
        Ok(())
    })?;
    // That lock can be held by a sync for a whole git round trip, which is long
    // enough for the user to give up and press Stop; checking here means the
    // engine is never spawned only to be killed on its first poll.
    if ticket.is_cancelled() {
        return Ok(ended_without_pdf(&engine, String::new(), ToolEnd::Cancelled));
    }

    let out_dir = build_dir(&project_id)?;
    fs::create_dir_all(&out_dir)
        .map_err(|e| format!("Cannot create {}: {}", out_dir.display(), e))?;

    let job = source
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "document".to_string());

    // Running from the project directory is what lets \input, .bib files, class
    // files and images resolve; only the outputs are redirected.
    let tex_args = |file: &str| tex_arguments(&out_dir, file, is_miktex);
    let limits = ToolLimits::engine();

    // A window the user already closed is not a compile failure.
    let announce = |label: String| {
        let _ = window.emit(
            "zl://compile-progress",
            CompileProgress {
                project_id: id.clone(),
                label,
            },
        );
    };

    let relative_source = main_file.replace('\\', "/");
    let mut log = String::new();
    let mut bibtex_log = String::new();

    announce(compile_step_label(&engine, 1, 0));
    let (mut last_end, first_pass) = run_tool_limited(
        &program,
        &tex_args(&relative_source),
        &project,
        &[],
        limits,
        Some(&ticket),
    )?;
    log.push_str(&first_pass);
    if !matches!(last_end, ToolEnd::Exited(_)) {
        return Ok(ended_without_pdf(&engine, log, last_end));
    }

    // Bibliographies need bibtex between passes, and .bib files live in the
    // project directory rather than next to the .aux file.
    let source_text = fs::read(&source)
        .map(|bytes| String::from_utf8_lossy(&bytes).to_string())
        .unwrap_or_default();
    let wants_bibtex =
        source_text.contains("\\bibliography{") || source_text.contains("\\addbibresource{");

    if wants_bibtex {
        if ticket.is_cancelled() {
            return Ok(ended_without_pdf(&engine, log, ToolEnd::Cancelled));
        }
        // bibtex ships beside the engine, so follow it rather than hoping PATH
        // has been refreshed.
        let bibtex = Path::new(&program)
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .map(|dir| dir.join(engine_file_name("bibtex")).to_string_lossy().to_string())
            .unwrap_or_else(|| "bibtex".to_string());

        let bib_inputs = format!("{}{}", project.to_string_lossy(), if cfg!(windows) { ";" } else { ":" });
        announce(compile_step_label("bibtex", 0, 0));
        if let Ok((_, bib_log)) = run_tool_limited(
            &bibtex,
            &[job.clone()],
            &out_dir,
            &[("BIBINPUTS", bib_inputs.clone()), ("BSTINPUTS", bib_inputs)],
            limits,
            Some(&ticket),
        ) {
            bibtex_log = bib_log;
        }
    }

    // Cross-references and the table of contents settle on a later pass. Only
    // the last pass is kept: the earlier ones repeat the same output, and it is
    // the final one that reflects the PDF actually produced.
    let extra_passes = if wants_bibtex { 2 } else { usize::from(log.contains("Rerun")) };
    let total_passes = (extra_passes + 1) as u32;
    for pass in 0..extra_passes {
        if ticket.is_cancelled() {
            return Ok(ended_without_pdf(&engine, log, ToolEnd::Cancelled));
        }
        announce(compile_step_label(&engine, pass as u32 + 2, total_passes));
        let (pass_end, pass_log) = run_tool_limited(
            &program,
            &tex_args(&relative_source),
            &project,
            &[],
            limits,
            Some(&ticket),
        )?;
        log = pass_log;
        last_end = pass_end;
        if !matches!(last_end, ToolEnd::Exited(_)) {
            return Ok(ended_without_pdf(&engine, log, last_end));
        }
    }

    // Appended after the loop so a bibtex failure is not overwritten by it —
    // that is exactly the case where the user needs to see why.
    if !bibtex_log.trim().is_empty() {
        log.push_str("\n--- bibtex ---\n");
        log.push_str(&bibtex_log);
    }

    let pdf_path = out_dir.join(format!("{}.pdf", job));
    if pdf_path.is_file() {
        let bytes = fs::read(&pdf_path)
            .map_err(|e| format!("Cannot read {}: {}", pdf_path.display(), e))?;
        return Ok(CompileOutcome {
            success: true,
            cancelled: false,
            message: format!("Compiled {} with {}.", main_file, engine),
            log,
            pdf_base64: Some(base64_encode(&bytes)),
        });
    }

    Ok(ended_without_pdf(&engine, log, last_end))
}

/// Installs git, which unlike a TeX engine is not optional: without it ZabbLeaf
/// cannot reach Overleaf at all.
#[tauri::command]
async fn zl_install_git() -> Result<InstallOutcome, String> {
    offload(install_git).await
}

fn install_git() -> Result<InstallOutcome, String> {
    if matches!(
        run_tool(&git_program(), &["--version".to_string()], &std::env::temp_dir(), &[]),
        Ok((0, _))
    ) {
        return Ok(InstallOutcome {
            success: true,
            message: "git is already installed.".to_string(),
            log: String::new(),
        });
    }
    install_git_for_platform()
}

#[cfg(windows)]
fn install_git_for_platform() -> Result<InstallOutcome, String> {
    // Git for Windows has no per-user installer (`winget show --scope user`
    // reports no applicable installer), so this needs elevation. That means
    // --disable-interactivity must NOT be passed: it would suppress the UAC
    // prompt and the install would simply fail.
    let args = [
        "install".to_string(),
        "--id".to_string(),
        "Git.Git".to_string(),
        "--silent".to_string(),
        "--accept-package-agreements".to_string(),
        "--accept-source-agreements".to_string(),
    ];

    let (_, log) = run_tool_with(
        "winget",
        &args,
        &std::env::temp_dir(),
        &[],
        ToolLimits::install(),
    )
    .map_err(|e| {
        format!(
            "{}

Install Git manually from https://git-scm.com/download/win",
            e
        )
    })?;

    // A fresh install is not on this process's PATH, so look at the disk again.
    forget_git_program();
    if matches!(
        run_tool(&git_program(), &["--version".to_string()], &std::env::temp_dir(), &[]),
        Ok((0, _))
    ) {
        return Ok(InstallOutcome {
            success: true,
            message: "git installed. ZabbLeaf can reach Overleaf now.".to_string(),
            log,
        });
    }

    Ok(InstallOutcome {
        success: false,
        message: "Could not install git automatically — it needs administrator permission.                   Install it from https://git-scm.com/download/win and restart ZabbLeaf."
            .to_string(),
        log,
    })
}

#[cfg(target_os = "macos")]
fn install_git_for_platform() -> Result<InstallOutcome, String> {
    // Triggers Apple's own command line tools installer, which is a GUI prompt.
    let (_, out) = run_tool_with(
        "xcode-select",
        &["--install".to_string()],
        &std::env::temp_dir(),
        &[],
        ToolLimits::install(),
    )
    .map_err(|_| {
        "Could not start the installer. Run 'xcode-select --install' in Terminal.".to_string()
    })?;

    Ok(InstallOutcome {
        success: true,
        message: "macOS is installing the command line tools, which include git. Restart ZabbLeaf when it finishes."
            .to_string(),
        log: out,
    })
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn install_git_for_platform() -> Result<InstallOutcome, String> {
    Ok(InstallOutcome {
        success: false,
        message: "Install git with your package manager, then restart ZabbLeaf.".to_string(),
        log: "Debian/Ubuntu:  sudo apt install git\n\
              Fedora:         sudo dnf install git\n\
              Arch:           sudo pacman -S git"
            .to_string(),
    })
}

/// Installs one missing LaTeX package, the fix for by far the most common
/// compile failure: `File \`booktabs.sty' not found`.
///
/// MiKTeX fetches packages on its own when `-enable-installer` is passed, so
/// this is mostly for TeX Live — and for the MiKTeX cases where the automatic
/// install was declined earlier.
#[tauri::command]
async fn zl_install_package(package: String) -> Result<InstallOutcome, String> {
    offload(move || install_package(package)).await
}

fn install_package(package: String) -> Result<InstallOutcome, String> {
    // Straight onto a command line, so nothing but a package name gets through.
    let name = package.trim().to_string();
    if name.is_empty()
        || name.len() > 64
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err(format!("{} is not a valid package name.", package));
    }

    let (program, version) = resolve_engine("pdflatex")
        .or_else(|| resolve_engine("xelatex"))
        .or_else(|| resolve_engine("lualatex"))
        .ok_or_else(|| {
            "No TeX distribution found. Install one before installing packages.".to_string()
        })?;

    // The manager sits beside the engine; PATH may not have caught up yet.
    let beside = |tool: &str| {
        Path::new(&program)
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .map(|dir| dir.join(engine_file_name(tool)).to_string_lossy().to_string())
            .unwrap_or_else(|| tool.to_string())
    };

    let is_miktex = version.to_lowercase().contains("miktex");
    let (manager, args) = if is_miktex {
        (beside("mpm"), vec![format!("--install={}", name)])
    } else {
        (beside("tlmgr"), vec!["install".to_string(), name.clone()])
    };

    let (code, log) = run_tool_with(
        &manager,
        &args,
        &std::env::temp_dir(),
        &[],
        ToolLimits::install(),
    )?;
    if code == 0 {
        return Ok(InstallOutcome {
            success: true,
            message: format!("Installed {}. Recompile to use it.", name),
            log,
        });
    }

    // tlmgr writes into the distribution, which a system-packaged TeX Live only
    // lets root do. Saying so beats showing a bare permission error.
    let message = if is_miktex {
        format!("MiKTeX could not install {}. See the log below.", name)
    } else {
        format!(
            "tlmgr could not install {}. On a distribution-packaged TeX Live this needs your package manager (e.g. apt install texlive-latex-extra) or sudo tlmgr.",
            name
        )
    };
    Ok(InstallOutcome {
        success: false,
        message,
        log,
    })
}

/// Installs a TeX distribution so the user can produce real PDFs offline.
///
/// Deliberately user-initiated: this downloads and installs system software,
/// so nothing here runs unless the user asks for it.
#[tauri::command]
async fn zl_install_tex() -> Result<InstallOutcome, String> {
    offload(install_tex).await
}

fn install_tex() -> Result<InstallOutcome, String> {
    if resolve_engine("pdflatex").is_some() {
        return Ok(InstallOutcome {
            success: true,
            message: "A LaTeX engine is already installed.".to_string(),
            log: String::new(),
        });
    }
    install_tex_distribution()
}

// One function per platform, each with its own signature, so a mistake in a
// branch that this machine cannot compile is a compile error on the machine
// that can — rather than a block whose type happens to work out.

#[cfg(windows)]
fn install_tex_distribution() -> Result<InstallOutcome, String> {
    let mut log = String::new();

    // --scope user keeps this out of Program Files, so no admin prompt.
    let (code, out) = run_tool_with(
        "winget",
        &[
            "install".to_string(),
            "--id".to_string(),
            "MiKTeX.MiKTeX".to_string(),
            "--scope".to_string(),
            "user".to_string(),
            "--silent".to_string(),
            "--accept-package-agreements".to_string(),
            "--accept-source-agreements".to_string(),
            "--disable-interactivity".to_string(),
        ],
        &std::env::temp_dir(),
        &[],
        ToolLimits::install(),
    )
    .map_err(|e| format!("{}

Install MiKTeX manually from https://miktex.org/download", e))?;
    log.push_str(&out);

    if code != 0 && resolve_engine("pdflatex").is_none() {
        return Ok(InstallOutcome {
            success: false,
            message: "MiKTeX installation failed. Install it manually from https://miktex.org/download"
                .to_string(),
            log,
        });
    }

    configure_miktex(&mut log);

    match resolve_engine("pdflatex") {
        Some((_, version)) => Ok(InstallOutcome {
            success: true,
            message: format!("LaTeX installed: {}", version),
            log,
        }),
        None => Ok(InstallOutcome {
            success: false,
            message: "MiKTeX was installed but pdflatex could not be found. Restart ZabbLeaf and try again."
                .to_string(),
            log,
        }),
    }
}

/// MiKTeX Basic ships no scalable T1 fonts, so the first real document fails
/// with "auto expansion is only possible with scalable fonts" until cm-super is
/// there. Missing packages are handled at compile time instead, by passing
/// -enable-installer to the engine.
#[cfg(windows)]
fn configure_miktex(log: &mut String) {
    let Some((pdflatex, _)) = resolve_engine("pdflatex") else {
        return;
    };
    let Some(bin) = Path::new(&pdflatex).parent().map(|p| p.to_path_buf()) else {
        return;
    };

    if let Ok((_, out)) = run_tool_with(
        &bin.join(engine_file_name("mpm")).to_string_lossy(),
        &["--install=cm-super".to_string()],
        &std::env::temp_dir(),
        &[],
        ToolLimits::install(),
    ) {
        log.push_str("
--- scalable Computer Modern fonts ---
");
        log.push_str(&out);
    }
}

/// An app launched from the Finder gets a bare PATH — `/usr/bin:/bin:/usr/sbin:/sbin`
/// — not the one from the user's shell. Homebrew lives outside it on both
/// architectures, so looking it up by name alone reports "not installed" to
/// people who have it.
#[cfg(target_os = "macos")]
fn find_homebrew() -> Option<String> {
    for candidate in [
        "/opt/homebrew/bin/brew", // Apple Silicon
        "/usr/local/bin/brew",    // Intel
        "brew",
    ] {
        if let Ok((0, _)) = run_tool(
            candidate,
            &["--version".to_string()],
            &std::env::temp_dir(),
            &[],
        ) {
            return Some(candidate.to_string());
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn install_tex_distribution() -> Result<InstallOutcome, String> {
    let brew = find_homebrew().ok_or_else(|| {
        "Homebrew is not available. Install BasicTeX from \
         https://tug.org/mactex/morepackages.html"
            .to_string()
    })?;

    // BasicTeX rather than the full MacTeX: ~100 MB instead of ~5 GB, and it
    // fetches the rest through tlmgr when a document needs it.
    let (code, out) = run_tool_with(
        &brew,
        &[
            "install".to_string(),
            "--cask".to_string(),
            "basictex".to_string(),
        ],
        &std::env::temp_dir(),
        &[],
        ToolLimits::install(),
    )
    .map_err(|e| format!("Could not run Homebrew: {}", e))?;

    if code != 0 {
        return Ok(InstallOutcome {
            success: false,
            message: "Installation failed. Install BasicTeX from https://tug.org/mactex/morepackages.html"
                .to_string(),
            log: out,
        });
    }

    match resolve_engine("pdflatex") {
        Some((_, version)) => Ok(InstallOutcome {
            success: true,
            message: format!("LaTeX installed: {}", version),
            log: out,
        }),
        None => Ok(InstallOutcome {
            success: false,
            message: "BasicTeX was installed but pdflatex could not be found. Restart ZabbLeaf and try again."
                .to_string(),
            log: out,
        }),
    }
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn install_tex_distribution() -> Result<InstallOutcome, String> {
    // Every Linux package manager needs root, and an application should not try
    // to obtain it on the user's behalf.
    Ok(InstallOutcome {
        success: false,
        message: "Install TeX Live with your package manager, then restart ZabbLeaf.".to_string(),
        log: "Debian/Ubuntu:  sudo apt install texlive-latex-recommended texlive-fonts-recommended
              Fedora:         sudo dnf install texlive-scheme-basic
              Arch:           sudo pacman -S texlive-basic"
            .to_string(),
    })
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_ids_cannot_escape_the_projects_root() {
        assert!(sanitize_project_id("../../windows").is_err());
        assert!(sanitize_project_id("a/b").is_err());
        assert!(sanitize_project_id("").is_err());
        assert_eq!(
            sanitize_project_id(" 6a6a84fe7cba2c6cd0ff9f3e ").unwrap(),
            "6a6a84fe7cba2c6cd0ff9f3e"
        );
        assert_eq!(sanitize_project_id("local-1234").unwrap(), "local-1234");
    }

    #[test]
    fn only_real_image_formats_are_treated_as_figures() {
        assert!(is_asset_file(Path::new("figures/plot.PNG")));
        assert!(is_asset_file(Path::new("diagram.eps")));
        assert!(!is_asset_file(Path::new("main.tex")));
        assert!(!is_asset_file(Path::new("notes")));
    }

    /// A pasted image must never overwrite a figure the document already
    /// references, so the second one is renamed rather than silently replacing
    /// the first.
    #[test]
    fn a_second_image_with_the_same_name_gets_a_suffix() {
        let dir = std::env::temp_dir().join(format!("zabbleaf-test-{}", std::process::id()));
        fs::create_dir_all(dir.join("figures")).unwrap();

        let (first, name) = unique_asset_path(&dir, "figures/plot.png").unwrap();
        assert_eq!(name, "figures/plot.png");
        fs::write(&first, b"x").unwrap();

        let (second, name) = unique_asset_path(&dir, "figures/plot.png").unwrap();
        assert_eq!(name, "figures/plot-1.png");
        assert!(!second.exists());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn relative_paths_cannot_escape_the_project_dir() {
        let base = Path::new("/projects/abc");
        assert!(safe_join(base, "../secrets.txt").is_err());
        assert!(safe_join(base, "sections/../../secrets.txt").is_err());
        assert!(safe_join(base, "C:/Windows/system.ini").is_err());
        assert_eq!(
            safe_join(base, "sections/intro.tex").unwrap(),
            base.join("sections").join("intro.tex")
        );
    }

    #[test]
    fn credentials_are_injected_and_stripped() {
        let url = "https://git.overleaf.com/6a6a84fe7cba2c6cd0ff9f3e";
        let authed = auth_url(url, "olp_secret").unwrap();
        assert_eq!(
            authed,
            "https://git:olp_secret@git.overleaf.com/6a6a84fe7cba2c6cd0ff9f3e"
        );
        // Feeding an already-authenticated URL back in must not stack credentials.
        assert_eq!(clean_url(&authed).unwrap(), url);
        assert!(auth_url(url, "  ").is_err());
    }

    #[test]
    fn tokens_with_url_specials_are_encoded() {
        let authed = auth_url("https://git.overleaf.com/abc", "p@ss/word").unwrap();
        assert_eq!(authed, "https://git:p%40ss%2Fword@git.overleaf.com/abc");
    }

    #[test]
    fn tokens_never_leak_into_reported_output() {
        let raw = "fatal: could not read from https://git:olp_secret@git.overleaf.com/abc";
        assert!(!redact(raw, "olp_secret").contains("olp_secret"));
        assert!(!redact("token p%40ss", "p@ss").contains("p%40ss"));
    }

    #[test]
    fn auth_failures_get_an_actionable_message() {
        let msg = friendly_error("remote: Authentication failed for 'x'", "");
        assert!(msg.contains("Generate a fresh Git token"));
        assert!(friendly_error("remote: Repository not found", "").contains("Project not found"));
        assert!(friendly_error("fatal: remote error: no git access", "").contains("No Git access"));
        // git puts the URL between the two words.
        assert!(friendly_error(
            "fatal: repository 'https://git.overleaf.com/abc/' not found",
            ""
        )
        .contains("Project not found"));
        assert!(
            friendly_error("remote: This Overleaf project does not exist.", "")
                .contains("Project not found")
        );
    }

    #[test]
    fn unrecognised_failures_are_reduced_to_one_line() {
        let noisy = "Cloning into 'C:\\projects\\abc'...\n\
                     remote: some long explanation\n\
                     remote: spanning several lines\n\
                     fatal: the remote end hung up unexpectedly\n\
                     remote: contact support";
        assert_eq!(
            friendly_error(noisy, ""),
            "fatal: the remote end hung up unexpectedly"
        );
    }

    #[test]
    fn main_tex_sorts_first() {
        let mut names = vec!["zzz.txt", "appendix.tex", "main.tex", "refs.bib"];
        names.sort_by(|a, b| sort_rank(a).cmp(&sort_rank(b)).then(a.cmp(b)));
        assert_eq!(names, vec!["main.tex", "appendix.tex", "refs.bib", "zzz.txt"]);
    }

    #[test]
    fn build_output_stays_out_of_the_cloned_repository() {
        // Otherwise `git add -A` during a sync would push .aux/.log/.pdf files
        // to the user's Overleaf project.
        let project = project_dir("abc").unwrap();
        let build = build_dir("abc").unwrap();
        assert!(!build.starts_with(&project));
    }

    #[test]
    fn the_installer_flag_is_only_passed_to_miktex() {
        let out = Path::new("/build");
        let miktex = tex_arguments(out, "main.tex", true);
        assert!(miktex.contains(&"-enable-installer".to_string()));

        // TeX Live rejects unknown options, which would break every compile on
        // the machines that use it.
        let texlive = tex_arguments(out, "main.tex", false);
        assert!(!texlive.contains(&"-enable-installer".to_string()));

        // The file always comes last, whichever engine it is.
        assert_eq!(miktex.last().unwrap(), "main.tex");
        assert_eq!(texlive.last().unwrap(), "main.tex");
    }

    #[test]
    fn tex_errors_are_pulled_out_of_the_log() {
        let log = "This is pdfTeX\n(./main.tex\n! Undefined control sequence.\nl.11 \\name\n";
        assert_eq!(
            first_tex_error(log).unwrap(),
            "Undefined control sequence."
        );
        assert!(first_tex_error("no errors here").is_none());
    }

    #[test]
    fn only_text_sources_are_offered_to_the_editor() {
        assert!(is_text_file(Path::new("main.tex")));
        assert!(is_text_file(Path::new("refs.BIB")));
        assert!(!is_text_file(Path::new("figure.png")));
        assert!(!is_text_file(Path::new("Makefile")));
    }

    #[test]
    fn a_remote_url_that_still_carries_credentials_is_recognised() {
        assert!(remote_needs_cleaning(
            "https://git:olp_secret@git.overleaf.com/1234"
        ));
        // run_git redacts the token out of its own output, so this is the form
        // the post-sync verification actually reads back.
        assert!(remote_needs_cleaning("https://git:***@git.overleaf.com/1234"));
        assert!(!remote_needs_cleaning("https://git.overleaf.com/1234"));
        assert!(!remote_needs_cleaning(
            clean_url("https://git:tok@git.overleaf.com/1234")
                .unwrap()
                .as_str()
        ));
        // An @ after the host is part of the path, not credentials.
        assert!(!remote_needs_cleaning("https://git.overleaf.com/a@b"));
        assert!(!remote_needs_cleaning("git@github.com:owner/repo.git"));
    }

    #[test]
    fn a_scratch_save_name_never_contains_a_path_separator() {
        let name = scratch_file_name("chapters/intro.tex", 0);
        assert!(!name.contains('/'));
        assert!(!name.contains('\\'));
        assert!(!name.contains(':'));
        assert!(name.ends_with(".zabbleaf-save"));
    }

    #[test]
    fn two_concurrent_saves_of_the_same_file_use_different_scratch_names() {
        assert_ne!(
            scratch_file_name("main.tex", 0),
            scratch_file_name("main.tex", 1)
        );
    }

    #[test]
    fn a_project_id_is_still_rejected_before_a_scratch_file_is_created() {
        // write_atomically reaches the disk through build_dir, which sanitizes,
        // so a crafted id cannot drop a scratch file outside the build root.
        assert!(build_dir("../evil").is_err());
        assert!(build_dir("a/b").is_err());
        assert!(build_dir("local-1234").is_ok());
    }

    #[test]
    fn a_runaway_tool_log_is_capped_and_says_it_was_cut() {
        let cap = 8 * 1024 * 1024;
        let stdout = vec![b'x'; 9 * 1024 * 1024];
        let stderr = vec![b'y'; 1024];

        let capped = combine_tool_output(&stdout, &stderr, cap);
        assert!(capped.len() < stdout.len() + stderr.len());
        assert!(capped.trim_end().ends_with("are shown.]"));
        assert!(capped.contains("truncated"));

        // Under the cap it must still be the plain concatenation the existing
        // log parsing expects, byte for byte.
        assert_eq!(
            combine_tool_output(b"out", b"err", cap),
            format!("{}{}", "out", "err")
        );
    }

    #[test]
    fn compile_step_label_names_the_pass_the_engine_is_on() {
        assert_eq!(compile_step_label("pdflatex", 1, 0), "pdflatex — pass 1");
        assert_eq!(
            compile_step_label("pdflatex", 2, 3),
            "pdflatex — pass 2 of 3"
        );
        assert_eq!(compile_step_label("bibtex", 0, 0), "bibtex");
    }

    #[test]
    fn a_stopped_compile_is_not_reported_as_a_failed_one() {
        let log = "This is pdfTeX\n(./main.tex\n! Undefined control sequence.\nl.11 \\name\n";

        let stopped = compile_failure_message("pdflatex", log, ToolEnd::Cancelled);
        assert_eq!(stopped, "Compile stopped.");
        assert!(!stopped.contains("pdflatex"));
        assert!(!stopped.contains("Undefined control sequence"));

        // The same log from an engine that really failed still reads as before.
        assert_eq!(
            compile_failure_message("pdflatex", log, ToolEnd::Exited(1)),
            "pdflatex failed: Undefined control sequence."
        );
    }

    #[test]
    fn a_timed_out_engine_says_how_long_it_waited() {
        let message = timeout_message("lualatex", Duration::from_secs(180));
        assert!(message.contains("lualatex"));
        assert!(message.contains("180"));

        // The compile path must use the same wording, so a timeout is
        // distinguishable from a TeX error without opening the log.
        let timed_out = compile_failure_message("lualatex", "! nonsense.", ToolEnd::TimedOut);
        assert!(timed_out.contains("180"));
        assert!(!timed_out.contains("nonsense"));
    }

    #[test]
    fn a_newer_compile_supersedes_the_one_already_running() {
        let registry = CompileRegistry::default();

        let first = registry.begin("abc");
        assert!(!first.is_cancelled());

        let second = registry.begin("abc");
        assert!(first.is_cancelled());
        assert!(!second.is_cancelled());

        // A different project must not be collateral damage.
        let other = registry.begin("def");
        assert!(!other.is_cancelled());
        assert!(!second.is_cancelled());
    }

    #[test]
    fn cancelling_a_project_with_nothing_running_reports_nothing_to_stop() {
        let registry = CompileRegistry::default();
        assert!(!registry.cancel("abc"));

        {
            let _ticket = registry.begin("abc");
            assert!(registry.cancel("abc"));
        }

        // The ticket's Drop freed the slot, so Stop on an idle project cannot
        // kill a process left over from a previous run.
        assert!(!registry.cancel("abc"));
    }

    #[test]
    fn a_finished_compile_never_frees_a_newer_compiles_slot() {
        let registry = CompileRegistry::default();
        let first = registry.begin("abc");
        let _second = registry.begin("abc");

        drop(first);

        // If the older ticket had cleared the slot, this Stop would report that
        // nothing was running while an engine was still going.
        assert!(registry.cancel("abc"));
    }

    #[test]
    fn a_killed_probe_never_reads_as_a_working_engine() {
        // resolve_engine matches Ok((0, _)), so anything but a real exit has to
        // be nonzero or a hung --version would count as engine detection.
        assert_eq!(tool_exit_code(ToolEnd::Exited(0)), 0);
        assert_ne!(tool_exit_code(ToolEnd::TimedOut), 0);
        assert_ne!(tool_exit_code(ToolEnd::Cancelled), 0);
    }

    #[test]
    fn a_stop_pressed_before_the_compile_registers_still_stops_it() {
        let registry = CompileRegistry::default();

        // The frontend shows Stop from the moment it starts flushing files, so
        // the click can land before compile_project reaches begin().
        assert!(!registry.stop("abc"));

        let ticket = registry.begin("abc");
        assert!(ticket.is_cancelled());

        // The remembered Stop is consumed, not left to ambush the compile the
        // user asks for next.
        drop(ticket);
        assert!(!registry.begin("abc").is_cancelled());
    }

    #[test]
    fn a_stop_aimed_at_another_project_never_reaches_this_one() {
        let registry = CompileRegistry::default();
        assert!(!registry.stop("abc"));
        assert!(!registry.begin("def").is_cancelled());
    }

    /// Sync and delete cancel a compile to get the working tree to themselves.
    /// If that armed a Stop the way the user's own Stop does, the auto-compile
    /// that follows every sync would be killed before it ran.
    #[test]
    fn making_way_for_a_sync_does_not_stop_the_compile_that_comes_after_it() {
        let registry = CompileRegistry::default();
        assert!(!registry.cancel("abc"));
        assert!(!registry.begin("abc").is_cancelled());
    }

    #[test]
    fn a_stop_that_found_nothing_running_expires_instead_of_killing_a_later_compile() {
        let now = Instant::now();
        assert!(pending_cancel_applies(now, now));
        assert!(pending_cancel_applies(
            now - PENDING_CANCEL_WINDOW + Duration::from_secs(1),
            now
        ));
        // A Stop that merely raced the end of a run must not silently cancel the
        // compile the user starts minutes later.
        assert!(!pending_cancel_applies(now - PENDING_CANCEL_WINDOW, now));
        assert!(!pending_cancel_applies(now - Duration::from_secs(600), now));
    }

    #[test]
    fn a_discarded_clone_only_claims_to_be_discarded_when_it_really_was() {
        let dir = Path::new("/home/u/.zabbleaf/projects/abc");

        let removed = discarded_clone_message(dir, None);
        assert!(removed.contains("the download was discarded"));
        assert!(removed.contains("/home/u/.zabbleaf/projects/abc"));

        // The token is still on disk, so the message has to say so and point at
        // the file rather than claim the download is gone.
        let kept = discarded_clone_message(dir, Some("Access is denied. (os error 5)"));
        assert!(!kept.contains("was discarded"));
        assert!(kept.contains("Access is denied"));
        assert!(kept.contains("config"));
    }

    #[test]
    fn a_sync_that_could_not_start_git_reports_that_rather_than_a_token_problem() {
        let config = Path::new("/home/u/.zabbleaf/projects/abc/.git/config");

        let spawn_failure = "Could not run git: No such file or directory. \
                             Make sure git is installed and on your PATH.";
        // git never started, so `remote set-url` never ran and the file is clean.
        assert_eq!(
            sync_cleanup_error(Some(spawn_failure.to_string()), false, config),
            spawn_failure
        );

        // A sync that otherwise went through really did leave the token there.
        let scrub_failure = sync_cleanup_error(None, true, config);
        assert!(scrub_failure.contains("Could not remove your Overleaf token"));
        assert!(scrub_failure.contains("/.git/config"));
    }

    #[test]
    fn a_token_already_on_disk_is_reported_even_when_the_sync_also_failed() {
        let config = Path::new("/home/u/.zabbleaf/projects/abc/.git/config");

        // git vanishing *after* the authenticated URL is set stops the scrub
        // too, so this is exactly the case where the warning is load-bearing.
        // Reporting only the spawn failure would leave the token unmentioned.
        let both = sync_cleanup_error(
            Some("Could not run git: No such file or directory.".to_string()),
            true,
            config,
        );
        assert!(both.contains("Could not remove your Overleaf token"));
        assert!(both.contains("Could not run git"));
    }

    #[test]
    fn one_project_lock_is_shared_and_two_projects_are_not() {
        let locks = RepoLocks::default();
        assert!(Arc::ptr_eq(&locks.for_project("abc"), &locks.for_project("abc")));
        assert!(!Arc::ptr_eq(&locks.for_project("abc"), &locks.for_project("def")));
    }
}

fn main() {
    tauri::Builder::default()
        // Without these, every `State<'_, T>` argument fails at runtime with
        // "state not managed" and the whole compile path stops working.
        .manage(CompileRegistry::default())
        .manage(RepoLocks::default())
        .invoke_handler(tauri::generate_handler![
            zl_git_available,
            zl_projects_root,
            zl_project_exists,
            zl_clone_project,
            zl_sync_project,
            zl_read_project_files,
            zl_project_changes,
            zl_write_project_file,
            zl_delete_project,
            zl_delete_project_file,
            zl_install_git,
            zl_detect_engines,
            zl_compile_project,
            zl_install_tex,
            zl_install_package,
            zl_list_project_assets,
            zl_write_project_asset,
            zl_import_project_asset,
            zl_read_project_asset,
            zl_cancel_compile,
            zl_write_new_project_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

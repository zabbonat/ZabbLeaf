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

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

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
fn zl_clone_project(
    project_id: String,
    git_url: String,
    token: String,
) -> Result<GitOutcome, String> {
    let root = projects_root()?;
    fs::create_dir_all(&root).map_err(|e| format!("Cannot create {}: {}", root.display(), e))?;

    let dir = project_dir(&project_id)?;

    if dir.join(".git").is_dir() {
        return Ok(GitOutcome::ok("Project is already downloaded."));
    }
    // A partially written directory would make `git clone` bail out with
    // "destination path already exists".
    if dir.exists() {
        fs::remove_dir_all(&dir)
            .map_err(|e| format!("Cannot clear {}: {}", dir.display(), e))?;
    }

    let clean = clean_url(&git_url)?;
    let authenticated = auth_url(&git_url, &token)?;

    // Full clone, not shallow: Overleaf rejects pushes from shallow clones and
    // these projects are small.
    let outcome = run_git(
        &[
            "clone".to_string(),
            authenticated,
            dir.to_string_lossy().to_string(),
        ],
        Some(&root),
        &token,
    )?;

    if outcome.success {
        // Don't leave the token sitting in .git/config.
        let _ = run_git(
            &[
                "remote".to_string(),
                "set-url".to_string(),
                "origin".to_string(),
                clean,
            ],
            Some(&dir),
            &token,
        );
        write_local_excludes(&dir);
        return Ok(GitOutcome::ok("Project downloaded from Overleaf."));
    }

    // Leave nothing behind that would confuse the next attempt.
    if dir.exists() && !dir.join(".git").is_dir() {
        let _ = fs::remove_dir_all(&dir);
    }
    Ok(outcome)
}

#[tauri::command]
fn zl_sync_project(
    project_id: String,
    git_url: String,
    token: String,
    email: String,
    message: String,
) -> Result<GitOutcome, String> {
    let dir = project_dir(&project_id)?;
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

    let clean = clean_url(&git_url)?;
    let authenticated = auth_url(&git_url, &token)?;
    let branch = current_branch(&dir);

    let restore_remote = |token: &str| {
        let _ = run_git(
            &[
                "remote".to_string(),
                "set-url".to_string(),
                "origin".to_string(),
                clean.clone(),
            ],
            Some(&dir),
            token,
        );
    };

    let set_remote = run_git(
        &[
            "remote".to_string(),
            "set-url".to_string(),
            "origin".to_string(),
            authenticated,
        ],
        Some(&dir),
        &token,
    )?;
    if !set_remote.success {
        return Ok(set_remote);
    }

    let _ = run_git(&["add".to_string(), "-A".to_string()], Some(&dir), &token)?;

    let status = run_git(
        &["status".to_string(), "--porcelain".to_string()],
        Some(&dir),
        &token,
    )?;
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
            &token,
        )?;
        if !commit.success {
            restore_remote(&token);
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
        &token,
    )?;
    if !pull.success {
        // Never leave the repo mid-rebase.
        let _ = run_git(
            &["rebase".to_string(), "--abort".to_string()],
            Some(&dir),
            &token,
        );
        restore_remote(&token);
        return Ok(pull);
    }

    let push = run_git(
        &["push".to_string(), "origin".to_string(), branch],
        Some(&dir),
        &token,
    )?;
    restore_remote(&token);

    if push.success {
        Ok(GitOutcome::ok("Synced with Overleaf."))
    } else {
        Ok(push)
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
fn zl_project_changes(project_id: String) -> Result<ProjectChanges, String> {
    let dir = project_dir(&project_id)?;
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
fn zl_read_project_files(project_id: String) -> Result<Vec<ProjectFile>, String> {
    let dir = project_dir(&project_id)?;
    let mut files: Vec<ProjectFile> = Vec::new();
    if !dir.is_dir() {
        return Ok(files);
    }

    collect_files(&dir, &dir, &mut files)?;
    files.sort_by(|a, b| sort_rank(&a.name).cmp(&sort_rank(&b.name)).then(a.name.cmp(&b.name)));
    Ok(files)
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
        let entry = entry.map_err(|e| format!("Cannot read {}: {}", dir.display(), e))?;
        let file_name = entry.file_name().to_string_lossy().to_string();
        // Skips .git and other dotfiles.
        if file_name.starts_with('.') {
            continue;
        }

        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|e| format!("Cannot stat {}: {}", path.display(), e))?;

        if file_type.is_dir() {
            collect_files(root, &path, out)?;
        } else if file_type.is_file() && is_text_file(&path) {
            if entry.metadata().map(|m| m.len()).unwrap_or(0) > MAX_TEXT_FILE_BYTES {
                continue;
            }
            let bytes = fs::read(&path)
                .map_err(|e| format!("Cannot read {}: {}", path.display(), e))?;
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

#[tauri::command]
fn zl_write_project_file(
    project_id: String,
    rel_path: String,
    content: String,
) -> Result<(), String> {
    let dir = project_dir(&project_id)?;
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create {}: {}", dir.display(), e))?;

    let target = safe_join(&dir, &rel_path)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Cannot create {}: {}", parent.display(), e))?;
    }
    fs::write(&target, content).map_err(|e| format!("Cannot write {}: {}", target.display(), e))
}

/// Removes one file from the project.
///
/// Without this, deleting a file only dropped it from the list: `git add -A`
/// saw no removal, and the file came back the next time the project was opened.
#[tauri::command]
fn zl_delete_project_file(project_id: String, rel_path: String) -> Result<(), String> {
    let dir = project_dir(&project_id)?;
    let target = safe_join(&dir, &rel_path)?;
    if target.is_file() {
        fs::remove_file(&target)
            .map_err(|e| format!("Cannot delete {}: {}", target.display(), e))?;
    }
    Ok(())
}

#[tauri::command]
fn zl_delete_project(project_id: String) -> Result<(), String> {
    let dir = project_dir(&project_id)?;
    if dir.exists() {
        fs::remove_dir_all(&dir)
            .map_err(|e| format!("Cannot delete {}: {}", dir.display(), e))?;
    }
    Ok(())
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
fn zl_list_project_assets(project_id: String) -> Result<Vec<ProjectAsset>, String> {
    let dir = project_dir(&project_id)?;
    let mut assets = Vec::new();
    if !dir.is_dir() {
        return Ok(assets);
    }
    collect_assets(&dir, &dir, &mut assets)?;
    assets.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(assets)
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
fn zl_write_project_asset(
    project_id: String,
    rel_path: String,
    base64_data: String,
) -> Result<String, String> {
    use base64::Engine as _;

    let dir = project_dir(&project_id)?;
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

    let (target, name) = unique_asset_path(&dir, &rel_path)?;
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
fn zl_import_project_asset(
    project_id: String,
    source_path: String,
    dest_dir: String,
) -> Result<String, String> {
    let source = PathBuf::from(&source_path);
    if !source.is_file() {
        return Err(format!("{} is not a file.", source_path));
    }
    if !is_asset_file(&source) {
        return Err(format!(
            "{} is not an image. Drop a PNG, JPG, PDF or EPS instead.",
            source
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or(source_path.clone())
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
    let dir = project_dir(&project_id)?;
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
fn zl_read_project_asset(project_id: String, rel_path: String) -> Result<String, String> {
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
    message: String,
    log: String,
    /// The finished PDF, base64 encoded, so the webview can show it without
    /// needing filesystem access to the build directory.
    pdf_base64: Option<String>,
}

fn run_tool(
    program: &str,
    args: &[String],
    cwd: &Path,
    extra_env: &[(&str, String)],
) -> Result<(i32, String), String> {
    let mut command = Command::new(program);
    command.args(args).current_dir(cwd);
    for (key, value) in extra_env {
        command.env(key, value);
    }

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let output = command
        .output()
        .map_err(|e| format!("Could not run {}: {}", program, e))?;

    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Ok((output.status.code().unwrap_or(-1), combined))
}

#[tauri::command]
fn zl_detect_engines() -> Vec<DetectedEngine> {
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
fn zl_compile_project(
    project_id: String,
    engine: String,
    main_file: String,
) -> Result<CompileOutcome, String> {
    if !TEX_ENGINES.contains(&engine.as_str()) {
        return Err(format!("Unknown TeX engine: {}", engine));
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
    // they are ignored before they exist.
    write_local_excludes(&project);

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

    let relative_source = main_file.replace('\\', "/");
    let mut log = String::new();
    let mut bibtex_log = String::new();

    let (_, first_pass) = run_tool(&program, &tex_args(&relative_source), &project, &[])?;
    log.push_str(&first_pass);

    // Bibliographies need bibtex between passes, and .bib files live in the
    // project directory rather than next to the .aux file.
    let source_text = fs::read(&source)
        .map(|bytes| String::from_utf8_lossy(&bytes).to_string())
        .unwrap_or_default();
    let wants_bibtex =
        source_text.contains("\\bibliography{") || source_text.contains("\\addbibresource{");

    if wants_bibtex {
        // bibtex ships beside the engine, so follow it rather than hoping PATH
        // has been refreshed.
        let bibtex = Path::new(&program)
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .map(|dir| dir.join(engine_file_name("bibtex")).to_string_lossy().to_string())
            .unwrap_or_else(|| "bibtex".to_string());

        let bib_inputs = format!("{}{}", project.to_string_lossy(), if cfg!(windows) { ";" } else { ":" });
        if let Ok((_, bib_log)) = run_tool(
            &bibtex,
            &[job.clone()],
            &out_dir,
            &[("BIBINPUTS", bib_inputs.clone()), ("BSTINPUTS", bib_inputs)],
        ) {
            bibtex_log = bib_log;
        }
    }

    // Cross-references and the table of contents settle on a later pass. Only
    // the last pass is kept: the earlier ones repeat the same output, and it is
    // the final one that reflects the PDF actually produced.
    let extra_passes = if wants_bibtex { 2 } else { usize::from(log.contains("Rerun")) };
    for _ in 0..extra_passes {
        let (_, pass) = run_tool(&program, &tex_args(&relative_source), &project, &[])?;
        log = pass;
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
            message: format!("Compiled {} with {}.", main_file, engine),
            log,
            pdf_base64: Some(base64_encode(&bytes)),
        });
    }

    let message = first_tex_error(&log)
        .map(|err| format!("{} failed: {}", engine, err))
        .unwrap_or_else(|| format!("{} produced no PDF. See the log below.", engine));

    Ok(CompileOutcome {
        success: false,
        message,
        log,
        pdf_base64: None,
    })
}

/// Installs git, which unlike a TeX engine is not optional: without it ZabbLeaf
/// cannot reach Overleaf at all.
#[tauri::command]
fn zl_install_git() -> Result<InstallOutcome, String> {
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

    let (_, log) = run_tool("winget", &args, &std::env::temp_dir(), &[]).map_err(|e| {
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
    let (_, out) = run_tool(
        "xcode-select",
        &["--install".to_string()],
        &std::env::temp_dir(),
        &[],
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
fn zl_install_package(package: String) -> Result<InstallOutcome, String> {
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

    let (code, log) = run_tool(&manager, &args, &std::env::temp_dir(), &[])?;
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
fn zl_install_tex() -> Result<InstallOutcome, String> {
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
    let (code, out) = run_tool(
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

    if let Ok((_, out)) = run_tool(
        &bin.join(engine_file_name("mpm")).to_string_lossy(),
        &["--install=cm-super".to_string()],
        &std::env::temp_dir(),
        &[],
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
    let (code, out) = run_tool(
        &brew,
        &[
            "install".to_string(),
            "--cask".to_string(),
            "basictex".to_string(),
        ],
        &std::env::temp_dir(),
        &[],
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
}

fn main() {
    tauri::Builder::default()
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
            zl_read_project_asset
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

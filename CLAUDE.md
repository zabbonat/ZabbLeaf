# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ZabbLeaf is a Tauri **v1** desktop app (React + TypeScript frontend, Rust backend) for editing LaTeX offline and syncing with Overleaf over Overleaf's Git bridge. Tauri v1 matters: the JS API is `@tauri-apps/api/tauri` / `/shell` / `/window`, permissions are the `allowlist` in `src-tauri/tauri.conf.json`, and Linux builds need `libwebkit2gtk-4.0-dev` (CI pins `ubuntu-22.04` for this reason).

## Commands

```bash
npm install
npm run tauri dev        # run the app (starts Vite on :3000, then the Tauri window)
npm run build            # tsc + vite build — this is the only frontend typecheck; there is no linter
npm run tauri build      # full installer for the host platform

# Rust (run from src-tauri/)
cargo check --all-targets
cargo test                                   # all backend tests
cargo test tokens_never_leak                 # a single test, by (sub)name
```

- **`dist/` must exist before any `cargo` command.** `tauri::generate_context!()` reads `distDir` at compile time and `dist/` is gitignored, so on a fresh clone run `npm run build` first. `npm run tauri build|dev` handles this on its own.
- `npm run dev` alone opens a browser tab, but the UI is not usable there: every service calls `invoke(...)`, which only exists inside the Tauri window.
- There are no frontend tests. The only tests are the `#[cfg(test)] mod tests` block at the bottom of `src-tauri/src/main.rs`.
- Linux system packages (Ubuntu/Pop!_OS 22.04): `sudo apt-get install -y libwebkit2gtk-4.0-dev libsoup2.4-dev libayatana-appindicator3-dev librsvg2-dev patchelf build-essential libssl-dev libgtk-3-dev`.
- Build outputs: the binary is `src-tauri/target/release/zabb-leaf` (named from `productName`, not the crate name `zabbleaf`), and the bundle is `src-tauri/target/release/bundle/appimage/zabb-leaf_<version>_amd64.AppImage`.
- On Linux and macOS, `cargo` warns that `forget_git_program` is never used. That is expected: only the `#[cfg(windows)]` git installer calls it.
- `npm install` (which CI also uses, not `npm ci`) rewrites `package-lock.json` — its `version` field is stale and newer npm drops some `peer` flags. Don't commit that churn as part of unrelated work.
- `prebuild` / `pretauri` run `scripts/generate-icons.cjs`, which rewrites the committed files in `src-tauri/icons/`. Output is deterministic, so it should not dirty the tree.

CI (`.github/workflows/ci.yml`) runs frontend build → `cargo check` → `cargo test` → `npm run tauri build` on Windows, macOS and Linux for every push. It is the only place the non-host `#[cfg(...)]` branches get compiled at all.

### Releasing

The version lives in three places that must be bumped together: `package.json`, `src-tauri/Cargo.toml` (and `Cargo.lock`), `src-tauri/tauri.conf.json`. Pushing a `v*` tag triggers `release.yml`, which builds one installer per platform, renames them to `ZabbLeaf_{windows,mac,linux}_installer.*` (the README links to those exact names), and publishes with auto-generated notes — so commit subjects since the last tag are what users read.

## Architecture

### Split of responsibilities

**Everything that touches git or the disk is in Rust** — one file, `src-tauri/src/main.rs`, exposing `zl_*` Tauri commands. The webview never shells out and never uses the Tauri `fs` API. (The `isomorphic-git`, `lightning-fs` and `fake-indexeddb` dependencies are leftovers from an earlier in-webview approach and are not imported anywhere; don't build on them.)

**`pdfjs-dist` is not one of those leftovers — do not delete it.** `services/pdfEngine.ts` and `components/PDFViewer/PdfCanvasView.tsx` import it to rasterize the compiled PDF onto a canvas at the device pixel ratio; removing the dependency blanks the PDF pane. The iframe path in `PDFPreview` now only serves `html-preview`. `pdfEngine.ts` constructs the worker itself and hands pdf.js a `workerPort` rather than a `workerSrc`, because pdf.js's same-origin check misreads `tauri://localhost` (whose `URL.origin` serializes to `"null"`) and would route through an `importScripts` blob wry 0.24 does not allow; an 8 s watchdog falls back to a main-thread worker. `src/vite-env.d.ts` exists so `tsc` can resolve that `?url` worker import. `npm run build` emits `dist/assets/pdf.worker.min-<hash>.js` — without it the pane hangs for 8 s and then parses on the main thread.

`src/services/*.ts` are singletons. The ones that talk to the backend (`gitSync`, `localTeXCompiler`, `projectAssets`) are thin `invoke` wrappers that catch errors and return `{ success, message }`-style results rather than throwing. The rest (`textStats`, `todoScanner`, `latexErrors`, `latexSymbols`, `symbolPalette`, `writingStats`, `projectTemplates`) are pure functions over the in-memory file list.

`src/App.tsx` owns all application state — there is no router and no state library. It switches between a `home` view (`ProjectList`) and an `editor` view, and passes data and callbacks down to presentational components. Cross-component actions into Monaco go through nonce-stamped props (`insertion`, `revealLine`) rather than refs.

To add a backend capability: write a `#[tauri::command] fn zl_*` in `main.rs`, **register it in `generate_handler!` in `main()`**, and wrap it in a service. Tauri maps JS camelCase args to Rust snake_case params; returned structs with multi-word fields need `#[serde(rename_all = "camelCase")]`.

### On-disk layout

| Path | Contents |
| --- | --- |
| `~/.zabbleaf/projects/<projectId>/` | The cloned Overleaf repo (a normal git repository) |
| `~/.zabbleaf/build/<projectId>/` | `.aux`/`.log`/`.pdf` — deliberately outside the repo so `git add -A` never pushes them |

App state that must never reach Overleaf — project list, credentials, version history snapshots, writing stats, panel layout, chosen root document — is in `localStorage` under `zabbleaf_*` keys.

Project ids are either the Overleaf id or `local-<timestamp>` for projects created in the app. A `local-` project has files on disk but no `.git`; `zl_project_exists` (checks for `.git`) is how the app tells "linked to Overleaf" from "local only". Linking (`handleLinkToOverleaf`) clones an existing empty Overleaf project, copies the local files in, and re-ids the project — Overleaf's Git bridge cannot create projects.

### Backend invariants worth preserving

- **All git goes through `run_git`**, which disables every credential prompt (`credential.helper=`, `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`) so a bad token fails fast instead of hanging on a prompt a webview can't show, and which redacts the token (raw and percent-encoded) from stdout/stderr. `friendly_error` maps git's stderr to the user-facing message.
- **The token is never left in `.git/config`.** Clone and sync set `origin` to `https://git:<token>@…` for the duration of the operation and restore the clean URL on every exit path.
- **Sync = `add -A` → commit → `pull --rebase` → push.** If the rebase fails it is aborted, so the repo is never left mid-rebase or with conflict markers; the local commit survives and nothing is pushed. There is no conflict-resolution UI.
- **Every path from the frontend is validated**: `sanitize_project_id` (alphanumerics, `-`, `_`) and `safe_join` (no `..`, no `:`). Use `project_dir` / `build_dir` / `safe_join` rather than joining paths by hand.
- Byproducts that ignore `-output-directory` (e.g. `*-eps-converted-to.pdf`) are excluded via `.git/info/exclude`, not `.gitignore` — a `.gitignore` would show up in the user's Overleaf project.
- **Executables are resolved, not assumed to be on `PATH`**: `git_program()` and `resolve_engine()` probe known install directories, because a just-installed tool isn't on the running process's `PATH` and a Finder-launched macOS app never sees the shell `PATH`. `bibtex`, `mpm`/`tlmgr` are located relative to the resolved engine.
- `-enable-installer` is passed only when the engine's version banner says MiKTeX; TeX Live rejects the flag.
- Platform-specific installers (`install_git_for_platform`, `install_tex_distribution`) are written as one `#[cfg]`-gated function per platform rather than `cfg!` blocks inside one function, so a mistake in a foreign-platform branch is a compile error in CI rather than dead code.
- Installing system software (`zl_install_tex`, `zl_install_git`, `zl_install_package`) is only ever triggered by an explicit user click.

### Files vs. assets

`zl_read_project_files` recursively returns only text files (`TEXT_EXTENSIONS`, ≤ 4 MB) — that list is what the editor and every analysis service see. Images are a separate channel (`zl_*_project_asset`, base64 over IPC, ≤ 25 MB, stored under `figures/` with collision-suffixed names). `ASSET_EXTENSIONS` exists in both `main.rs` and `src/services/projectAssets.ts`; keep them identical. OS file drops arrive as *paths* via `appWindow.onFileDropEvent` (Tauri intercepts the DOM drop), so the copy happens in Rust via `zl_import_project_asset`.

### Editing and compiling

The `files` array in `App.tsx` is the source of truth while editing; keystrokes are written through to disk by `queueSave` (400 ms debounce per file). Anything that reads the disk — local compile, sync, the changes diff — first flushes files with `gitSyncEngine.writeFile`. Per-keystroke work is limited to the active file; project-wide scans (todos, project word count) run on `useDebouncedValue(files)`.

Three unrelated things sit behind the compiler dropdown (`CompilerEngine`):

- `pdflatex` / `xelatex` / `lualatex` → `zl_compile_project`: runs the engine with cwd = project dir (so `\input`, `.bib`, images resolve) and output in the build dir, runs `bibtex` plus two more passes when the root file has `\bibliography{`/`\addbibresource{`, otherwise one extra pass if the log says "Rerun". The PDF comes back base64-encoded and is shown from a blob URL.
- `html-preview` → `services/latexCompiler.ts`: despite the "WebAssembly" header comment, this is a regex-based LaTeX→HTML approximation, not a TeX engine. It also hosts `deriveProjectName`, used to replace the `Project abc123…` placeholder name, since the Git bridge never reveals a project's real name.
- `overleaf-cloud` → commits and pushes to the user's real Overleaf project, then opens it in the browser (Overleaf has no compile API and blocks framing). It requires a `window.confirm` and is deliberately excluded from auto-compile; keep it that way.

The compiled root is not necessarily the active file: `findRootDocuments` / `defaultRootDocument` pick files containing `\documentclass`, with a per-project override stored in `localStorage`.

`services/latexErrors.ts` (`explainLog`) turns a raw TeX log into `Diagnostic`s with a cause and fix; a diagnostic with `missingPackage` renders the one-click install button. New error explanations go there as rules, plus `COMMAND_PACKAGES` for "undefined control sequence → which package".

Credentials live in `gitSyncEngine` (`zabbleaf_git_credentials`); `overleafAuth.ts` is a mostly vestigial session wrapper, and `overleafApi.ts` is just the localStorage-backed project list — neither talks to Overleaf.

## Conventions

- Comments explain *why* — typically the concrete failure that led to the code — not what it does. Match that when adding code.
- Rust test names are full sentences describing the guarantee (`tokens_never_leak_into_reported_output`). New backend logic should be factored into a pure helper (like `tex_arguments`, `friendly_error`, `unique_asset_path`) so it can be tested without spawning processes.
- Destructive or outward-facing UI actions (push to Overleaf, delete file, log out, link project) confirm with `window.confirm` and say exactly what will happen to the Overleaf copy.

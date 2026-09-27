# Changelog

All notable changes to this extension are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.6] — 2026-09-27

### Added

- Watches **every** repository in the workspace instead of only the first.
  Each one is checked, notified about and merged independently, and toasts are
  prefixed with the repository name when more than one is watched.
- Repositories are found one level below a workspace folder as well as at the
  folder itself. Keeping `frontend/`, `backend/`, `serverless/` and `packages/`
  side by side and opening the parent folder now works — previously the
  extension stayed dormant, because the parent folder is not itself a
  repository.
- The status bar follows the file you are editing, showing that repository's
  state. With no matching file open it summarises instead: `↓6 in 3 repos`,
  or `4 repos in sync`. The tooltip lists every repository. With a single
  repository nothing changes.

### Changed

- First checks are staggered so several repositories do not all fetch at the
  same instant during startup.
- `node_modules`, `dist`, `build`, `.venv` and similar folders are skipped when
  looking for repositories, and at most 12 are watched.

## [0.1.5] — 2026-09-27

### Fixed

- Compare against the branch you actually cut from, not the repository's
  default branch. In a repo with several long-lived branches (`dev`, `uat`,
  `prod`), a branch created from `uat` was being compared against whatever
  `origin/HEAD` pointed at — reporting dozens of irrelevant incoming commits,
  and offering a merge that would have dragged unreleased work into a release
  branch.

  The branch point is read from what git and VS Code already record, in order:
  `branch.<name>.vscode-merge-base`, the branch's reflog (`Created from …`),
  then HEAD's reflog (`checkout: moving from … to …`). If nothing recorded it —
  a fresh clone, or an expired reflog — the parent is inferred from the most
  recent merge base, resolving ties by actual distance. `remoteBranch` still
  overrides everything.

## [0.1.4] — 2026-09-27

### Changed

- Bundled with esbuild. The published package is 55 KB across 8 files instead
  of 290 KB across 61, since `node_modules` is no longer shipped, and the
  extension activates faster.

## [0.1.3] — 2026-09-27

### Changed

- README feature list rewritten so it renders as a list on the Marketplace,
  which does not handle list items wrapped across lines.
- Development files (`.github/`, `PUBLISHING.md`, `media/icon.svg`) are no
  longer included in the published package.

## [0.1.2] — 2026-09-27

### Fixed

- A merge the user had not committed yet no longer triggers a "merge now?"
  prompt. Clicking it would only have failed, and the counts are misleading
  mid-merge. The status bar now shows `N conflicts to resolve` or
  `Finish merge`, and offers the merge editor or Source Control instead.

## [0.1.1] — 2026-09-27

### Added

- Fork support: a remote named `upstream` is preferred over `origin`, so
  contributors are compared against the repository their fork came from.
  Override with the new `gitSyncNotifier.remote` setting.
- Notifications name who pushed and quote the latest commit subject, e.g.
  *3 new commits on upstream/main from Alice and 1 other — latest: "refactor
  request handler" (12 minutes ago)*.
- **Details** button listing every incoming commit (subject, author, when,
  short SHA), returning to the prompt afterwards.
- Conflict-risk warning before merging: incoming files that this branch has
  also changed are counted in the notification and listed in the tooltip.
- Count of commits not yet pushed to the branch's own tracking branch.
- Status bar tooltip with all counts and the five newest incoming commits.

## [0.1.0] — 2026-09-27

### Added

- Background `git fetch` on a configurable interval and on window focus.
- Notification when the current branch falls behind, with **Merge Now** and
  **Dismiss**; nothing merges without an explicit click.
- Automatic default-branch detection (`origin/HEAD`, then `main`, `master`).
- Status bar item with behind/ahead counts, clickable to check on demand.
- Merge conflicts route to VS Code's 3-way merge editor.
- Dismissals remembered per commit range in `workspaceState`.
- Commands: *Check Upstream Now*, *Show Log*; output channel for diagnostics.

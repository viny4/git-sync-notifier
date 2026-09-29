# Changelog

All notable changes to this extension are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.8] — 2026-09-29

### Fixed

- A repository pinned to a commit (detached HEAD), or one with no commits yet,
  no longer reports an error. There is nothing to compare in either case, so it
  is logged once and otherwise ignored — previously every poll warned about it,
  which is constant noise for a repository that is deliberately pinned.
- "Window focused … skipping" was logged once per repository on every focus
  change. It is no longer logged at all.
- The status bar names the repository when exactly one is behind
  (`app ↓1`) instead of saying `↓1 in 1 repo`.

## [0.1.7] — 2026-09-29

### Added

- One summary notification instead of a stack of them. In a workspace with
  three or more repositories, when three or more fall behind at once you get
  *"6 repositories behind by 13 commits in total"* with **Review** — a
  multi-select picker listing each repository, how far behind it is and whether
  its incoming files overlap with your changes — and **Dismiss All**. Fewer
  repositories, or fewer behind, still notify individually as before.

### Changed

- At most three repositories fetch at the same time. Previously a window
  regaining focus, or one *Check Upstream Now*, made every repository fetch at
  once — ten simultaneous `git fetch` calls over a VPN is a visible stall.

## [0.1.6] — 2026-09-27

### Added

- Watches **every** repository in the workspace instead of only the first.
  Each one is checked, notified about and merged independently, and toasts are
  prefixed with the repository name when more than one is watched.
- Repositories come from VS Code's own git extension, so they are found at any
  depth — exactly the repositories listed in the Source Control panel, honouring
  `git.autoRepositoryDetection`. Opening a parent folder that holds several
  repositories now works; previously the extension reported "no git repository
  found in this workspace", because the folder itself is not a repository.
  A one-level scan of each workspace folder still runs as a fallback for when
  the built-in git extension is disabled or has not finished scanning.
- Reloads when VS Code discovers or closes a repository, debounced so a burst
  of discoveries causes one reload.
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

# Changelog

All notable changes to this extension are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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

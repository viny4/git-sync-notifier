# Git Upstream Sync Notifier

A VS Code extension that tells you when your branch has fallen behind the default
upstream branch (`origin/main`, `origin/master`, or whatever `origin/HEAD` points
at) and merges **only when you click Merge Now**. Nothing is ever merged in the
background.

## What it does

- **Never merges on its own.** Every merge happens because you clicked a button.
- **Fork-aware.** If a remote named `upstream` exists, that is what you are compared against — in a fork, `origin` is your own copy and the parent repository is the one you need to keep up with.
- **Compares against the branch you actually cut from**, not just the repository default. If your team runs `dev` / `uat` / `prod` and you branched from `uat`, that is what you are measured against.
- **Tells you who pushed.** *3 new commits on upstream/main from Alice and 1 other — latest: "refactor request handler" (12 minutes ago). Merge into feature?*
- **Warns about conflict risk before you merge.** ⚠️ *1 file overlap with your changes* means an incoming commit touches a file your branch also changed.
- **Details button** lists every incoming commit — subject, author, when, short SHA — and returns you to the prompt, so reviewing does not cost you the merge.
- **Three counts, not one.** Behind, ahead, and how many commits you have not pushed to your own fork yet.
- **Status bar** shows `↓3 ↑2`, or `In sync`. With several repositories open it follows the file you are editing, and summarises (`↓6 in 3 repos`) when the active file belongs to none of them. Hover for the full breakdown; click to check on demand.
- **Watches every repository in the workspace**, each independently — a frontend, a backend, some services, whether opened as a multi-root workspace or as one parent folder holding them all.
- **Conflicts go to VS Code's own merge editor.** Nothing is ever resolved programmatically.
- **Does not spam you.** One alert per new commit range, and errors are deduplicated so a flaky network stays quiet. With several repositories behind at once you get a single summary — *"6 repositories behind by 13 commits"* — and a picker, not six popups.
- Fetches on a configurable interval and when the window regains focus, throttled so the two do not double-fire.

## Install

From source, into your own VS Code:

```bash
npm install
npm run compile
npm run package              # produces git-sync-notifier-<version>.vsix
code --install-extension git-sync-notifier-*.vsix --force
```

Releasing it to the Marketplace is documented in [PUBLISHING.md](PUBLISHING.md).

To hack on it instead, open this folder in VS Code and press <kbd>F5</kbd>. That
starts the Extension Development Host with the `npm: watch` build task; open a
git repository in the new window to see the extension activate. Logs go to
**Output → Git Sync Notifier** (or run **Git Sync Notifier: Show Log**).

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `gitSyncNotifier.enabled` | `true` | Turn background checks off; also hides the status bar item. |
| `gitSyncNotifier.pollIntervalMinutes` | `5` | Minutes between fetches. Clamped to a 1-minute floor. |
| `gitSyncNotifier.remote` | `""` | Remote to compare against. Empty means auto-detect: `upstream` if it exists, else `origin`. |
| `gitSyncNotifier.remoteBranch` | `""` | Branch on that remote. Empty means auto-detect: the branch this one was created from, else `<remote>/HEAD`, then `main`, then `master`. |

All three are per-workspace-folder settable, so a repo whose integration branch
is `develop` can pin `gitSyncNotifier.remoteBranch` in `.vscode/settings.json`.

## Commands

| Command | Palette entry |
| --- | --- |
| `gitSyncNotifier.checkNow` | Git Sync Notifier: Check Upstream Now |
| `gitSyncNotifier.showLog` | Git Sync Notifier: Show Log |

A manual check always reports its result, including "already up to date" and any
range you previously dismissed.

## How notification spam is avoided

When you dismiss a notification, the extension records
`<repo>::<branch> → <remote-branch>:<HEAD sha>..<upstream sha>` in
`workspaceState`. Later polls stay silent while that signature is unchanged. A
new commit on either side — upstream or yours — produces a different signature
and is allowed to notify again. A successful merge clears the record, so if the
branch falls behind again you hear about it.

Background errors are also deduplicated: the same failure code toasts once, then
only updates the status bar until the error changes or you check manually.

## Behaviour notes

- If no workspace folder is inside a git repository, the extension stays
  dormant: no status bar item, no polling.
- Every repository in the workspace is watched, including sibling repositories
  one level below a workspace folder — so opening a parent folder that holds
  `frontend/`, `backend/` and friends works without a multi-root workspace.
  `node_modules` and similar build folders are skipped, and at most 12
  repositories are watched.
- On a detached HEAD there is no branch to merge into, so checks stop with a
  message rather than guessing.
- If a merge is already in progress, or the working tree has changes that the
  merge would overwrite, the merge is refused with an explanation instead of
  being forced.

## Project layout

```
src/
├── extension.ts    # activation, repository discovery, polling/focus triggers
├── gitService.ts   # every git call (fetch, rev-list, merge, branch detection)
├── notifier.ts     # notifications and routing to the merge editor
├── statusBar.ts    # the one status bar item, shared across repositories
├── summary.ts      # batches simultaneous "behind" reports into one message
├── scheduler.ts    # caps how many repositories fetch at the same time
├── config.ts       # workspace settings
├── state.ts        # workspaceState: which commit ranges were dismissed
└── logger.ts       # "Git Sync Notifier" output channel
```

`gitService.ts` has no `vscode` import, which is what let the git behaviour
(both default-branch names, clean merges, conflicts, dirty tree, unreachable
remote, empty repo) be exercised against real throwaway repositories outside the
Extension Development Host.

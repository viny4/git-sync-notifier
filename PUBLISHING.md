# Publishing and maintenance

How this extension gets released, and what to do when changing it later.

## One-time setup

1. **Microsoft / Azure DevOps account.** Marketplace publishing runs on Azure
   DevOps. Sign in at <https://dev.azure.com> with a Microsoft account.

2. **Create the publisher.** Go to
   <https://marketplace.visualstudio.com/manage>, create a publisher, and note
   its **ID** (not the display name). `package.json` currently says
   `"publisher": "viny4"` — it must match that ID exactly, or publishing is
   rejected.

3. **Create a Personal Access Token.** In Azure DevOps → User settings →
   Personal access tokens → New token:
   - Organization: **All accessible organizations** (this trips people up — a
     single-org token fails)
   - Scopes: **Custom defined** → *Marketplace* → **Manage**
   - Expiry: up to one year

   Copy it; it is shown once.

4. **Log in locally.**

   ```bash
   npx @vscode/vsce login viny4     # paste the PAT when prompted
   ```

## Releasing a version

```bash
npm run compile                   # must be clean
npm run package                   # builds the .vsix locally
code --install-extension git-sync-notifier-<version>.vsix --force   # smoke test
```

Then, once the .vsix behaves:

```bash
npm version patch                 # or: minor / major — updates package.json
# write the CHANGELOG entry for the new version
git add -A && git commit -m "release: v$(node -p "require('./package.json').version")"
git tag "v$(node -p "require('./package.json').version")" && git push --follow-tags
npx @vscode/vsce publish
```

`vsce publish patch` can bump and publish in one step, but bumping separately
keeps the tag, the changelog, and the marketplace in agreement.

The listing goes live in a few minutes. Verify at
`https://marketplace.visualstudio.com/items?itemName=viny4.git-sync-notifier`.

### Pre-release channel

For testing a risky change on real users who opt in:

```bash
npx @vscode/vsce publish --pre-release
```

VS Code offers those builds only to people who click "Switch to Pre-Release
Version". Keep the stable channel on even minor versions and pre-release on odd
ones if you adopt this.

### VS Codium / Open VSX (optional)

The Microsoft marketplace is not available to VS Codium users. Publishing there
too is one extra command, with a token from <https://open-vsx.org>:

```bash
npx ovsx publish git-sync-notifier-<version>.vsix -p <open-vsx-token>
```

## Release checklist

- [ ] `npm run compile` is clean
- [ ] Installed the .vsix locally and exercised: behind → merge, conflict →
      merge editor, dismiss → no repeat, fork repo → `upstream` chosen
- [ ] `CHANGELOG.md` has an entry for the version
- [ ] `README.md` documents any new setting or command
- [ ] Version bumped, tagged, pushed
- [ ] Published, then installed from the Marketplace in a clean window

## Versioning policy

- **patch** — bug fixes, wording, docs.
- **minor** — new settings, commands, or notification behaviour.
- **major** — anything that changes existing defaults in a way users would
  notice, e.g. changing which remote is compared by default.

Marketplace versions are immutable: a published version number can never be
reused, only superseded. Mistakes are fixed by publishing the next patch.

## Working on the extension

```bash
npm install
npm run watch     # leave running
```

Press F5 (Run → Start Debugging) for the Extension Development Host, or install
the packaged .vsix. Logs: **Output → Git Sync Notifier**.

### Where things live

| File | Responsibility |
| --- | --- |
| `src/extension.ts` | activation, poll/focus triggers, the check→prompt→merge flow |
| `src/gitService.ts` | every git call; **no `vscode` import**, deliberately |
| `src/notifier.ts` | notification text, status bar, merge-editor routing |
| `src/config.ts` | settings |
| `src/state.ts` | which commit ranges were dismissed |
| `src/logger.ts` | output channel |

`gitService.ts` avoids importing `vscode` so its behaviour can be exercised
against real throwaway repositories from plain Node, without an Extension
Development Host. That is how the fork, conflict, dirty-tree, detached-HEAD and
mid-merge cases were verified. Keep it that way: **git logic goes in
`gitService.ts`, never in `notifier.ts` or `extension.ts`.**

### Adding a setting

1. Declare it under `contributes.configuration.properties` in `package.json`.
2. Read it in `src/config.ts` (add to `SyncConfig`, clamp or validate there).
3. Document it in the README settings table.
4. Changing settings already re-applies live — `onDidChangeConfiguration` calls
   `applyConfig()`, which resets the poll timer.

### Testing

There is no automated test suite yet. The highest-value next step is porting the
throwaway-repo harnesses into `@vscode/test-cli` + `mocha` so CI can run them:

```bash
npm i -D @vscode/test-cli @vscode/test-electron mocha @types/mocha
```

Cases worth covering first, all reproducible with a bare repo plus two clones:
default branch `main` vs `master`, `upstream` preferred over `origin`, behind /
ahead / unpushed counts, overlap detection, conflicted merge, dirty worktree,
merge already in progress, detached HEAD, repo with no commits, unreachable
remote.

## Roadmap ideas

Roughly in order of value per unit of work:

1. **Bundle with esbuild.** Ships one file instead of `node_modules`, cutting
   package size and activation time. `npm i -D esbuild`, add an
   `esbuild.js`, point `main` at `dist/extension.js`, and add `dist/**` to the
   packaged files while ignoring `out/**`.
2. **Watch every repo in a multi-root workspace,** not just the first one. Needs
   one controller per repo and a status bar item that follows the active editor.
3. **Snooze instead of only Dismiss** — "remind me in an hour".
4. **Offer rebase as well as merge**, for teams with a linear-history rule.
5. **Sync the fork's default branch**, the other classic fork chore:
   `git fetch upstream && git push origin upstream/main:main`.
6. **Optional GitHub enrichment** — PR number, CI status, avatars. Needs a token
   and network, so it must be opt-in and degrade silently.
7. **Automated tests in CI** (see above), which becomes urgent as soon as anyone
   else contributes.

## Things to be careful about

- **Never merge without an explicit click.** It is the core promise of the
  extension; keep every git-mutating call behind a user action.
- **simple-git resolves rather than throws** when a git command exits non-zero
  with empty stderr (e.g. `rev-parse --verify --quiet`). Check the *output*, not
  just the absence of an exception — this caused a real bug where `main` always
  won over `master`.
- **Conflict detection trusts the index** (`git diff --diff-filter=U`) as well
  as git's message text, so a wording change upstream cannot turn a conflict
  into a silent success. Keep both checks.
- **Errors are deduplicated** by error code so a flaky network cannot spam
  notifications. New failure modes should reuse that path in
  `SyncController.handleError`.

# The extension developer's guide

Everything you need after the first publish: the rules you are agreeing to, how
to add a feature to this extension, and how to start a new one.

Three documents, so you know where to look:

| Document | What it covers |
| --- | --- |
| [README.md](README.md) | What the extension does, for users |
| [PUBLISHING.md](PUBLISHING.md) | The mechanics: tokens, release commands, roadmap |
| **GUIDE.md** (this one) | The rules, and how to build more |

---

# Part 1 — Rules and regulations

When you published, you accepted the **Marketplace Publisher Agreement**. These
are the parts that actually affect you. The agreement itself is the authority
and it changes over time — the summaries here are orientation, not legal advice.

- Publisher Agreement: <https://aka.ms/vsmarketplace-ToU>
- Marketplace FAQ: <https://code.visualstudio.com/docs/editor/extension-marketplace>
- Publishing docs: <https://code.visualstudio.com/api/working-with-extensions/publishing-extension>

## The hard rules

**1. A published version can never be changed or deleted.**
`0.1.2` is on the Marketplace forever. If you ship a bug, you fix it by
publishing `0.1.3`. There is no "replace this file" button. This is why the
release checklist says to install the `.vsix` and click through it *before*
publishing.

**2. Your extension ID is permanent.**
`viny4.git-sync-notifier` is yours forever, even if you unpublish. You cannot
rename it. Publishing under a new name creates a *different* extension, and your
existing users are not migrated — they keep the old one until they uninstall it.

**3. Every upload is scanned.**
Each version goes through automated validation (malware, manifest sanity) before
it becomes public. That is why a publish can say `DONE` while the Marketplace
still serves the previous version for a few minutes. If validation fails, the
version is rejected and you will see it in the publisher hub:
<https://marketplace.visualstudio.com/manage/publishers/viny4>

**4. No malicious or deceptive behaviour.** Concretely, the things that get an
extension pulled:

- Code that does something the description does not disclose — exfiltrating
  source, credentials, or file contents; mining cryptocurrency; installing other
  software.
- Obfuscated or remotely-fetched code that runs without the user's knowledge.
  Bundled and minified is fine; deliberately hiding what it does is not.
- Impersonating another publisher or extension — using Microsoft, GitHub, or any
  company's name, logo, or branding in a way that implies endorsement.
- Keyword stuffing the description or tags to hijack searches.
- Manipulating ratings, installs, or reviews.

**5. Respect the user's settings.** If you ever add telemetry, you must disclose
it in the README and honour `telemetry.telemetryLevel`. This extension collects
nothing, which is the easiest position to defend — keep it that way unless you
have a strong reason.

**6. Ship a licence.** Yours is MIT, in [LICENSE](LICENSE), and it is packaged
with the extension. Without one, users legally cannot use your code, and the
Marketplace flags the listing.

**7. Only ship code you have the right to ship.** Your dependencies are part of
your extension. `simple-git` is MIT, which is compatible. If you ever add a
GPL-licensed dependency, that has consequences for your own licensing — check
before adding.

## Naming

- **Publisher ID** (`viny4`) — permanent, must match `package.json`.
- **Publisher display name** (`Vinayagam`) — must be globally unique. This is
  what rejected `vinay`.
- **Extension name** (`git-sync-notifier`) — permanent, lowercase, no spaces.
- **Display name** (`Git Upstream Sync Notifier`) — change freely between
  versions.

Do not put "VS Code", "Visual Studio", or "Microsoft" in your display name. It
implies an official product and is the most common reason listings get
challenged.

## What you are signing up for

Publishing is free, and there is no obligation to support anything. But a
listing creates expectations:

- **Q & A tab** — users ask questions there. Either answer them or disable the
  tab and point at GitHub Issues via `qna` in `package.json`.
- **Issues** — your listing links to your GitHub issues. Unanswered issues are
  the fastest way to collect one-star reviews.
- **Breaking changes** — changing a default (say, which remote is compared)
  silently changes behaviour for everyone on auto-update. Bump the **major**
  version and write it in the changelog.

## Unpublishing

```bash
npx @vscode/vsce unpublish viny4.git-sync-notifier
```

This removes the listing. Existing installs keep working but stop receiving
updates. The ID stays reserved to you. Only do this if the extension is
genuinely abandoned or harmful — an unmaintained extension with a note in the
README serves users better than a dead link.

## Verified publisher (optional, costs money)

The blue checkmark requires a domain you own (about $10/year) plus a DNS TXT
record. It affects nothing functional — installs, updates, and search all work
identically without it.

---

# Part 2 — Adding a feature to this extension

## The loop

```bash
cd "/Users/vinayagam/git upstream extension"
npm run watch          # leave this running; recompiles on save
```

Press F5 (or Run → Start Debugging) for the Extension Development Host. If F5
gives you trouble, install the packaged build instead:

```bash
npm run package && code --install-extension git-sync-notifier-*.vsix --force
```

...then reload the window. Logs are in **Output → Git Sync Notifier**.

## Where code goes

| Want to change… | File |
| --- | --- |
| A git command, or anything git decides | `src/gitService.ts` |
| Notification wording, buttons, status bar, tooltips | `src/notifier.ts` |
| When checks run, and what happens with the result | `src/extension.ts` |
| A new setting | `package.json` + `src/config.ts` |
| What counts as "already told them about this" | `src/state.ts` |

**The one architectural rule: `gitService.ts` must never import `vscode`.**
That is what lets you test git behaviour against real repositories from plain
Node, without launching an editor. Every bug found in this project so far was
found that way. If you put a `vscode.window.showMessage` in there, you lose it.

## Worked example: adding a "Snooze 1 hour" button

1. **State** — `src/state.ts`: add `snoozeUntil(signature, timestamp)` and
   `isSnoozed(signature)`, stored in the same memento map.
2. **Notifier** — `src/notifier.ts`: add `SNOOZE` to the button list in
   `promptBehind`, and return `'snooze'` as a new `BehindChoice`.
3. **Extension** — `src/extension.ts`: handle `'snooze'` in the prompt loop by
   calling the new state method; check `isSnoozed` alongside `isDismissed`
   before prompting.
4. **Manifest** — add `gitSyncNotifier.snoozeMinutes` under
   `contributes.configuration.properties` if it should be configurable.
5. **Config** — read it in `src/config.ts`, clamp it there.
6. **Docs** — README settings table, CHANGELOG entry.
7. **Test** — run the extension, snooze, confirm silence, confirm it returns.
8. **Ship** — `npm version minor` (new feature), commit, publish.

That order — state, then presentation, then wiring, then manifest, then docs —
works for almost any feature here.

## Testing git behaviour without VS Code

Because `gitService.ts` is `vscode`-free, you can drive it from a script:

```js
const { GitService } = require('./out/gitService.js');
// build throwaway repos with execFileSync('git', [...]), then:
const svc = await GitService.open('/tmp/some-test-repo');
console.log(await svc.getStatus(await svc.detectComparisonRemote(), 'main'));
```

Create a bare repo as the "remote", clone it twice, commit in one clone, push,
and check what the service reports in the other. That reproduces every scenario
this extension handles: fork setups, conflicts, dirty trees, detached HEAD,
mid-merge states.

The next real improvement is turning those scripts into a suite that CI runs —
see the Roadmap in [PUBLISHING.md](PUBLISHING.md).

## Release checklist (short version)

```bash
npm run compile                    # clean
npm run package                    # build .vsix
code --install-extension git-sync-notifier-*.vsix --force   # actually click through it
npm version patch|minor|major      # bump
# write the CHANGELOG entry
git add -A && git commit -m "..." && git push
npx @vscode/vsce publish
```

Then wait a few minutes — the Marketplace serves the old version until
validation finishes. Check with `npx @vscode/vsce show viny4.git-sync-notifier`.

---

# Part 3 — Building a new extension

## Scaffolding

```bash
npx --package yo --package generator-code -- yo code
```

Answer: **New Extension (TypeScript)**, give it a name, choose npm, and it
generates the skeleton. Or copy this project and strip `src/` — the
`tsconfig.json`, `.vscode/launch.json`, `.vscodeignore`, and the two GitHub
workflows are all reusable as-is.

## The three things every extension has

**1. Activation** — when your code loads. In `package.json`:

```json
"activationEvents": ["onStartupFinished"]
```

Common triggers: `onStartupFinished` (after the editor settles),
`onLanguage:python` (when a Python file opens), `workspaceContains:**/pom.xml`
(when the workspace matches). Commands and views activate automatically from
their own contributions — you do not need to list them.

Activating lazily matters: an extension that loads on startup in every window
and does nothing is what makes editors feel slow.

**2. Contribution points** — what you add to the UI, declared in
`contributes`. The main ones:

| Contribution | What it gives you |
| --- | --- |
| `commands` | Command Palette entries |
| `configuration` | Settings under your own namespace |
| `keybindings` | Default shortcuts |
| `menus` | Items in context menus, editor title bars, the SCM view |
| `views` / `viewsContainers` | Your own sidebar panels and tree views |
| `languages`, `grammars`, `snippets` | Language support, syntax, snippets |
| `themes`, `iconThemes` | Colour and icon themes |
| `debuggers`, `taskDefinitions` | Debug adapters, custom task types |
| `walkthroughs` | The onboarding pages in the Welcome tab |

Full reference: <https://code.visualstudio.com/api/references/contribution-points>

**3. The API** — `vscode.*` in your `activate()`. The areas you will reach for:
`window` (messages, status bar, editors, quick picks), `workspace` (files,
settings, folders), `commands`, `languages` (diagnostics, completions),
`tasks`, `debug`, and webviews when you need real HTML.

Full API: <https://code.visualstudio.com/api/references/vscode-api>

## Ideas, by difficulty

- **Easy** — a command that transforms the selected text; a status bar item
  showing something about the current file; a snippet pack.
- **Medium** — a tree view listing something from your project (TODOs, API
  routes, migrations); a settings-driven linter wrapper writing diagnostics.
- **Harder** — a language server; a debug adapter; a webview panel with a real
  UI inside it.

## Publishing a second extension

You already have the publisher and the token, so it is just:

```bash
cd my-new-extension
npx @vscode/vsce publish
```

Provided `package.json` has `"publisher": "viny4"`, a unique `name`, an `icon`,
a `repository`, a `LICENSE`, and a README worth reading — the README *is* your
Marketplace page, so write it for someone deciding whether to install.

If your token has expired (they last up to a year), create a new one the same
way and `npx @vscode/vsce login viny4` again. See [PUBLISHING.md](PUBLISHING.md).

## A checklist for anything you publish

- [ ] Display name does not imply Microsoft/VS Code endorsement
- [ ] README explains what it does and any permissions or network access
- [ ] LICENSE file present
- [ ] `icon` set, 128×128 PNG
- [ ] `repository` set, and the repo is public if you want issue reports
- [ ] Activation is as lazy as it can be
- [ ] No telemetry, or telemetry disclosed and honouring the user's setting
- [ ] Installed the `.vsix` and used it yourself before publishing
- [ ] CHANGELOG entry written

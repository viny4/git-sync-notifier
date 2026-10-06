// Drives the bundled extension with a stubbed `vscode`: what the user actually
// sees — how many notifications, saying what, and how often.
const fs = require('fs');
const path = require('path');
const {
  check,
  section,
  tempDir,
  git,
  commitAs,
  makeVsCodeStub,
  loadExtension,
  fakeContext,
  sleep
} = require('./support/harness');

const BUNDLE = path.join(__dirname, '..', 'dist', 'extension.js');

/** A workspace folder holding `specs` repositories; returns their roots. */
function buildWorkspace(root, specs) {
  const ws = path.join(root, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const roots = [];
  for (const { name, behind = 0, detached = false } of specs) {
    git(root, 'init', '-q', '--bare', '-b', 'main', `${name}.git`);
    const bare = path.join(root, `${name}.git`);
    git(ws, 'clone', '-q', bare, name);
    const repo = path.join(ws, name);
    roots.push(repo);
    commitAs(repo, 'Dev', 'a.txt', 'a\n', 'init');
    commitAs(repo, 'Dev', 'b.txt', 'b\n', 'second');
    git(repo, 'push', '-q', '-u', 'origin', 'main');
    if (behind > 0) {
      git(root, 'clone', '-q', bare, `${name}-peer`);
      const peer = path.join(root, `${name}-peer`);
      for (let i = 0; i < behind; i++) {
        commitAs(peer, 'Peer', 'c.txt', `c${i}\n`, `upstream change ${i}`);
      }
      git(peer, 'push', '-q', 'origin', 'main');
    }
    if (detached) {
      git(repo, 'checkout', '-q', '--detach', 'HEAD~1');
    }
  }
  return { ws, roots };
}

async function activate({ ws, roots, answers, config }) {
  const { stub, recorded } = makeVsCodeStub({
    workspaceFolders: [ws],
    repositories: roots,
    answers: { ...answers, config }
  });
  const { extension, restore } = loadExtension(stub, BUNDLE);
  const context = fakeContext();
  await extension.activate(context);
  return { recorded, extension, restore };
}

const toastsOf = (recorded) => recorded.toasts.filter((t) => !t.startsWith('WARN:'));

module.exports = async function run() {
  const root = tempDir('gsn-notify-');

  section('repositories announced once, even when discovery is noisy');
  {
    const { ws, roots } = buildWorkspace(path.join(root, 'dup'), [
      { name: 'alpha', behind: 1 },
      { name: 'beta', behind: 1 }
    ]);
    const { recorded, extension, restore } = await activate({
      ws,
      roots,
      config: { pollIntervalMinutes: 1 }
    });
    // VS Code announces repositories in a burst while setup is still running.
    for (let i = 0; i < 5; i++) {
      recorded.openRepositoryListener?.();
    }
    await sleep(12000);
    const toasts = toastsOf(recorded);
    check('one notification per repository', toasts.length, 2);
    check(
      'each repository named exactly once',
      [toasts.filter((t) => t.startsWith('alpha:')).length, toasts.filter((t) => t.startsWith('beta:')).length],
      [1, 1]
    );

    section('an unanswered notification is not repeated at the next poll');
    recorded.toasts.length = 0;
    await sleep(70000);
    check('stayed quiet', toastsOf(recorded).length, 0);
    extension.deactivate();
    restore();
  }

  section('a repository pinned to a commit is not an error');
  {
    const { ws, roots } = buildWorkspace(path.join(root, 'det'), [
      { name: 'app', behind: 1 },
      { name: 'api' },
      { name: 'common-lambda-lib', detached: true }
    ]);
    const { recorded, extension, restore } = await activate({ ws, roots });
    await sleep(14000);
    const toasts = toastsOf(recorded);
    check('only the repository that is behind notifies', toasts.length, 1);
    check('and it is the right one', toasts[0]?.startsWith('app:'), true);
    check(
      'the pinned repository produced no warning',
      recorded.toasts.some((t) => t.startsWith('WARN:')),
      false
    );
    check(
      'it was logged once, as information',
      recorded.logs.filter((l) => /detached/i.test(l)).length,
      1
    );
    check('the status bar names the single repository behind', recorded.statusText, 'app $(cloud-download) ↓1');
    extension.deactivate();
    restore();
  }

  section('many repositories behind become one summary');
  {
    const specs = [1, 0, 2, 3, 0, 4, 0, 1, 2, 0].map((behind, i) => ({
      name: `repo${i}`,
      behind
    }));
    const { ws, roots } = buildWorkspace(path.join(root, 'many'), specs);
    const { recorded, extension, restore } = await activate({
      ws,
      roots,
      answers: { informationMessage: async () => undefined }
    });
    await sleep(40000);
    const toasts = toastsOf(recorded);
    check('a single notification', toasts.length, 1);
    check('which summarises', toasts[0], '6 repositories behind by 13 commits in total.');
    check('offering Review and Dismiss All', recorded.lastButtons, ['Review', 'Dismiss All']);
    check('status bar totals them', recorded.statusText, '$(cloud-download) ↓13 in 6 repos');
    extension.deactivate();
    restore();
  }
};

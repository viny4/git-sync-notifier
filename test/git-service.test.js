// Exercises gitService against real throwaway repositories. No vscode involved.
const fs = require('fs');
const path = require('path');
const {
  check,
  section,
  tempDir,
  git,
  commitAs,
  pushUpstreamCommits
} = require('./support/harness');
const {
  GitService,
  summarizeAuthors,
  parseSlug
} = require('../out/gitService.js');

const root = tempDir('gsn-git-');

async function coreScenario(defaultBranch) {
  section(`default branch: ${defaultBranch}`);
  const base = path.join(root, defaultBranch);
  fs.mkdirSync(base, { recursive: true });
  git(base, 'init', '-q', '--bare', '-b', defaultBranch, 'origin.git');
  const bare = path.join(base, 'origin.git');
  git(base, 'clone', '-q', bare, 'work');
  const work = path.join(base, 'work');
  commitAs(work, 'Dev', 'shared.txt', 'line one\n', 'initial');
  git(work, 'push', '-q', '-u', 'origin', defaultBranch);
  git(base, 'clone', '-q', bare, 'peer');
  const peer = path.join(base, 'peer');

  const svc = await GitService.open(work);
  const remote = await svc.detectComparisonRemote();
  check('remote auto-picked', remote.name, 'origin');
  check('default branch detected', await svc.detectDefaultBranch('origin'), defaultBranch);

  git(work, 'checkout', '-q', '-b', 'feature', defaultBranch);
  commitAs(peer, 'Peer', 'other.txt', 'p1\n', 'peer change 1');
  commitAs(peer, 'Peer', 'other.txt', 'p2\n', 'peer change 2');
  git(peer, 'push', '-q', 'origin', defaultBranch);
  await svc.fetchRemote('origin');

  let status = await svc.getStatus(remote, defaultBranch);
  check('behind 2 / ahead 0', [status.behind, status.ahead], [2, 0]);

  commitAs(work, 'Dev', 'local.txt', 'mine\n', 'local work');
  status = await svc.getStatus(remote, defaultBranch);
  check('behind 2 / ahead 1 after a local commit', [status.behind, status.ahead], [2, 1]);

  check('clean merge', (await svc.mergeFrom('origin', defaultBranch)).kind, 'merged');
  status = await svc.getStatus(remote, defaultBranch);
  check('behind 0 after merging', status.behind, 0);
  check('merging again is a no-op', (await svc.mergeFrom('origin', defaultBranch)).kind, 'up-to-date');

  commitAs(work, 'Dev', 'shared.txt', 'local rewrite\n', 'local rewrite');
  commitAs(peer, 'Peer', 'shared.txt', 'peer rewrite\n', 'peer rewrite');
  git(peer, 'push', '-q', 'origin', defaultBranch);
  await svc.fetchRemote('origin');
  const conflict = await svc.mergeFrom('origin', defaultBranch);
  check('conflict detected', [conflict.kind, conflict.files], ['conflict', ['shared.txt']]);
  check('merge reported in progress', await svc.isMergeInProgress(), true);
  try {
    await svc.mergeFrom('origin', defaultBranch);
    check('merging during a merge is refused', false, true);
  } catch (error) {
    check('merging during a merge is refused', error.code, 'merge-in-progress');
  }
  git(work, 'merge', '--abort');

  commitAs(peer, 'Peer', 'shared.txt', 'peer again\n', 'peer change 3');
  git(peer, 'push', '-q', 'origin', defaultBranch);
  await svc.fetchRemote('origin');
  fs.appendFileSync(path.join(work, 'shared.txt'), 'uncommitted\n');
  try {
    await svc.mergeFrom('origin', defaultBranch);
    check('dirty worktree refused', false, true);
  } catch (error) {
    check('dirty worktree refused', error.code, 'dirty-worktree');
  }
  git(work, 'checkout', '--', 'shared.txt');

  git(work, 'checkout', '-q', '--detach', 'HEAD');
  try {
    await svc.currentBranch();
    check('detached HEAD reported', false, true);
  } catch (error) {
    check('detached HEAD reported', error.code, 'detached-head');
  }
  git(work, 'checkout', '-q', 'feature');

  try {
    await svc.getStatus(remote, 'nope');
    check('missing remote branch reported', false, true);
  } catch (error) {
    check('missing remote branch reported', error.code, 'missing-remote-branch');
  }

  git(work, 'update-ref', '-d', 'refs/remotes/origin/HEAD');
  check(
    'falls back to main/master without origin/HEAD',
    await svc.detectDefaultBranch('origin'),
    defaultBranch
  );
}

async function forkScenario() {
  section('fork workflow');
  const base = path.join(root, 'fork');
  fs.mkdirSync(base, { recursive: true });
  git(base, 'init', '-q', '--bare', '-b', 'main', 'parent.git');
  git(base, 'clone', '-q', path.join(base, 'parent.git'), 'seed');
  const seed = path.join(base, 'seed');
  commitAs(seed, 'Maintainer', 'app.js', 'v1\n', 'initial');
  git(seed, 'push', '-q', 'origin', 'main');
  git(base, 'clone', '-q', '--bare', path.join(base, 'parent.git'), 'fork.git');
  git(base, 'clone', '-q', path.join(base, 'fork.git'), 'work');
  const work = path.join(base, 'work');
  git(work, 'remote', 'add', 'upstream', path.join(base, 'parent.git'));
  git(work, 'fetch', '-q', 'upstream');

  const svc = await GitService.open(work);
  const remote = await svc.detectComparisonRemote();
  check('upstream preferred over origin', remote.name, 'upstream');
  check('fork detected', await svc.isFork(remote), true);
  check('explicit remote override honoured', (await svc.detectComparisonRemote('origin')).name, 'origin');

  git(work, 'checkout', '-q', '-b', 'feature', 'origin/main');
  commitAs(work, 'Me', 'app.js', 'mine\n', 'my work');
  git(work, 'push', '-q', '-u', 'origin', 'feature');
  commitAs(work, 'Me', 'notes.md', 'n\n', 'wip');
  commitAs(seed, 'Alice', 'app.js', 'v2\n', 'refactor handler');
  commitAs(seed, 'Bob', 'utils.js', 'u\n', 'add utils');
  git(seed, 'push', '-q', 'origin', 'main');
  await svc.fetchForComparison('upstream');

  const status = await svc.getStatus(remote, 'main');
  check('behind 2 / ahead 2', [status.behind, status.ahead], [2, 2]);
  check('unpushed commits counted', status.unpushed, 1);
  check('push target identified', status.pushTarget, 'origin/feature');
  check('authors summarised', summarizeAuthors(status.commits), 'Bob and 1 other');
  check('overlapping files detected', status.overlapFiles, ['app.js']);
}

async function errorScenario() {
  section('error classification');
  const plain = path.join(root, 'plain');
  fs.mkdirSync(plain, { recursive: true });
  check('a non-repository stays dormant', await GitService.open(plain), undefined);

  const solo = path.join(root, 'solo');
  fs.mkdirSync(solo, { recursive: true });
  git(solo, 'init', '-q', '-b', 'main');
  commitAs(solo, 'Dev', 'a.txt', 'a\n', 'only commit');
  const svc = await GitService.open(solo);
  try {
    await svc.fetchRemote('origin');
    check('missing remote reported', false, true);
  } catch (error) {
    check('missing remote reported', error.code, 'no-remote');
  }
  git(solo, 'remote', 'add', 'origin', 'https://nonexistent.invalid/repo.git');
  try {
    await svc.fetchRemote('origin');
    check('unreachable remote classified as network', false, true);
  } catch (error) {
    check('unreachable remote classified as network', error.code, 'network');
  }

  check('slug: github ssh', parseSlug('git@github.com:org/repo.git'), 'org/repo');
  check('slug: https', parseSlug('https://github.com/org/repo.git'), 'org/repo');
  check('slug: nested gitlab group', parseSlug('https://gitlab.com/group/sub/repo'), 'group/sub/repo');
  check('slug: bare local path', parseSlug('/local/path/repo.git'), undefined);
}

// Uncommitted work is the usual reason a merge is refused. The extension
// offers to set it aside; these cover what happens when it does.
async function stashScenario() {
  const base = path.join(root, 'stash');
  fs.mkdirSync(base, { recursive: true });
  git(base, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  const bare = path.join(base, 'origin.git');
  git(base, 'clone', '-q', bare, 'work');
  const work = path.join(base, 'work');
  commitAs(work, 'Dev', 'shared.txt', 'line one\n', 'initial');
  commitAs(work, 'Dev', 'mine.txt', 'mine\n', 'my file');
  git(work, 'push', '-q', '-u', 'origin', 'main');
  git(base, 'clone', '-q', bare, 'peer');
  const peer = path.join(base, 'peer');
  const svc = await GitService.open(work);

  section('a merge is refused while the tree is dirty');
  commitAs(peer, 'Peer', 'shared.txt', 'line one\nupstream\n', 'upstream change');
  git(peer, 'push', '-q', 'origin', 'main');
  await svc.fetchRemote('origin');
  fs.writeFileSync(path.join(work, 'shared.txt'), 'line one\nmy edit\n');
  check('the dirty file is reported', await svc.localChanges(), ['shared.txt']);
  try {
    await svc.mergeFrom('origin', 'main');
    check('merge refused', false, true);
  } catch (error) {
    check('merge refused', error.code, 'dirty-worktree');
  }

  section('stashing lets the merge through and puts the work back');
  // The edit touches the same file as the incoming commit, so popping the
  // stash conflicts — the stash is kept, which is the whole point.
  let result = await svc.mergeFrom('origin', 'main', { stashLocalChanges: true });
  check('the merge itself succeeded', result.kind, 'merged');
  check('the work came back with conflicts', result.stash.kind, 'restored-with-conflicts');
  check('and the stash is still saved', git(work, 'stash', 'list').trim().length > 0, true);
  git(work, 'checkout', '-q', '--ours', '--', 'shared.txt');
  git(work, 'reset', '-q', '--hard', 'HEAD');
  git(work, 'stash', 'drop', '-q');

  section('untouched work is restored cleanly');
  commitAs(peer, 'Peer', 'theirs.txt', 'theirs\n', 'unrelated upstream change');
  git(peer, 'push', '-q', 'origin', 'main');
  await svc.fetchRemote('origin');
  fs.writeFileSync(path.join(work, 'mine.txt'), 'mine, edited\n');
  result = await svc.mergeFrom('origin', 'main', { stashLocalChanges: true });
  check('merged', result.kind, 'merged');
  check('work restored', result.stash.kind, 'restored');
  check('the edit is still there', fs.readFileSync(path.join(work, 'mine.txt'), 'utf8'), 'mine, edited\n');
  check('nothing left in the stash', git(work, 'stash', 'list').trim(), '');

  section('a clean tree needs no stash');
  git(work, 'checkout', '-q', '--', 'mine.txt');
  result = await svc.mergeFrom('origin', 'main', { stashLocalChanges: true });
  check('already up to date', result.kind, 'up-to-date');
  check('no stash was taken', result.stash, undefined);
}

module.exports = async function run() {
  process.env.GIT_TERMINAL_PROMPT = '0';
  await coreScenario('main');
  await coreScenario('master');
  await forkScenario();
  await stashScenario();
  await errorScenario();
  void pushUpstreamCommits;
};

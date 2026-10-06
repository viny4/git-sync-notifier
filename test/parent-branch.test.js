// Which branch did this branch come from? Covers every source, in order.
const fs = require('fs');
const path = require('path');
const { check, section, tempDir, git, commitAs } = require('./support/harness');
const { GitService } = require('../out/gitService.js');

module.exports = async function run() {
  const root = tempDir('gsn-parent-');

  // A repo shaped like a release pipeline: dev is the default branch, uat and
  // prod are long-lived, and the feature branch is cut from uat.
  git(root, 'init', '-q', '--bare', '-b', 'dev-aks', 'o.git');
  git(root, 'clone', '-q', path.join(root, 'o.git'), 'work');
  const work = path.join(root, 'work');
  commitAs(work, 'Dev', 'a.txt', 'a\n', 'init');
  git(work, 'push', '-q', '-u', 'origin', 'dev-aks');
  git(work, 'checkout', '-q', '-b', 'uat-aks');
  commitAs(work, 'Dev', 'u.txt', 'u\n', 'uat baseline');
  git(work, 'push', '-q', '-u', 'origin', 'uat-aks');
  git(work, 'checkout', '-q', '-b', 'prod-aks');
  commitAs(work, 'Dev', 'p.txt', 'p\n', 'prod baseline');
  git(work, 'push', '-q', '-u', 'origin', 'prod-aks');
  git(work, 'checkout', '-q', 'dev-aks');
  for (let i = 0; i < 40; i++) {
    commitAs(work, 'Dev', 'd.txt', `d${i}\n`, `dev change ${i}`);
  }
  git(work, 'push', '-q', 'origin', 'dev-aks');
  git(work, 'checkout', '-q', '-b', 'vinay-uat-2', 'uat-aks');
  commitAs(work, 'Dev', 'm.txt', 'm\n', 'my work');
  git(work, 'fetch', '-q', 'origin');
  git(work, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/dev-aks');

  const svc = await GitService.open(work);
  const remote = await svc.detectComparisonRemote();
  const defaultBranch = await svc.detectDefaultBranch(remote.name);

  section('the branch reflog records the branch point');
  check('default branch is still dev-aks', defaultBranch, 'dev-aks');
  let recorded = await svc.readRecordedParent(remote.name, 'vinay-uat-2');
  check('parent found', recorded && recorded.branch, 'uat-aks');
  check('source', recorded && recorded.source, 'reflog');

  section("VS Code's own record wins");
  git(work, 'config', 'branch.vinay-uat-2.vscode-merge-base', 'origin/prod-aks');
  recorded = await svc.readRecordedParent(remote.name, 'vinay-uat-2');
  check('parent found', recorded && recorded.branch, 'prod-aks');
  check('source', recorded && recorded.source, 'vscode-merge-base');

  section('a stale record pointing at a deleted branch is ignored');
  git(work, 'config', 'branch.vinay-uat-2.vscode-merge-base', 'origin/gone');
  recorded = await svc.readRecordedParent(remote.name, 'vinay-uat-2');
  check('falls through to the reflog', recorded && recorded.branch, 'uat-aks');
  git(work, 'config', '--unset', 'branch.vinay-uat-2.vscode-merge-base');

  section('`checkout -b` from the current branch: HEAD reflog');
  git(work, 'checkout', '-q', 'dev-aks');
  git(work, 'checkout', '-q', '-b', 'plain');
  commitAs(work, 'Dev', 'z.txt', 'z\n', 'plain work');
  recorded = await svc.readRecordedParent(remote.name, 'plain');
  check('parent found', recorded && recorded.branch, 'dev-aks');
  check('source', recorded && recorded.source, 'HEAD reflog');

  section('nothing recorded: inferred from merge bases');
  const fresh = path.join(root, 'fresh');
  git(root, 'clone', '-q', path.join(root, 'o.git'), 'fresh');
  git(fresh, 'fetch', '-q', 'origin');
  git(fresh, 'checkout', '-q', '-b', 'vinay-uat-2', 'origin/uat-aks');
  git(fresh, 'reflog', 'expire', '--expire=now', '--all');
  git(fresh, 'gc', '--prune=now', '-q');
  commitAs(fresh, 'Dev', 'x.txt', 'x\n', 'work on a fresh clone');
  const freshSvc = await GitService.open(fresh);
  check('nothing was recorded', await freshSvc.readRecordedParent('origin', 'vinay-uat-2'), undefined);
  check(
    'merge-base heuristic finds the parent',
    await freshSvc.detectParentBranch('origin', 'vinay-uat-2', 'dev-aks'),
    'uat-aks'
  );

  section('ordinary single-branch repository');
  git(root, 'init', '-q', '--bare', '-b', 'main', 's.git');
  git(root, 'clone', '-q', path.join(root, 's.git'), 'solo');
  const solo = path.join(root, 'solo');
  commitAs(solo, 'Dev', 'a.txt', 'a\n', 'init');
  git(solo, 'push', '-q', '-u', 'origin', 'main');
  git(solo, 'checkout', '-q', '-b', 'feature');
  commitAs(solo, 'Dev', 'b.txt', 'b\n', 'work');
  const soloSvc = await GitService.open(solo);
  const soloParent = await soloSvc.readRecordedParent('origin', 'feature');
  check('parent is the default branch', soloParent && soloParent.branch, 'main');
  void fs;
};

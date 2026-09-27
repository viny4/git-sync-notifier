import * as path from 'path';
import { simpleGit, SimpleGit } from 'simple-git';

/** Remote we compare against when nothing else is configured or detected. */
export const FALLBACK_REMOTE = 'origin';
/** Conventional name for the repository a fork was made from. */
export const PARENT_REMOTE = 'upstream';
/** Cap on how many incoming commits we read for the details list. */
const COMMIT_LIST_LIMIT = 25;
/** Cap on branches considered when inferring which branch you cut from. */
const PARENT_CANDIDATE_LIMIT = 150;
/** How many equally-close candidates get an exact ahead/behind measurement. */
const PARENT_SHORTLIST_LIMIT = 10;
const FIELD_SEPARATOR = '\x1f';

export type GitErrorCode =
  | 'not-a-repo'
  | 'no-commits'
  | 'no-remote'
  | 'network'
  | 'missing-remote-branch'
  | 'detached-head'
  | 'dirty-worktree'
  | 'merge-in-progress'
  | 'unknown';

export class GitServiceError extends Error {
  constructor(
    readonly code: GitErrorCode,
    message: string,
    readonly detail?: string
  ) {
    super(message);
    this.name = 'GitServiceError';
  }
}

export interface RemoteInfo {
  name: string;
  url: string;
  /** `owner/repo`, when the URL is recognisably a hosted repository. */
  slug?: string;
}

export interface IncomingCommit {
  sha: string;
  shortSha: string;
  author: string;
  email: string;
  /** Human phrasing straight from git, e.g. "12 minutes ago". */
  relativeTime: string;
  subject: string;
}

export interface SyncStatus {
  repoRoot: string;
  remote: RemoteInfo;
  localBranch: string;
  /** Branch on the remote, without the `<remote>/` prefix. */
  remoteBranch: string;
  headSha: string;
  upstreamSha: string;
  /** Commits on <remote>/<remoteBranch> that HEAD does not have. */
  behind: number;
  /** Commits on HEAD that <remote>/<remoteBranch> does not have. */
  ahead: number;
  /** Commits not yet pushed to this branch's own tracking branch. */
  unpushed?: number;
  /** The tracking branch the unpushed count refers to, e.g. `origin/feature`. */
  pushTarget?: string;
  /** Newest first, capped at COMMIT_LIST_LIMIT. */
  commits: IncomingCommit[];
  /** How many files the incoming commits touch in total. */
  incomingFileCount: number;
  /** Incoming files that this branch has also changed — conflict risk. */
  overlapFiles: string[];
}

export type MergeResult =
  | { kind: 'merged'; summary: string }
  | { kind: 'up-to-date' }
  | { kind: 'conflict'; files: string[] };

const NETWORK_PATTERNS = [
  /could not resolve (host|proxy)/i,
  /unable to access/i,
  /connection (timed out|refused|reset)/i,
  /network is unreachable/i,
  /operation timed out/i,
  /authentication failed/i,
  /permission denied \(publickey\)/i,
  /terminal prompts disabled/i,
  /repository not found/i,
  /ssh: connect to host/i
];

const CONFLICT_PATTERNS = [/CONFLICT/i, /automatic merge failed/i, /fix conflicts/i];

const DIRTY_PATTERNS = [
  /local changes .*would be overwritten/i,
  /please commit your changes or stash them/i,
  /your local changes to the following files would be overwritten/i,
  /cannot merge.*(unmerged|uncommitted)/i,
  /overwritten by merge/i
];

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const extra = (error as { stderr?: string; stdout?: string }).stderr ?? '';
    return `${error.message}\n${extra}`.trim();
  }
  return String(error);
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function lines(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Pulls `owner/repo` out of the usual SSH and HTTPS remote URL shapes. */
export function parseSlug(url: string): string | undefined {
  const cleaned = url.trim().replace(/\.git$/, '');
  const match =
    /^[^@]+@[^:]+:(.+)$/.exec(cleaned) ?? /^[a-z+]+:\/\/[^/]+\/(.+)$/i.exec(cleaned);
  const pathPart = match?.[1];
  if (!pathPart) {
    return undefined;
  }
  const segments = pathPart.split('/').filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    return undefined;
  }
  // Keep every segment, so nested GitLab groups read as `group/sub/repo`.
  return segments.join('/');
}

export class GitService {
  private constructor(
    readonly repoRoot: string,
    private readonly git: SimpleGit
  ) {}

  static async open(folder: string): Promise<GitService | undefined> {
    const git = simpleGit({
      baseDir: folder,
      maxConcurrentProcesses: 1,
      trimmed: true
    });

    try {
      if (!(await git.checkIsRepo())) {
        return undefined;
      }
      const root = path.normalize(await git.revparse(['--show-toplevel']));
      return new GitService(
        root,
        simpleGit({ baseDir: root, maxConcurrentProcesses: 1, trimmed: true })
      );
    } catch {
      return undefined;
    }
  }

  async currentBranch(): Promise<string> {
    let branch: string;
    try {
      branch = await this.git.revparse(['--abbrev-ref', 'HEAD']);
    } catch (error) {
      const text = errorText(error);
      if (/unknown revision|ambiguous argument 'HEAD'|needed a single revision/i.test(text)) {
        throw new GitServiceError(
          'no-commits',
          'This repository has no commits yet, so there is nothing to compare.',
          text
        );
      }
      throw new GitServiceError('unknown', 'Could not read the current branch.', text);
    }

    if (branch === 'HEAD' || branch.length === 0) {
      throw new GitServiceError(
        'detached-head',
        'HEAD is detached, so there is no branch to compare or merge into.'
      );
    }
    return branch;
  }

  async listRemotes(): Promise<RemoteInfo[]> {
    const remotes = await this.git.getRemotes(true);
    return remotes.map((remote) => {
      const url = remote.refs.fetch || remote.refs.push || '';
      return { name: remote.name, url, slug: parseSlug(url) };
    });
  }

  /**
   * Picks the repository to compare against. In a fork, `origin` is your own
   * copy and `upstream` is the repository you actually need to keep up with, so
   * `upstream` wins when it exists.
   */
  async detectComparisonRemote(override?: string): Promise<RemoteInfo> {
    const remotes = await this.listRemotes();
    if (remotes.length === 0) {
      throw new GitServiceError(
        'no-remote',
        'This repository has no remotes, so there is nothing to compare against.'
      );
    }

    if (override) {
      const chosen = remotes.find((remote) => remote.name === override);
      if (!chosen) {
        throw new GitServiceError(
          'no-remote',
          `No remote named "${override}". Available: ${remotes.map((r) => r.name).join(', ')}.`
        );
      }
      return chosen;
    }

    return (
      remotes.find((remote) => remote.name === PARENT_REMOTE) ??
      remotes.find((remote) => remote.name === FALLBACK_REMOTE) ??
      remotes[0]!
    );
  }

  /** True when `origin` and the comparison remote are different repositories. */
  async isFork(remote: RemoteInfo): Promise<boolean> {
    if (remote.name === FALLBACK_REMOTE) {
      return false;
    }
    const remotes = await this.listRemotes();
    const origin = remotes.find((candidate) => candidate.name === FALLBACK_REMOTE);
    return Boolean(origin && origin.url && origin.url !== remote.url);
  }

  async remoteBranchExists(remote: string, branch: string): Promise<boolean> {
    return this.refExists(`refs/remotes/${remote}/${branch}`);
  }

  /**
   * `rev-parse --verify --quiet` exits 1 with no output for a missing ref, and
   * simple-git surfaces that as an empty string rather than an error — so the
   * output, not a thrown error, is what tells us whether the ref exists.
   */
  private async refExists(ref: string): Promise<boolean> {
    try {
      const output = await this.git.raw(['rev-parse', '--verify', '--quiet', ref]);
      return output.trim().length > 0;
    } catch {
      return false;
    }
  }

  /** Prefers `<remote>/HEAD`, then falls back to `main` and `master`. */
  async detectDefaultBranch(remote: string): Promise<string> {
    try {
      const symbolic = await this.git.raw([
        'symbolic-ref',
        '--quiet',
        '--short',
        `refs/remotes/${remote}/HEAD`
      ]);
      const name = symbolic.replace(new RegExp(`^${remote}/`), '').trim();
      if (name.length > 0) {
        return name;
      }
    } catch {
      // <remote>/HEAD is not set locally — fall through to the conventions.
    }

    for (const candidate of ['main', 'master']) {
      if (await this.remoteBranchExists(remote, candidate)) {
        return candidate;
      }
    }

    throw new GitServiceError(
      'missing-remote-branch',
      `Could not determine the default branch on ${remote}. Set gitSyncNotifier.remoteBranch to choose one explicitly.`
    );
  }

  /**
   * The branch this one was created from, when something actually recorded it.
   *
   * Two sources, both exact, no guessing:
   *  - `branch.<name>.vscode-merge-base`, which VS Code's own git extension
   *    writes and keeps up to date;
   *  - the reflog entry `branch: Created from <name>` that git writes when the
   *    branch is created.
   *
   * The reflog is local and expires (90 days by default), and neither exists
   * for a branch that arrived with a fresh clone — hence the fallback in
   * `detectParentBranch`.
   */
  async readRecordedParent(
    remote: string,
    localBranch: string
  ): Promise<{ branch: string; source: string } | undefined> {
    const fromConfig = await this.configValue(
      `branch.${localBranch}.vscode-merge-base`
    );
    const configBranch = this.normaliseBranchRef(fromConfig, remote);
    if (configBranch && (await this.remoteBranchExists(remote, configBranch))) {
      return { branch: configBranch, source: 'vscode-merge-base' };
    }

    try {
      // `refs/heads/<name>` rather than the bare name: unambiguous when a file
      // shares the branch's name, and no `--` separator (which git would read
      // as "everything after this is a path").
      const reflog = await this.git.raw([
        'reflog',
        'show',
        `refs/heads/${localBranch}`
      ]);
      const created = [...reflog.matchAll(/branch: Created from (.+)$/gm)].pop();
      const name = this.normaliseBranchRef(created?.[1], remote);
      if (name && name !== 'HEAD' && (await this.remoteBranchExists(remote, name))) {
        return { branch: name, source: 'reflog' };
      }
    } catch {
      // No reflog for this branch (fresh clone, or it has expired).
    }

    // `git checkout -b <new>` from the current branch records "Created from
    // HEAD", which names nothing — but HEAD's own reflog records the move.
    try {
      const headReflog = await this.git.raw(['reflog', 'show', 'HEAD']);
      const moves = [
        ...headReflog.matchAll(/checkout: moving from (\S+) to (\S+)\s*$/gm)
      ].filter((match) => match[2] === localBranch);
      // Reflog is newest first, so the last match is when the branch appeared.
      const origin = this.normaliseBranchRef(moves.pop()?.[1], remote);
      if (
        origin &&
        origin !== localBranch &&
        (await this.remoteBranchExists(remote, origin))
      ) {
        return { branch: origin, source: 'HEAD reflog' };
      }
    } catch {
      // No HEAD reflog either.
    }

    return undefined;
  }

  private async configValue(key: string): Promise<string | undefined> {
    try {
      const value = (await this.git.raw(['config', '--get', key])).trim();
      return value.length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }

  /** `origin/uat-aks`, `refs/heads/uat-aks` and `uat-aks` all mean `uat-aks`. */
  private normaliseBranchRef(
    ref: string | undefined,
    remote: string
  ): string | undefined {
    if (!ref) {
      return undefined;
    }
    const name = ref
      .trim()
      .replace(/^refs\/(heads|remotes)\//, '')
      .replace(new RegExp(`^${remote}/`), '');
    return name.length > 0 ? name : undefined;
  }

  /**
   * Works out which branch the current one was actually created from.
   *
   * Git does not record that, but it is inferable: of all the remote branches,
   * the parent is the one whose merge base with HEAD is the most recent. In a
   * repo with several long-lived branches (dev / uat / release), this is what
   * makes a branch cut from `uat` compare against `uat` and not against
   * whatever `origin/HEAD` happens to point at.
   *
   * Returns `undefined` when nothing beats the default branch, so callers can
   * fall back to `detectDefaultBranch`.
   */
  async detectParentBranch(
    remote: string,
    localBranch: string,
    defaultBranch: string
  ): Promise<string | undefined> {
    const all = (await this.listRemoteBranches(remote)).filter(
      // Your own pushed branch is not a parent, and neither is the symref.
      (branch) => branch !== localBranch && branch !== 'HEAD'
    );

    // A plain slice would drop branches alphabetically — in a repo with 144
    // branches that is how `uat-aks` gets cut while `prod-aks` survives. Keep
    // the default branch and the most recently updated ones instead.
    const candidates =
      all.length <= PARENT_CANDIDATE_LIMIT
        ? all
        : [
            ...new Set([
              ...(all.includes(defaultBranch) ? [defaultBranch] : []),
              ...(await this.branchesByRecency(remote)).filter((branch) =>
                all.includes(branch)
              )
            ])
          ].slice(0, PARENT_CANDIDATE_LIMIT);

    if (candidates.length === 0) {
      return undefined;
    }

    const bases: { branch: string; sha: string }[] = [];
    for (const branch of candidates) {
      try {
        const sha = (
          await this.git.raw(['merge-base', 'HEAD', `${remote}/${branch}`])
        ).trim();
        if (sha.length > 0) {
          bases.push({ branch, sha });
        }
      } catch {
        // Unrelated histories — not a parent.
      }
    }

    if (bases.length === 0) {
      return undefined;
    }

    // One call for every timestamp rather than one call per candidate.
    const timestamps = new Map<string, number>();
    try {
      const output = await this.git.raw([
        'log',
        '--no-walk',
        '--format=%H %ct',
        ...new Set(bases.map((base) => base.sha))
      ]);
      for (const line of lines(output)) {
        const [sha, seconds] = line.split(' ');
        if (sha && seconds) {
          timestamps.set(sha, Number.parseInt(seconds, 10));
        }
      }
    } catch {
      return undefined;
    }

    const dated = bases
      .map((base) => ({ ...base, at: timestamps.get(base.sha) ?? 0 }))
      .filter((base) => base.at > 0)
      .sort((a, b) => b.at - a.at);

    if (dated.length === 0) {
      return undefined;
    }

    // Several branches often share the newest merge base — in particular every
    // branch that already contains all of your work. Measuring the actual
    // distance is what separates "the branch I cut from" (a few commits away)
    // from "a branch that also happens to contain my work" (a thousand).
    const newest = dated[0]!.at;
    const shortlist = dated
      .filter((base) => base.at === newest)
      .slice(0, PARENT_SHORTLIST_LIMIT);

    if (shortlist.length === 1) {
      return shortlist[0]!.branch;
    }

    let best: { branch: string; ahead: number; behind: number } | undefined;
    for (const candidate of shortlist) {
      const counts = await this.countAheadBehind(`${remote}/${candidate.branch}`);
      if (!counts) {
        continue;
      }
      const better =
        !best ||
        counts.ahead < best.ahead ||
        (counts.ahead === best.ahead && counts.behind < best.behind) ||
        (counts.ahead === best.ahead &&
          counts.behind === best.behind &&
          candidate.branch === defaultBranch);
      if (better) {
        best = { branch: candidate.branch, ...counts };
      }
    }

    return best?.branch ?? shortlist[0]!.branch;
  }

  private async countAheadBehind(
    ref: string
  ): Promise<{ ahead: number; behind: number } | undefined> {
    try {
      const output = await this.git.raw([
        'rev-list',
        '--left-right',
        '--count',
        `HEAD...${ref}`
      ]);
      const [ahead, behind] = lines(output.replace(/\s+/g, '\n')).map((part) =>
        Number.parseInt(part, 10)
      );
      if (!Number.isFinite(ahead) || !Number.isFinite(behind)) {
        return undefined;
      }
      return { ahead: ahead!, behind: behind! };
    } catch {
      return undefined;
    }
  }

  /** Remote branch names, most recently committed to first. */
  private async branchesByRecency(remote: string): Promise<string[]> {
    try {
      const output = await this.git.raw([
        'for-each-ref',
        '--sort=-committerdate',
        '--format=%(refname:short)',
        `refs/remotes/${remote}`
      ]);
      return lines(output).map((ref) =>
        ref.replace(new RegExp(`^${remote}/`), '')
      );
    } catch {
      return [];
    }
  }

  /** Remote branch names, without the `<remote>/` prefix. */
  async listRemoteBranches(remote: string): Promise<string[]> {
    try {
      const output = await this.git.raw([
        'for-each-ref',
        '--format=%(refname:short)',
        `refs/remotes/${remote}`
      ]);
      return lines(output).map((ref) =>
        ref.replace(new RegExp(`^${remote}/`), '')
      );
    } catch {
      return [];
    }
  }

  async fetchRemote(remote: string): Promise<void> {
    const remotes = await this.listRemotes();
    if (!remotes.some((candidate) => candidate.name === remote)) {
      throw new GitServiceError(
        'no-remote',
        `This repository has no "${remote}" remote.`
      );
    }

    try {
      await this.git.raw(['fetch', remote, '--prune', '--quiet']);
    } catch (error) {
      const text = errorText(error);
      if (matchesAny(text, NETWORK_PATTERNS)) {
        throw new GitServiceError('network', `Could not reach ${remote}.`, text);
      }
      throw new GitServiceError('unknown', `git fetch ${remote} failed.`, text);
    }
  }

  /**
   * Also fetches `origin` when comparing against a fork parent, so the
   * "not pushed to your fork yet" count is accurate. A failure there is not
   * fatal — the parent comparison is what matters.
   */
  async fetchForComparison(remote: string): Promise<{ originFetchFailed?: string }> {
    await this.fetchRemote(remote);

    if (remote === FALLBACK_REMOTE) {
      return {};
    }
    const remotes = await this.listRemotes();
    if (!remotes.some((candidate) => candidate.name === FALLBACK_REMOTE)) {
      return {};
    }
    try {
      await this.fetchRemote(FALLBACK_REMOTE);
      return {};
    } catch (error) {
      return {
        originFetchFailed:
          error instanceof GitServiceError ? error.message : String(error)
      };
    }
  }

  /** Compares HEAD against `<remote>/<remoteBranch>`; assumes a fetch just ran. */
  async getStatus(remote: RemoteInfo, remoteBranch: string): Promise<SyncStatus> {
    const localBranch = await this.currentBranch();
    const ref = `${remote.name}/${remoteBranch}`;

    if (!(await this.remoteBranchExists(remote.name, remoteBranch))) {
      throw new GitServiceError('missing-remote-branch', `${ref} does not exist.`);
    }

    const headSha = await this.git.revparse(['HEAD']);
    const upstreamSha = await this.git.revparse([`refs/remotes/${remote.name}/${remoteBranch}`]);

    const counts = await this.git.raw([
      'rev-list',
      '--left-right',
      '--count',
      `HEAD...${ref}`
    ]);
    const [aheadRaw, behindRaw] = lines(counts.replace(/\s+/g, '\n')).map((part) =>
      Number.parseInt(part, 10)
    );
    const ahead = Number.isFinite(aheadRaw) ? aheadRaw! : 0;
    const behind = Number.isFinite(behindRaw) ? behindRaw! : 0;

    const [commits, incomingFiles, myFiles, push] = await Promise.all([
      behind > 0 ? this.readCommits(`HEAD..${ref}`) : Promise.resolve([]),
      behind > 0 ? this.readFiles(`HEAD...${ref}`) : Promise.resolve([]),
      this.changedFilesOnBranch(ref),
      this.unpushedCount()
    ]);

    const mine = new Set(myFiles);
    return {
      repoRoot: this.repoRoot,
      remote,
      localBranch,
      remoteBranch,
      headSha,
      upstreamSha,
      ahead,
      behind,
      unpushed: push?.count,
      pushTarget: push?.target,
      commits,
      incomingFileCount: incomingFiles.length,
      overlapFiles: incomingFiles.filter((file) => mine.has(file))
    };
  }

  private async readCommits(range: string): Promise<IncomingCommit[]> {
    const format = ['%H', '%h', '%an', '%ae', '%ar', '%s'].join('%x1f');
    try {
      const output = await this.git.raw([
        'log',
        `--max-count=${COMMIT_LIST_LIMIT}`,
        `--format=${format}`,
        range
      ]);
      return lines(output).flatMap((line) => {
        const [sha, shortSha, author, email, relativeTime, subject] =
          line.split(FIELD_SEPARATOR);
        if (!sha) {
          return [];
        }
        return [
          {
            sha,
            shortSha: shortSha ?? sha.slice(0, 7),
            author: author ?? 'unknown',
            email: email ?? '',
            relativeTime: relativeTime ?? '',
            subject: subject ?? ''
          }
        ];
      });
    } catch {
      return [];
    }
  }

  private async readFiles(range: string): Promise<string[]> {
    try {
      return lines(await this.git.raw(['diff', '--name-only', range]));
    } catch {
      return [];
    }
  }

  /** Files this branch changed since the merge base, plus uncommitted edits. */
  private async changedFilesOnBranch(ref: string): Promise<string[]> {
    const committed = await this.readFiles(`${ref}...HEAD`);
    let uncommitted: string[] = [];
    try {
      uncommitted = lines(await this.git.raw(['diff', '--name-only', 'HEAD']));
    } catch {
      uncommitted = [];
    }
    return [...new Set([...committed, ...uncommitted])];
  }

  /**
   * Commits on this branch that its own tracking branch does not have — i.e.
   * work you have not pushed to your fork yet. Undefined when the branch has no
   * upstream configured.
   */
  private async unpushedCount(): Promise<{ count: number; target: string } | undefined> {
    let target: string;
    try {
      target = await this.git.raw(['rev-parse', '--abbrev-ref', '@{upstream}']);
    } catch {
      return undefined;
    }
    if (target.length === 0) {
      return undefined;
    }
    try {
      const output = await this.git.raw(['rev-list', '--count', `${target}..HEAD`]);
      const count = Number.parseInt(output.trim(), 10);
      return Number.isFinite(count) ? { count, target } : undefined;
    } catch {
      return undefined;
    }
  }

  async isMergeInProgress(): Promise<boolean> {
    return this.refExists('MERGE_HEAD');
  }

  /** Files git left in the "both modified" (unmerged) state. */
  async conflictedFiles(): Promise<string[]> {
    try {
      return lines(await this.git.raw(['diff', '--name-only', '--diff-filter=U']));
    } catch {
      return [];
    }
  }

  async mergeFrom(remote: string, remoteBranch: string): Promise<MergeResult> {
    if (await this.isMergeInProgress()) {
      throw new GitServiceError(
        'merge-in-progress',
        'A merge is already in progress. Finish or abort it first.'
      );
    }

    let output: string;
    try {
      output = await this.git.raw(['merge', '--no-edit', `${remote}/${remoteBranch}`]);
    } catch (error) {
      const text = errorText(error);

      if (matchesAny(text, CONFLICT_PATTERNS)) {
        return { kind: 'conflict', files: await this.conflictedFiles() };
      }

      if (matchesAny(text, DIRTY_PATTERNS)) {
        throw new GitServiceError(
          'dirty-worktree',
          'The merge was refused because of uncommitted local changes. Commit or stash them, then try again.',
          text
        );
      }

      const files = await this.conflictedFiles();
      if (files.length > 0) {
        return { kind: 'conflict', files };
      }

      throw new GitServiceError('unknown', 'git merge failed.', text);
    }

    // git reports conflicts on a non-zero exit that simple-git sometimes
    // resolves rather than throws, so the resolved output is checked too.
    if (matchesAny(output, CONFLICT_PATTERNS)) {
      return { kind: 'conflict', files: await this.conflictedFiles() };
    }
    const unmerged = await this.conflictedFiles();
    if (unmerged.length > 0) {
      return { kind: 'conflict', files: unmerged };
    }
    if (/already up to date/i.test(output)) {
      return { kind: 'up-to-date' };
    }
    return { kind: 'merged', summary: output.trim() };
  }

  absolutePath(relativePath: string): string {
    return path.join(this.repoRoot, relativePath);
  }
}

/** "Teammate", "Teammate and 1 other", "Teammate and 3 others". */
export function summarizeAuthors(commits: IncomingCommit[]): string {
  const names = [...new Set(commits.map((commit) => commit.author))];
  if (names.length === 0) {
    return 'someone';
  }
  if (names.length === 1) {
    return names[0]!;
  }
  const others = names.length - 1;
  return `${names[0]} and ${others} other${others === 1 ? '' : 's'}`;
}

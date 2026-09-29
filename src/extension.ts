import * as path from 'path';
import * as vscode from 'vscode';
import { affectsConfig, getConfig } from './config';
import { GitService, GitServiceError, SyncStatus } from './gitService';
import { Logger } from './logger';
import { Notifier } from './notifier';
import { StatusBar } from './statusBar';
import { Scheduler } from './scheduler';
import { SummaryNotifier } from './summary';
import { NotificationState, RangeSignature } from './state';

/** Refocusing the window more often than this does not trigger a new fetch. */
const FOCUS_THROTTLE_MS = 60_000;
/** Small delay after activation so we do not compete with startup work. */
const STARTUP_DELAY_MS = 2_000;
/** Spacing between each repository's first check. */
const STARTUP_STAGGER_MS = 1_500;

class SyncController implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private lastCheckAt = 0;
  private lastErrorCode: string | undefined;
  private disposed = false;

  constructor(
    readonly git: GitService,
    private readonly notifier: Notifier,
    private readonly state: NotificationState,
    private readonly logger: Logger,
    /** Repository name, used to keep log lines apart when several are watched. */
    readonly label: string,
    /** Shared gate so repositories do not all fetch at once. */
    private readonly scheduler: Scheduler,
    /** Collects simultaneous "behind" reports into one notification. */
    private readonly summary: SummaryNotifier
  ) {}

  /**
   * `startupDelayMs` staggers the first check: four repositories fetching in
   * the same instant would make the editor feel slow at startup.
   */
  start(startupDelayMs = STARTUP_DELAY_MS): void {
    this.applyConfig();
    setTimeout(() => {
      if (!this.disposed) {
        void this.check({ manual: false });
      }
    }, startupDelayMs);
  }

  /** (Re)reads settings: resets the poll timer and hides the UI when disabled. */
  applyConfig(): void {
    this.stopTimer();

    const config = getConfig(vscode.Uri.file(this.git.repoRoot));
    if (!config.enabled) {
      this.logger.info('Disabled via gitSyncNotifier.enabled.');
      this.notifier.setStatus({ kind: 'idle' });
      return;
    }

    const intervalMs = config.pollIntervalMinutes * 60_000;
    this.timer = setInterval(() => {
      void this.check({ manual: false });
    }, intervalMs);
    this.logger.info(
      `[${this.label}] polling every ${config.pollIntervalMinutes} minute(s).`
    );
  }

  onWindowFocus(): void {
    const config = getConfig(vscode.Uri.file(this.git.repoRoot));
    if (!config.enabled) {
      return;
    }
    const elapsed = Date.now() - this.lastCheckAt;
    if (elapsed < FOCUS_THROTTLE_MS) {
      this.logger.info(
        `Window focused, but last check was ${Math.round(elapsed / 1000)}s ago — skipping.`
      );
      return;
    }
    void this.check({ manual: false });
  }

  /** True while a check is running, so batching can wait for the round. */
  get isChecking(): boolean {
    return this.inFlight !== undefined;
  }

  /** Serialised: a second caller awaits the check already running. */
  async check(options: { manual: boolean }): Promise<void> {
    if (this.inFlight) {
      this.logger.info('A check is already running; awaiting it.');
      return this.inFlight;
    }
    this.inFlight = this.runCheck(options).finally(() => {
      this.inFlight = undefined;
      this.lastCheckAt = Date.now();
    });
    return this.inFlight;
  }

  private async runCheck(options: { manual: boolean }): Promise<void> {
    const config = getConfig(vscode.Uri.file(this.git.repoRoot));
    if (!config.enabled) {
      this.notifier.setStatus({ kind: 'idle' });
      return;
    }

    this.notifier.setStatus({ kind: 'checking' });

    try {
      // A merge the user hasn't committed yet takes priority: prompting to
      // merge again would only fail, and the counts are misleading mid-merge.
      if (await this.git.isMergeInProgress()) {
        const conflicted = await this.git.conflictedFiles();
        this.logger.info(
          `Merge in progress with ${conflicted.length} unresolved conflict(s) — not prompting.`
        );
        this.notifier.setStatus({ kind: 'merging', conflicted: conflicted.length });
        if (options.manual) {
          await this.notifier.showMergeInProgress(conflicted, (file) =>
            this.git.absolutePath(file)
          );
        }
        return;
      }

      const remote = await this.git.detectComparisonRemote(config.remote);
      const fetchResult = await this.scheduler.run(() =>
        this.git.fetchForComparison(remote.name)
      );
      if (fetchResult.originFetchFailed) {
        this.logger.warn(
          `Could not fetch origin (your fork): ${fetchResult.originFetchFailed}`
        );
      }

      const remoteBranch =
        config.remoteBranch ?? (await this.resolveComparisonBranch(remote.name));
      const status = await this.git.getStatus(remote, remoteBranch);
      this.lastErrorCode = undefined;

      if (await this.git.isFork(remote)) {
        this.logger.info(
          `Comparing against the fork parent ${remote.name} (${remote.slug ?? remote.url}).`
        );
      }
      this.logger.info(
        `${status.localBranch}: behind ${status.behind}, ahead ${status.ahead}` +
          (status.unpushed !== undefined
            ? `, ${status.unpushed} unpushed to ${status.pushTarget}`
            : '') +
          ` vs ${remote.name}/${status.remoteBranch}.`
      );

      if (status.behind === 0) {
        this.notifier.setStatus({ kind: 'synced', status });
        await this.state.clear(signatureOf(status));
        if (options.manual) {
          this.notifier.showAlreadyUpToDate(status);
        }
        return;
      }

      this.notifier.setStatus({ kind: 'behind', status });

      const signature = signatureOf(status);
      if (!options.manual && this.state.isDismissed(signature)) {
        this.logger.info(
          'This commit range was already dismissed — not notifying again.'
        );
        return;
      }

      // Several repositories falling behind at once become one message rather
      // than a stack of popups. Below the threshold this releases straight
      // back to the per-repository prompt.
      if (
        !options.manual &&
        this.summary.collect(this.git.repoRoot, {
          label: this.label,
          status,
          merge: () => this.merge(status),
          dismiss: () => this.state.markDismissed(signature),
          onOwnNotification: () => this.promptAndAct(status, signature)
        })
      ) {
        return;
      }

      await this.promptAndAct(status, signature);
    } catch (error) {
      this.handleError(error, options.manual);
    }
  }

  /** The per-repository prompt, and whatever the user chose. */
  private async promptAndAct(
    status: SyncStatus,
    signature: RangeSignature
  ): Promise<void> {
    try {
      // "Details" returns to the prompt, so reviewing the commits does not
      // cost the user their chance to merge.
      for (;;) {
        const choice = await this.notifier.promptBehind(status);
        if (choice === 'details') {
          await this.notifier.showDetails(status);
          continue;
        }
        if (choice === 'merge') {
          await this.merge(status);
        } else if (choice === 'dismiss') {
          await this.state.markDismissed(signature);
          this.logger.info('Dismissed; will alert again on the next new commit.');
        }
        return;
      }
    } catch (error) {
      this.handleError(error, true);
    }
  }

  /**
   * The branch to compare against: the one this branch was actually cut from,
   * falling back to the remote's default branch. Repos with several long-lived
   * branches (dev / uat / release) are the reason — a branch cut from `uat`
   * should be compared against `uat`, not against whatever `origin/HEAD` says.
   */
  private async resolveComparisonBranch(remote: string): Promise<string> {
    const defaultBranch = await this.git.detectDefaultBranch(remote);

    let localBranch: string;
    try {
      localBranch = await this.git.currentBranch();
    } catch {
      return defaultBranch;
    }

    // Something may have recorded the branch point exactly; prefer that over
    // any amount of inference.
    const recorded = await this.git.readRecordedParent(remote, localBranch);
    if (recorded) {
      this.logger.info(
        `${localBranch} was created from ${remote}/${recorded.branch} (per ${recorded.source}) — comparing against that.`
      );
      return recorded.branch;
    }

    const parent = await this.git.detectParentBranch(
      remote,
      localBranch,
      defaultBranch
    );

    if (parent && parent !== defaultBranch) {
      this.logger.info(
        `${localBranch} looks like it was branched from ${remote}/${parent}, not the default ${remote}/${defaultBranch} — comparing against ${remote}/${parent}. Override with gitSyncNotifier.remoteBranch.`
      );
      return parent;
    }

    return defaultBranch;
  }

  private async merge(status: SyncStatus): Promise<void> {
    this.logger.info(
      `Merging ${status.remote.name}/${status.remoteBranch} into ${status.localBranch}.`
    );

    try {
      const result = await this.git.mergeFrom(status.remote.name, status.remoteBranch);

      if (result.kind === 'conflict') {
        this.logger.warn(
          `Merge left conflicts in: ${result.files.join(', ') || '(unknown files)'}`
        );
        this.notifier.setStatus({ kind: 'conflict' });
        await this.notifier.showConflicts(result.files, (file) =>
          this.git.absolutePath(file)
        );
        return;
      }

      if (result.kind === 'up-to-date') {
        this.logger.info('Merge reported "already up to date".');
        this.notifier.showAlreadyUpToDate(status);
      } else {
        this.logger.info(`Merge succeeded. ${result.summary}`);
        this.notifier.showMergeSucceeded(status);
      }

      await this.state.clear(signatureOf(status));
      this.notifier.setStatus({ kind: 'synced', status: { ...status, behind: 0 } });
    } catch (error) {
      this.handleError(error, true);
    }
  }

  /**
   * Background failures are logged and shown in the status bar, but only
   * toasted once per new error so a flaky network cannot spam the user.
   */
  private handleError(error: unknown, manual: boolean): void {
    if (error instanceof GitServiceError) {
      this.logger.error(`[${error.code}] ${error.message}`, error.detail);
      this.notifier.setStatus({ kind: 'error', message: error.message });
      if (manual || this.lastErrorCode !== error.code) {
        this.notifier.showError(error.message, error.detail);
      }
      this.lastErrorCode = error.code;
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    this.logger.error('Unexpected failure during upstream check.', error);
    this.notifier.setStatus({ kind: 'error', message });
    if (manual || this.lastErrorCode !== 'unexpected') {
      this.notifier.showError(message);
    }
    this.lastErrorCode = 'unexpected';
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopTimer();
  }
}

function signatureOf(status: SyncStatus): RangeSignature {
  return {
    repoRoot: status.repoRoot,
    localBranch: status.localBranch,
    remote: status.remote.name,
    remoteBranch: status.remoteBranch,
    headSha: status.headSha,
    upstreamSha: status.upstreamSha
  };
}

/** Folders that never contain a repository worth watching. */
const SKIP_DIRECTORIES = new Set([
  'node_modules', 'dist', 'out', 'build', 'target', 'vendor', '.venv', 'venv',
  '__pycache__', '.next', '.nuxt', 'coverage', 'tmp', '.cache'
]);
/** Guards against a workspace folder full of repositories. */
const MAX_REPOSITORIES = 20;
/** Wait for repository discovery to settle before reloading. */
const REPOSITORY_SETTLE_MS = 1_500;
/** How many repositories may fetch at the same time. */
const FETCH_CONCURRENCY = 3;
/** Workspaces with at least this many repositories get batched notifications. */
const SUMMARY_THRESHOLD = 3;
/** Flush the batch once no further repository has reported in for this long. */
const SUMMARY_QUIET_MS = 5_000;
/** Never hold a "behind" notification longer than this while batching. */
const SUMMARY_MAX_WAIT_MS = 30_000;

/** The slice of VS Code's built-in git extension API that we use. */
interface BuiltInGitApi {
  readonly repositories: { readonly rootUri: vscode.Uri }[];
  onDidOpenRepository(listener: () => void): vscode.Disposable;
  onDidCloseRepository(listener: () => void): vscode.Disposable;
}

/**
 * Asks VS Code's own git extension which repositories it has found.
 *
 * It is the thing that fills the Source Control panel, so it already knows
 * about repositories nested at any depth — `id10/src/common-lambda-lib`, say —
 * and it honours the user's `git.autoRepositoryDetection` setting. Far better
 * than guessing with our own directory walk.
 */
let gitApiLookup: Promise<BuiltInGitApi | undefined> | undefined;

/** Cached, so activation and each repository scan do not repeat the lookup. */
function builtInGitApi(logger: Logger): Promise<BuiltInGitApi | undefined> {
  gitApiLookup ??= lookUpBuiltInGitApi(logger);
  return gitApiLookup;
}

async function lookUpBuiltInGitApi(
  logger: Logger
): Promise<BuiltInGitApi | undefined> {
  const extension = vscode.extensions.getExtension<{
    getAPI(version: number): BuiltInGitApi;
  }>('vscode.git');

  if (!extension) {
    logger.info('The built-in git extension is not available.');
    return undefined;
  }

  try {
    const exports = extension.isActive
      ? extension.exports
      : await extension.activate();
    return exports.getAPI(1);
  } catch (error) {
    logger.error('Could not use the built-in git extension API', error);
    return undefined;
  }
}

/**
 * Every repository in the workspace, not just the first.
 *
 * Two layouts matter. A multi-root workspace has one folder per repository.
 * But people also keep `frontend/`, `backend/`, `serverless/` and `packages/`
 * side by side and open the *parent* folder — which is not itself a
 * repository, so a naive check finds nothing at all. Both are handled by
 * looking one level down when a folder is not a repository itself.
 */
async function findRepositories(logger: Logger): Promise<GitService[]> {
  const found = new Map<string, GitService>();

  const consider = async (folder: string): Promise<boolean> => {
    const git = await GitService.open(folder);
    if (git && !found.has(git.repoRoot)) {
      found.set(git.repoRoot, git);
    }
    return Boolean(git);
  };

  // What VS Code itself has found comes first: it sees repositories at any
  // depth, which a one-level scan cannot.
  const api = await builtInGitApi(logger);
  for (const repository of api?.repositories ?? []) {
    if (found.size >= MAX_REPOSITORIES) {
      break;
    }
    if (repository.rootUri.scheme === 'file') {
      await consider(repository.rootUri.fsPath);
    }
  }

  // Then our own look around, so this still works with the git extension
  // disabled, or before it has finished scanning.
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== 'file' || found.size >= MAX_REPOSITORIES) {
      continue;
    }

    if (await consider(folder.uri.fsPath)) {
      continue;
    }

    // Not a repository itself — look at its immediate children.
    let children: [string, vscode.FileType][] = [];
    try {
      children = await vscode.workspace.fs.readDirectory(folder.uri);
    } catch (error) {
      logger.error(`Could not read ${folder.uri.fsPath}`, error);
      continue;
    }

    for (const [name, type] of children) {
      if (
        type !== vscode.FileType.Directory ||
        name.startsWith('.') ||
        SKIP_DIRECTORIES.has(name) ||
        found.size >= MAX_REPOSITORIES
      ) {
        continue;
      }
      await consider(vscode.Uri.joinPath(folder.uri, name).fsPath);
    }
  }

  return [...found.values()];
}

function labelFor(repoRoot: string): string {
  return path.basename(repoRoot) || repoRoot;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = new Logger();
  const statusBar = new StatusBar();
  const state = new NotificationState(context.workspaceState);
  context.subscriptions.push(logger, statusBar);

  const scheduler = new Scheduler(FETCH_CONCURRENCY);
  const summary = new SummaryNotifier(
    SUMMARY_THRESHOLD,
    SUMMARY_MAX_WAIT_MS,
    SUMMARY_QUIET_MS,
    () => controllers.length
  );
  context.subscriptions.push(summary);

  let controllers: SyncController[] = [];
  const isMultiRepo = () => controllers.length > 1;

  /** The repository containing the file being edited, if any. */
  const followActiveEditor = (): void => {
    const file = vscode.window.activeTextEditor?.document.uri;
    if (!file || file.scheme !== 'file') {
      statusBar.setActiveRepo(undefined);
      return;
    }
    // Longest matching root wins, so a repo nested inside another still works.
    const match = controllers
      .filter((controller) => file.fsPath.startsWith(controller.git.repoRoot))
      .sort((a, b) => b.git.repoRoot.length - a.git.repoRoot.length)[0];
    statusBar.setActiveRepo(match?.git.repoRoot);
  };

  const initialise = async (): Promise<void> => {
    for (const controller of controllers) {
      controller.dispose();
    }
    controllers = [];
    statusBar.clear();

    const repositories = await findRepositories(logger);
    if (repositories.length === 0) {
      logger.info('No git repository in this workspace — staying dormant.');
      return;
    }

    logger.info(
      repositories.length === 1
        ? `Watching repository ${repositories[0]!.repoRoot}`
        : `Watching ${repositories.length} repositories: ${repositories
            .map((git) => git.repoRoot)
            .join(', ')}`
    );

    controllers = repositories.map((git) => {
      const label = labelFor(git.repoRoot);
      const notifier = new Notifier(logger, statusBar, git.repoRoot, label, isMultiRepo);
      return new SyncController(
        git,
        notifier,
        state,
        logger,
        label,
        scheduler,
        summary
      );
    });

    controllers.forEach((controller, index) => {
      // Stagger the first check so several repositories do not all fetch at once.
      controller.start(STARTUP_DELAY_MS + index * STARTUP_STAGGER_MS);
    });
    followActiveEditor();
  };

  // VS Code discovers repositories asynchronously after startup, a few at a
  // time. Debounce so seven repositories appearing in a burst cause one reload.
  let reloadTimer: NodeJS.Timeout | undefined;
  const scheduleReload = (): void => {
    if (reloadTimer) {
      clearTimeout(reloadTimer);
    }
    reloadTimer = setTimeout(() => {
      reloadTimer = undefined;
      void initialise();
    }, REPOSITORY_SETTLE_MS);
  };

  const gitApi = await builtInGitApi(logger);
  if (gitApi) {
    context.subscriptions.push(
      gitApi.onDidOpenRepository(scheduleReload),
      gitApi.onDidCloseRepository(scheduleReload)
    );
  }

  context.subscriptions.push(
    { dispose: () => reloadTimer && clearTimeout(reloadTimer) },
    vscode.commands.registerCommand('gitSyncNotifier.checkNow', async () => {
      if (controllers.length === 0) {
        await initialise();
      }
      if (controllers.length === 0) {
        void vscode.window.showInformationMessage(
          'Git Sync Notifier: no git repository found in this workspace.'
        );
        return;
      }
      await Promise.all(
        controllers.map((controller) => controller.check({ manual: true }))
      );
    }),
    vscode.commands.registerCommand('gitSyncNotifier.showLog', () => logger.show()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (affectsConfig(event)) {
        logger.info('Configuration changed; reloading.');
        for (const controller of controllers) {
          controller.applyConfig();
        }
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void initialise()),
    vscode.window.onDidChangeActiveTextEditor(() => followActiveEditor()),
    vscode.window.onDidChangeWindowState((windowState) => {
      if (windowState.focused) {
        for (const controller of controllers) {
          controller.onWindowFocus();
        }
      }
    }),
    {
      dispose: () => {
        for (const controller of controllers) {
          controller.dispose();
        }
      }
    }
  );

  await initialise();
}

export function deactivate(): void {
  // Disposables registered on the context (timers, status bar, output channel)
  // are cleaned up by VS Code.
}

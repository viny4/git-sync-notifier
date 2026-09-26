import * as vscode from 'vscode';
import { affectsConfig, getConfig } from './config';
import { GitService, GitServiceError, SyncStatus } from './gitService';
import { Logger } from './logger';
import { Notifier } from './notifier';
import { NotificationState, RangeSignature } from './state';

/** Refocusing the window more often than this does not trigger a new fetch. */
const FOCUS_THROTTLE_MS = 60_000;
/** Small delay after activation so we do not compete with startup work. */
const STARTUP_DELAY_MS = 2_000;

class SyncController implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private lastCheckAt = 0;
  private lastErrorCode: string | undefined;
  private disposed = false;

  constructor(
    private readonly git: GitService,
    private readonly notifier: Notifier,
    private readonly state: NotificationState,
    private readonly logger: Logger
  ) {}

  start(): void {
    this.applyConfig();
    setTimeout(() => {
      if (!this.disposed) {
        void this.check({ manual: false });
      }
    }, STARTUP_DELAY_MS);
  }

  /** (Re)reads settings: resets the poll timer and hides the UI when disabled. */
  applyConfig(): void {
    this.stopTimer();

    const config = getConfig(vscode.Uri.file(this.git.repoRoot));
    if (!config.enabled) {
      this.logger.info('Disabled via gitSyncNotifier.enabled.');
      this.notifier.setStatus({ kind: 'hidden' });
      return;
    }

    const intervalMs = config.pollIntervalMinutes * 60_000;
    this.timer = setInterval(() => {
      void this.check({ manual: false });
    }, intervalMs);
    this.logger.info(`Polling every ${config.pollIntervalMinutes} minute(s).`);
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
      this.notifier.setStatus({ kind: 'hidden' });
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
      const fetchResult = await this.git.fetchForComparison(remote.name);
      if (fetchResult.originFetchFailed) {
        this.logger.warn(
          `Could not fetch origin (your fork): ${fetchResult.originFetchFailed}`
        );
      }

      const remoteBranch =
        config.remoteBranch ?? (await this.git.detectDefaultBranch(remote.name));
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
      this.handleError(error, options.manual);
    }
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

async function findRepository(logger: Logger): Promise<GitService | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    if (folder.uri.scheme !== 'file') {
      continue;
    }
    const git = await GitService.open(folder.uri.fsPath);
    if (git) {
      logger.info(`Watching repository ${git.repoRoot}`);
      return git;
    }
  }
  return undefined;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = new Logger();
  const notifier = new Notifier(logger);
  const state = new NotificationState(context.workspaceState);
  context.subscriptions.push(logger, notifier);

  let controller: SyncController | undefined;

  const initialise = async (): Promise<void> => {
    controller?.dispose();
    controller = undefined;

    const git = await findRepository(logger);
    if (!git) {
      logger.info('No git repository in this workspace — staying dormant.');
      notifier.setStatus({ kind: 'hidden' });
      return;
    }

    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length > 1) {
      logger.warn(
        `Multi-root workspace: only ${git.repoRoot} is watched by this extension.`
      );
    }

    controller = new SyncController(git, notifier, state, logger);
    controller.start();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('gitSyncNotifier.checkNow', async () => {
      if (!controller) {
        await initialise();
      }
      if (!controller) {
        void vscode.window.showInformationMessage(
          'Git Sync Notifier: no git repository found in this workspace.'
        );
        return;
      }
      await controller.check({ manual: true });
    }),
    vscode.commands.registerCommand('gitSyncNotifier.showLog', () => logger.show()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (affectsConfig(event)) {
        logger.info('Configuration changed; reloading.');
        controller?.applyConfig();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void initialise()),
    vscode.window.onDidChangeWindowState((windowState) => {
      if (windowState.focused) {
        controller?.onWindowFocus();
      }
    }),
    { dispose: () => controller?.dispose() }
  );

  await initialise();
}

export function deactivate(): void {
  // Disposables registered on the context (timers, status bar, output channel)
  // are cleaned up by VS Code.
}

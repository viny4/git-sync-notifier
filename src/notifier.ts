import * as vscode from 'vscode';
import { Logger } from './logger';
import { StashOutcome, summarizeAuthors, SyncStatus } from './gitService';
import { StatusBar, StatusView } from './statusBar';

export type BehindChoice = 'merge' | 'details' | 'dismiss' | 'ignored';

const MERGE_NOW = 'Merge Now';
const DETAILS = 'Details';
const DISMISS = 'Dismiss';
const SHOW_CONFLICTS = 'Open Merge Editor';
const SHOW_LOG = 'Show Log';
const STASH_AND_MERGE = 'Stash & Merge';
const OPEN_SCM = 'Open Source Control';

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export class Notifier implements vscode.Disposable {
  constructor(
    private readonly logger: Logger,
    private readonly statusBar: StatusBar,
    private readonly repoRoot: string,
    /** Repository name, shown in toasts when more than one is watched. */
    private readonly label: string,
    private readonly isMultiRepo: () => boolean
  ) {
    this.statusBar.track(repoRoot, label);
  }

  /** Prefixes messages with the repository name when several are watched. */
  private scoped(message: string): string {
    return this.isMultiRepo() ? `${this.label}: ${message}` : message;
  }

  setStatus(view: StatusView): void {
    this.statusBar.set(this.repoRoot, view);
  }

  /** The one notification this extension exists for. Never merges by itself. */
  async promptBehind(status: SyncStatus): Promise<BehindChoice> {
    const choice = await vscode.window.showInformationMessage(
      this.scoped(describeIncoming(status)),
      MERGE_NOW,
      DETAILS,
      DISMISS
    );

    if (choice === MERGE_NOW) {
      return 'merge';
    }
    if (choice === DETAILS) {
      return 'details';
    }
    if (choice === DISMISS) {
      return 'dismiss';
    }
    // The toast timed out or was closed with the X — treat that as "not now"
    // without recording a dismissal, so the next poll can remind them.
    return 'ignored';
  }

  /** Lists the incoming commits, newest first, with who wrote each one. */
  async showDetails(status: SyncStatus): Promise<void> {
    const ref = `${status.remote.name}/${status.remoteBranch}`;
    const overlap = new Set(status.overlapFiles);

    const items: vscode.QuickPickItem[] = status.commits.map((commit) => ({
      label: commit.subject || '(no subject)',
      description: `${commit.author} · ${commit.relativeTime}`,
      detail: commit.shortSha
    }));

    if (overlap.size > 0) {
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
      items.push({
        label: `$(warning) ${plural(overlap.size, 'file')} also changed on ${status.localBranch}`,
        detail: [...overlap].join(', ')
      });
    }

    await vscode.window.showQuickPick(items, {
      title: `${plural(status.behind, 'commit')} incoming from ${ref}`,
      placeHolder: `${status.incomingFileCount} file(s) changed · press Escape to go back`
    });
  }

  /**
   * A merge the user started is still open. Offering another merge here would
   * only fail, so point them at finishing this one instead.
   */
  async showMergeInProgress(
    conflicted: string[],
    absolutePath: (file: string) => string
  ): Promise<void> {
    const message = this.scoped(
      conflicted.length > 0
        ? `A merge is in progress with ${plural(conflicted.length, 'unresolved conflict')}. Resolve them, then commit.`
        : 'A merge is in progress and everything is resolved — commit it to finish.'
    );

    const action = conflicted.length > 0 ? SHOW_CONFLICTS : 'Open Source Control';
    const choice = await vscode.window.showWarningMessage(message, action);
    if (choice === SHOW_CONFLICTS) {
      await this.openMergeUi(conflicted, absolutePath);
    } else if (choice === 'Open Source Control') {
      await vscode.commands.executeCommand('workbench.view.scm');
    }
  }

  /**
   * git refused the merge because of uncommitted work. Offer to set it aside
   * and put it back afterwards — still a click, never automatic.
   */
  async offerStashAndMerge(files: string[]): Promise<boolean> {
    const list = files.slice(0, 3).join(', ');
    const more = files.length > 3 ? `, +${files.length - 3} more` : '';
    const choice = await vscode.window.showWarningMessage(
      this.scoped(
        `Cannot merge with uncommitted changes in ${plural(files.length, 'file')}` +
          (list ? ` (${list}${more})` : '') +
          '. Set them aside, merge, then put them back?'
      ),
      { modal: false },
      STASH_AND_MERGE,
      OPEN_SCM
    );
    if (choice === STASH_AND_MERGE) {
      return true;
    }
    if (choice === OPEN_SCM) {
      await vscode.commands.executeCommand('workbench.view.scm');
    }
    return false;
  }

  /** What happened to the work we set aside. Silent when it went back cleanly. */
  async reportStash(outcome: StashOutcome): Promise<void> {
    if (outcome.kind === 'restored') {
      return;
    }
    if (outcome.kind === 'restored-with-conflicts') {
      void vscode.window.showWarningMessage(
        this.scoped(
          `Your changes went back with conflicts in ${plural(outcome.files.length, 'file')}. ` +
            'The stash is still saved until you resolve them.'
        )
      );
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      this.scoped(
        `Your changes are saved in a stash and were not restored — ${outcome.reason}. ` +
          'Run "Git: Pop Stash" once the working tree is settled.'
      ),
      OPEN_SCM
    );
    if (choice === OPEN_SCM) {
      await vscode.commands.executeCommand('workbench.view.scm');
    }
  }

  showMergeSucceeded(status: SyncStatus): void {
    void vscode.window.showInformationMessage(
      this.scoped(
        `Merged ${plural(status.behind, 'commit')} from ${status.remote.name}/${status.remoteBranch} into ${status.localBranch}.`
      )
    );
  }

  showAlreadyUpToDate(status: SyncStatus): void {
    const unpushed =
      status.unpushed && status.unpushed > 0
        ? ` You have ${plural(status.unpushed, 'commit')} not pushed to ${status.pushTarget}.`
        : '';
    void vscode.window.showInformationMessage(
      this.scoped(
        `${status.localBranch} is up to date with ${status.remote.name}/${status.remoteBranch}.${unpushed}`
      )
    );
  }

  /**
   * Routes the user to VS Code's own merge UI. Nothing is resolved
   * programmatically — that is deliberately the user's job.
   */
  async showConflicts(
    files: string[],
    absolutePath: (file: string) => string
  ): Promise<void> {
    const list =
      files.length > 0
        ? `: ${files.slice(0, 3).join(', ')}${files.length > 3 ? `, +${files.length - 3} more` : ''}`
        : '';

    void vscode.window
      .showWarningMessage(
        this.scoped(
          `Merge stopped with conflicts in ${files.length || 'some'} file(s)${list}. Resolve them, then commit.`
        ),
        SHOW_CONFLICTS
      )
      .then((choice) => {
        if (choice === SHOW_CONFLICTS) {
          void this.openMergeUi(files, absolutePath);
        }
      });

    await this.openMergeUi(files, absolutePath);
  }

  private async openMergeUi(
    files: string[],
    absolutePath: (file: string) => string
  ): Promise<void> {
    await vscode.commands.executeCommand('workbench.view.scm');

    const first = files[0];
    if (!first) {
      return;
    }

    const uri = vscode.Uri.file(absolutePath(first));
    // The merge editor needs all three sides from git. If the file is gone —
    // the merge was aborted, or the conflict is already resolved — asking for
    // it renders an error pane the user cannot act on, so check first.
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      this.logger.warn(`${first} no longer exists; not opening the merge editor.`);
      return;
    }

    try {
      // Contributed by the built-in git extension; opens the 3-way merge editor.
      await vscode.commands.executeCommand('git.openMergeEditor', uri);
    } catch (error) {
      this.logger.warn(
        `Could not open the merge editor for ${first}; falling back to the plain editor.`
      );
      this.logger.error('git.openMergeEditor failed', error);
      try {
        await vscode.window.showTextDocument(uri, { preview: false });
      } catch (openError) {
        this.logger.error(`Could not open ${first}`, openError);
      }
    }
  }

  showError(message: string, detail?: string): void {
    void vscode.window
      .showWarningMessage(this.scoped(`Git Sync Notifier: ${message}`), SHOW_LOG)
      .then((choice) => {
        if (choice === SHOW_LOG) {
          this.logger.show();
        }
      });
    if (detail) {
      this.logger.error(message, detail);
    }
  }

  dispose(): void {
    this.statusBar.forget(this.repoRoot);
  }
}


/**
 * "3 new commits on upstream/main from Teammate and 1 other — latest:
 * "fix login redirect" (12 minutes ago). Merge into feature?"
 */
export function describeIncoming(status: SyncStatus): string {
  const ref = `${status.remote.name}/${status.remoteBranch}`;
  const who = summarizeAuthors(status.commits);
  const latest = status.commits[0];

  const parts = [`${plural(status.behind, 'new commit')} on ${ref} from ${who}`];
  if (latest?.subject) {
    const subject =
      latest.subject.length > 60 ? `${latest.subject.slice(0, 57)}…` : latest.subject;
    parts.push(`— latest: "${subject}"${latest.relativeTime ? ` (${latest.relativeTime})` : ''}`);
  }

  let message = `${parts.join(' ')}. Merge into ${status.localBranch}?`;
  if (status.overlapFiles.length > 0) {
    message += ` ⚠️ ${plural(status.overlapFiles.length, 'file')} overlap with your changes.`;
  }
  return message;
}


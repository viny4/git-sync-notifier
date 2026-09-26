import * as vscode from 'vscode';
import { Logger } from './logger';
import { summarizeAuthors, SyncStatus } from './gitService';

export type StatusView =
  | { kind: 'hidden' }
  | { kind: 'checking' }
  | { kind: 'synced'; status: SyncStatus }
  | { kind: 'behind'; status: SyncStatus }
  | { kind: 'conflict' }
  | { kind: 'merging'; conflicted: number }
  | { kind: 'error'; message: string };

export type BehindChoice = 'merge' | 'details' | 'dismiss' | 'ignored';

const MERGE_NOW = 'Merge Now';
const DETAILS = 'Details';
const DISMISS = 'Dismiss';
const SHOW_CONFLICTS = 'Open Merge Editor';
const SHOW_LOG = 'Show Log';

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export class Notifier implements vscode.Disposable {
  private readonly statusBar: vscode.StatusBarItem;

  constructor(private readonly logger: Logger) {
    this.statusBar = vscode.window.createStatusBarItem(
      'gitSyncNotifier.status',
      vscode.StatusBarAlignment.Left,
      -1
    );
    this.statusBar.name = 'Git Sync Notifier';
    this.statusBar.command = 'gitSyncNotifier.checkNow';
  }

  setStatus(view: StatusView): void {
    switch (view.kind) {
      case 'hidden':
        this.statusBar.hide();
        return;

      case 'checking':
        this.statusBar.text = '$(sync~spin) Checking upstream';
        this.statusBar.tooltip = 'Fetching…';
        this.statusBar.backgroundColor = undefined;
        break;

      case 'synced':
        this.statusBar.text = `$(check) In sync${aheadSuffix(view.status)}`;
        this.statusBar.tooltip = buildTooltip(view.status);
        this.statusBar.backgroundColor = undefined;
        break;

      case 'behind':
        this.statusBar.text = `$(cloud-download) ↓${view.status.behind}${aheadSuffix(view.status)}`;
        this.statusBar.tooltip = buildTooltip(view.status);
        this.statusBar.backgroundColor = new vscode.ThemeColor(
          'statusBarItem.warningBackground'
        );
        break;

      case 'merging':
        this.statusBar.text =
          view.conflicted > 0
            ? `$(warning) ${plural(view.conflicted, 'conflict')} to resolve`
            : '$(git-merge) Finish merge';
        this.statusBar.tooltip =
          view.conflicted > 0
            ? 'A merge is in progress with unresolved conflicts. Resolve them, then commit.'
            : 'A merge is in progress with everything resolved — commit it to finish.';
        this.statusBar.backgroundColor = new vscode.ThemeColor(
          view.conflicted > 0
            ? 'statusBarItem.errorBackground'
            : 'statusBarItem.warningBackground'
        );
        break;

      case 'conflict':
        this.statusBar.text = '$(warning) Merge conflicts';
        this.statusBar.tooltip = 'Resolve the conflicts in the Source Control view.';
        this.statusBar.backgroundColor = new vscode.ThemeColor(
          'statusBarItem.errorBackground'
        );
        break;

      case 'error':
        this.statusBar.text = '$(error) Upstream check failed';
        this.statusBar.tooltip = `${view.message} Click to retry.`;
        this.statusBar.backgroundColor = new vscode.ThemeColor(
          'statusBarItem.warningBackground'
        );
        break;
    }

    this.statusBar.show();
  }

  /** The one notification this extension exists for. Never merges by itself. */
  async promptBehind(status: SyncStatus): Promise<BehindChoice> {
    const choice = await vscode.window.showInformationMessage(
      describeIncoming(status),
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
    const message =
      conflicted.length > 0
        ? `A merge is in progress with ${plural(conflicted.length, 'unresolved conflict')}. Resolve them, then commit.`
        : 'A merge is in progress and everything is resolved — commit it to finish.';

    const action = conflicted.length > 0 ? SHOW_CONFLICTS : 'Open Source Control';
    const choice = await vscode.window.showWarningMessage(message, action);
    if (choice === SHOW_CONFLICTS) {
      await this.openMergeUi(conflicted, absolutePath);
    } else if (choice === 'Open Source Control') {
      await vscode.commands.executeCommand('workbench.view.scm');
    }
  }

  showMergeSucceeded(status: SyncStatus): void {
    void vscode.window.showInformationMessage(
      `Merged ${plural(status.behind, 'commit')} from ${status.remote.name}/${status.remoteBranch} into ${status.localBranch}.`
    );
  }

  showAlreadyUpToDate(status: SyncStatus): void {
    const unpushed =
      status.unpushed && status.unpushed > 0
        ? ` You have ${plural(status.unpushed, 'commit')} not pushed to ${status.pushTarget}.`
        : '';
    void vscode.window.showInformationMessage(
      `${status.localBranch} is up to date with ${status.remote.name}/${status.remoteBranch}.${unpushed}`
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
        `Merge stopped with conflicts in ${files.length || 'some'} file(s)${list}. Resolve them, then commit.`,
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
      .showWarningMessage(`Git Sync Notifier: ${message}`, SHOW_LOG)
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
    this.statusBar.dispose();
  }
}

function aheadSuffix(status: SyncStatus): string {
  return status.ahead > 0 ? ` ↑${status.ahead}` : '';
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

function buildTooltip(status: SyncStatus): vscode.MarkdownString {
  const ref = `${status.remote.name}/${status.remoteBranch}`;
  const md = new vscode.MarkdownString(undefined, true);
  md.supportHtml = false;

  const where = status.remote.slug ? ` (\`${status.remote.slug}\`)` : '';
  md.appendMarkdown(`**${status.localBranch}** vs \`${ref}\`${where}\n\n`);

  md.appendMarkdown(
    status.behind > 0
      ? `- $(cloud-download) Behind by **${status.behind}** — ${plural(status.incomingFileCount, 'file')} changed\n`
      : '- $(check) Up to date\n'
  );
  if (status.ahead > 0) {
    md.appendMarkdown(`- $(git-commit) Ahead by **${status.ahead}** of \`${ref}\`\n`);
  }
  if (status.unpushed !== undefined && status.unpushed > 0) {
    md.appendMarkdown(
      `- $(cloud-upload) **${status.unpushed}** not pushed to \`${status.pushTarget}\`\n`
    );
  }
  if (status.overlapFiles.length > 0) {
    md.appendMarkdown(
      `- $(warning) ${plural(status.overlapFiles.length, 'file')} also changed here: ${status.overlapFiles
        .slice(0, 5)
        .map((file) => `\`${file}\``)
        .join(', ')}\n`
    );
  }

  if (status.commits.length > 0) {
    md.appendMarkdown('\n**Incoming**\n\n');
    for (const commit of status.commits.slice(0, 5)) {
      md.appendMarkdown(`- ${commit.subject} — *${commit.author}, ${commit.relativeTime}*\n`);
    }
    if (status.behind > 5) {
      md.appendMarkdown(`- …and ${status.behind - 5} more\n`);
    }
  }

  md.appendMarkdown('\nClick to check again.');
  return md;
}

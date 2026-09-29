import * as vscode from 'vscode';
import { SyncStatus } from './gitService';

export type StatusView =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'synced'; status: SyncStatus }
  | { kind: 'behind'; status: SyncStatus }
  | { kind: 'conflict' }
  | { kind: 'merging'; conflicted: number }
  | { kind: 'error'; message: string };

interface Entry {
  label: string;
  view: StatusView;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * One status bar item shared by every watched repository.
 *
 * With a single repo it reads exactly as it always did. With several — a
 * frontend, a backend, some services — it follows the file you are editing,
 * and falls back to a summary across all of them when the active file belongs
 * to none of them.
 */
export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly entries = new Map<string, Entry>();
  private activeRepo: string | undefined;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      'gitSyncNotifier.status',
      vscode.StatusBarAlignment.Left,
      -1
    );
    this.item.name = 'Git Sync Notifier';
    this.item.command = 'gitSyncNotifier.checkNow';
  }

  track(repoRoot: string, label: string): void {
    this.entries.set(repoRoot, { label, view: { kind: 'idle' } });
    this.render();
  }

  forget(repoRoot: string): void {
    this.entries.delete(repoRoot);
    if (this.activeRepo === repoRoot) {
      this.activeRepo = undefined;
    }
    this.render();
  }

  set(repoRoot: string, view: StatusView): void {
    const entry = this.entries.get(repoRoot);
    if (!entry) {
      return;
    }
    entry.view = view;
    this.render();
  }

  /** Called when the active editor changes, so the item follows your work. */
  setActiveRepo(repoRoot: string | undefined): void {
    if (this.activeRepo === repoRoot) {
      return;
    }
    this.activeRepo = repoRoot;
    this.render();
  }

  clear(): void {
    this.entries.clear();
    this.activeRepo = undefined;
    this.render();
  }

  private render(): void {
    if (this.entries.size === 0) {
      this.item.hide();
      return;
    }

    const multi = this.entries.size > 1;
    const active = this.activeRepo ? this.entries.get(this.activeRepo) : undefined;

    if (active) {
      this.renderOne(active, multi);
    } else if (multi) {
      this.renderSummary();
    } else {
      this.renderOne([...this.entries.values()][0]!, false);
    }

    this.item.show();
  }

  private renderOne(entry: Entry, showLabel: boolean): void {
    const prefix = showLabel ? `${entry.label} ` : '';
    const view = entry.view;

    switch (view.kind) {
      case 'idle':
        this.item.text = `${prefix}$(git-branch)`;
        this.item.tooltip = this.buildTooltip();
        this.item.backgroundColor = undefined;
        return;

      case 'checking':
        this.item.text = `${prefix}$(sync~spin)`;
        this.item.tooltip = 'Fetching…';
        this.item.backgroundColor = undefined;
        return;

      case 'synced':
        this.item.text = `${prefix}$(check) In sync${aheadSuffix(view.status)}`;
        this.item.tooltip = this.buildTooltip();
        this.item.backgroundColor = undefined;
        return;

      case 'behind':
        this.item.text = `${prefix}$(cloud-download) ↓${view.status.behind}${aheadSuffix(view.status)}`;
        this.item.tooltip = this.buildTooltip();
        this.item.backgroundColor = new vscode.ThemeColor(
          'statusBarItem.warningBackground'
        );
        return;

      case 'merging':
        this.item.text =
          view.conflicted > 0
            ? `${prefix}$(warning) ${plural(view.conflicted, 'conflict')} to resolve`
            : `${prefix}$(git-merge) Finish merge`;
        this.item.tooltip = this.buildTooltip();
        this.item.backgroundColor = new vscode.ThemeColor(
          view.conflicted > 0
            ? 'statusBarItem.errorBackground'
            : 'statusBarItem.warningBackground'
        );
        return;

      case 'conflict':
        this.item.text = `${prefix}$(warning) Merge conflicts`;
        this.item.tooltip = this.buildTooltip();
        this.item.backgroundColor = new vscode.ThemeColor(
          'statusBarItem.errorBackground'
        );
        return;

      case 'error':
        this.item.text = `${prefix}$(error) Check failed`;
        this.item.tooltip = this.buildTooltip();
        this.item.backgroundColor = new vscode.ThemeColor(
          'statusBarItem.warningBackground'
        );
        return;
    }
  }

  /** No active repo to follow: summarise every repository at once. */
  private renderSummary(): void {
    const views = [...this.entries.values()].map((entry) => entry.view);
    const behind = views.filter((view) => view.kind === 'behind') as Extract<
      StatusView,
      { kind: 'behind' }
    >[];
    const merging = views.some(
      (view) => view.kind === 'merging' || view.kind === 'conflict'
    );
    const failed = views.some((view) => view.kind === 'error');
    const totalBehind = behind.reduce((sum, view) => sum + view.status.behind, 0);

    if (merging) {
      this.item.text = '$(git-merge) Finish merge';
      this.item.backgroundColor = new vscode.ThemeColor(
        'statusBarItem.warningBackground'
      );
    } else if (behind.length === 1) {
      // "↓1 in 1 repo" reads badly; name the repository instead.
      const only = [...this.entries.values()].find(
        (entry) => entry.view.kind === 'behind'
      )!;
      this.renderOne(only, true);
      return;
    } else if (behind.length > 0) {
      this.item.text = `$(cloud-download) ↓${totalBehind} in ${plural(behind.length, 'repo')}`;
      this.item.backgroundColor = new vscode.ThemeColor(
        'statusBarItem.warningBackground'
      );
    } else if (failed) {
      this.item.text = '$(error) Check failed';
      this.item.backgroundColor = new vscode.ThemeColor(
        'statusBarItem.warningBackground'
      );
    } else {
      this.item.text = `$(check) ${plural(this.entries.size, 'repo')} in sync`;
      this.item.backgroundColor = undefined;
    }

    this.item.tooltip = this.buildTooltip();
  }

  /** Every repository, one line each, however many there are. */
  private buildTooltip(): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.supportHtml = false;

    for (const [repoRoot, entry] of this.entries) {
      const heading =
        this.entries.size > 1 ? `**${entry.label}** — ` : '';
      md.appendMarkdown(`${heading}${describe(entry.view)}\n\n`);

      const view = entry.view;
      if (view.kind === 'behind' || view.kind === 'synced') {
        md.appendMarkdown(details(view.status));
      }
      if (this.entries.size > 1 && repoRoot === this.activeRepo) {
        md.appendMarkdown('*(active editor)*\n\n');
      }
    }

    md.appendMarkdown('\nClick to check again.');
    return md;
  }

  dispose(): void {
    this.item.dispose();
  }
}

function aheadSuffix(status: SyncStatus): string {
  return status.ahead > 0 ? ` ↑${status.ahead}` : '';
}

function describe(view: StatusView): string {
  switch (view.kind) {
    case 'idle':
      return 'not checked yet';
    case 'checking':
      return 'checking…';
    case 'synced':
      return `up to date with \`${view.status.remote.name}/${view.status.remoteBranch}\``;
    case 'behind':
      return `behind \`${view.status.remote.name}/${view.status.remoteBranch}\` by **${view.status.behind}**`;
    case 'merging':
      return view.conflicted > 0
        ? `merge in progress, ${plural(view.conflicted, 'conflict')} left`
        : 'merge in progress — commit to finish';
    case 'conflict':
      return 'merge conflicts to resolve';
    case 'error':
      return view.message;
  }
}

function details(status: SyncStatus): string {
  const parts: string[] = [`- branch \`${status.localBranch}\`\n`];
  if (status.ahead > 0) {
    parts.push(`- ahead by **${status.ahead}**\n`);
  }
  if (status.unpushed !== undefined && status.unpushed > 0) {
    parts.push(
      `- **${status.unpushed}** not pushed to \`${status.pushTarget}\`\n`
    );
  }
  if (status.overlapFiles.length > 0) {
    parts.push(
      `- $(warning) ${plural(status.overlapFiles.length, 'file')} also changed here\n`
    );
  }
  if (status.behind > 0 && status.commits.length > 0) {
    for (const commit of status.commits.slice(0, 3)) {
      parts.push(`- ${commit.subject} — *${commit.author}, ${commit.relativeTime}*\n`);
    }
  }
  return `${parts.join('')}\n`;
}

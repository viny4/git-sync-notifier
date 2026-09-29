import * as vscode from 'vscode';
import { SyncStatus } from './gitService';

/**
 * One notification for a workspace where several repositories fell behind at
 * once.
 *
 * Ten repositories each raising their own toast is how an extension gets
 * uninstalled. Above a threshold they are collected into a single message with
 * a picker, so the user chooses what to merge instead of dismissing a stack of
 * popups.
 */
export interface SummaryEntry {
  label: string;
  status: SyncStatus;
  /** Merge this repository, exactly as its own notification would have. */
  merge: () => Promise<void>;
  /** Remember that this range was dismissed. */
  dismiss: () => Promise<void>;
  /** Called instead when the batch turned out too small to be worth summarising. */
  onOwnNotification: () => Promise<void>;
}

const REVIEW = 'Review';
const DISMISS_ALL = 'Dismiss All';

function plural(count: number, word: string, plural?: string): string {
  if (count === 1) {
    return `${count} ${word}`;
  }
  return `${count} ${plural ?? `${word}s`}`;
}

export class SummaryNotifier {
  private pending = new Map<string, SummaryEntry>();
  private timer: NodeJS.Timeout | undefined;
  private showing = false;

  private firstCollectedAt = 0;

  constructor(
    /** Batching only applies to workspaces with at least this many repos. */
    private readonly threshold: number,
    /** Never hold a notification longer than this. */
    private readonly maxWaitMs: number,
    /** Flush once no new repository has reported in for this long. */
    private readonly quietMs: number,
    /** How many repositories are being watched right now. */
    private readonly repoCount: () => number
  ) {}

  /**
   * Offers to take over this repository's notification. Returns false when the
   * repository should notify on its own — the usual case, with one or two
   * repositories behind.
   */
  collect(repoRoot: string, entry: SummaryEntry): boolean {
    // With one or two repositories open there is nothing to batch, and holding
    // the notification back would only add latency.
    if (this.repoCount() < this.threshold) {
      return false;
    }

    this.pending.set(repoRoot, entry);
    if (this.pending.size === 1) {
      this.firstCollectedAt = Date.now();
    }

    // Each new repository extends the wait, but never past maxWaitMs — so a
    // slow repository cannot hold everyone else's notification forever.
    if (this.timer) {
      clearTimeout(this.timer);
    }
    const remaining = this.maxWaitMs - (Date.now() - this.firstCollectedAt);
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.flush();
      },
      Math.max(0, Math.min(this.quietMs, remaining))
    );
    return true;
  }

  /**
   * True once enough repositories have queued that a summary will be shown.
   * Below the threshold the queue is released and each repository notifies.
   */
  private async flush(): Promise<void> {
    const entries = [...this.pending.values()];
    this.pending.clear();

    if (entries.length === 0) {
      return;
    }

    if (entries.length < this.threshold) {
      // Not a storm after all — let each repository speak for itself.
      for (const entry of entries) {
        await entry.onOwnNotification();
      }
      return;
    }

    if (this.showing) {
      return;
    }
    this.showing = true;
    try {
      await this.show(entries);
    } finally {
      this.showing = false;
    }
  }

  private async show(entries: SummaryEntry[]): Promise<void> {
    const total = entries.reduce((sum, entry) => sum + entry.status.behind, 0);
    const choice = await vscode.window.showInformationMessage(
      `${plural(entries.length, 'repository', 'repositories')} behind by ${plural(total, 'commit')} in total.`,
      REVIEW,
      DISMISS_ALL
    );

    if (choice === DISMISS_ALL) {
      for (const entry of entries) {
        await entry.dismiss();
      }
      return;
    }
    if (choice !== REVIEW) {
      return;
    }

    const picked = await vscode.window.showQuickPick(
      entries
        .sort((a, b) => b.status.behind - a.status.behind)
        .map((entry) => ({
          label: `$(repo) ${entry.label}`,
          description: `↓${entry.status.behind}${entry.status.overlapFiles.length > 0 ? `  ⚠️ ${plural(entry.status.overlapFiles.length, 'file')} overlap` : ''}`,
          detail: `${entry.status.localBranch} ← ${entry.status.remote.name}/${entry.status.remoteBranch} · latest: ${entry.status.commits[0]?.subject ?? ''}`,
          entry
        })),
      {
        title: 'Repositories behind',
        placeHolder: 'Pick the repositories to merge',
        canPickMany: true
      }
    );

    for (const item of picked ?? []) {
      await item.entry.merge();
    }
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pending.clear();
  }
}

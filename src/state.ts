import * as vscode from 'vscode';

const DISMISSED_KEY = 'gitSyncNotifier.dismissed';

/**
 * Identifies one "commit range" the user has already been told about: the local
 * tip, the upstream tip, and which branches they were. Any new commit on either
 * side produces a different signature, so the next alert is allowed through.
 */
export interface RangeSignature {
  repoRoot: string;
  localBranch: string;
  remote: string;
  remoteBranch: string;
  headSha: string;
  upstreamSha: string;
}

type DismissedMap = Record<string, string>;

function mapKey(signature: RangeSignature): string {
  return `${signature.repoRoot}::${signature.localBranch}`;
}

function signatureValue(signature: RangeSignature): string {
  return `${signature.remote}/${signature.remoteBranch}:${signature.headSha}..${signature.upstreamSha}`;
}

export class NotificationState {
  constructor(private readonly memento: vscode.Memento) {}

  private get map(): DismissedMap {
    return this.memento.get<DismissedMap>(DISMISSED_KEY, {});
  }

  /** True when the user already dismissed a notification for exactly this range. */
  isDismissed(signature: RangeSignature): boolean {
    return this.map[mapKey(signature)] === signatureValue(signature);
  }

  async markDismissed(signature: RangeSignature): Promise<void> {
    await this.memento.update(DISMISSED_KEY, {
      ...this.map,
      [mapKey(signature)]: signatureValue(signature)
    });
  }

  /**
   * Forgets the dismissal for a branch — used after a merge, so that if the
   * branch falls behind again the user hears about it.
   */
  async clear(signature: RangeSignature): Promise<void> {
    const next = { ...this.map };
    delete next[mapKey(signature)];
    await this.memento.update(DISMISSED_KEY, next);
  }
}

import * as vscode from 'vscode';

const DISMISSED_KEY = 'gitSyncNotifier.dismissed';
const SNOOZED_KEY = 'gitSyncNotifier.snoozed';

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
/** signature value -> epoch milliseconds until which it stays quiet. */
type SnoozedMap = Record<string, { value: string; until: number }>;

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

  private get snoozed(): SnoozedMap {
    return this.memento.get<SnoozedMap>(SNOOZED_KEY, {});
  }

  /** True when the user already dismissed a notification for exactly this range. */
  isDismissed(signature: RangeSignature): boolean {
    return this.map[mapKey(signature)] === signatureValue(signature);
  }

  /**
   * True when this range should not be shown right now — either dismissed
   * outright, or still inside the quiet period after a notification the user
   * never answered.
   */
  isSuppressed(signature: RangeSignature): boolean {
    if (this.isDismissed(signature)) {
      return true;
    }
    const entry = this.snoozed[mapKey(signature)];
    return (
      entry !== undefined &&
      entry.value === signatureValue(signature) &&
      entry.until > Date.now()
    );
  }

  /**
   * A notification the user never answered — VS Code hides toasts after a few
   * seconds, and without this the same range would be re-announced on every
   * poll for as long as the branch stays behind.
   */
  async snooze(signature: RangeSignature, forMs: number): Promise<void> {
    await this.memento.update(SNOOZED_KEY, {
      ...this.snoozed,
      [mapKey(signature)]: {
        value: signatureValue(signature),
        until: Date.now() + forMs
      }
    });
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

    const nextSnoozed = { ...this.snoozed };
    delete nextSnoozed[mapKey(signature)];
    await this.memento.update(SNOOZED_KEY, nextSnoozed);
  }
}

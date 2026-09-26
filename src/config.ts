import * as vscode from 'vscode';

export const CONFIG_SECTION = 'gitSyncNotifier';

/** Anything shorter than this would mean fetching from origin more or less constantly. */
const MIN_POLL_MINUTES = 1;

export interface SyncConfig {
  enabled: boolean;
  pollIntervalMinutes: number;
  /** `undefined` means "auto-detect the default branch". */
  remoteBranch: string | undefined;
  /** `undefined` means "prefer an `upstream` remote, else `origin`". */
  remote: string | undefined;
}

export function getConfig(scope?: vscode.Uri): SyncConfig {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION, scope);
  const interval = config.get<number>('pollIntervalMinutes', 5);
  const remoteBranch = config.get<string>('remoteBranch', '').trim();
  const remote = config.get<string>('remote', '').trim();

  return {
    enabled: config.get<boolean>('enabled', true),
    pollIntervalMinutes: Number.isFinite(interval)
      ? Math.max(MIN_POLL_MINUTES, interval)
      : 5,
    remoteBranch: remoteBranch.length > 0 ? remoteBranch : undefined,
    remote: remote.length > 0 ? remote : undefined
  };
}

export function affectsConfig(event: vscode.ConfigurationChangeEvent): boolean {
  return event.affectsConfiguration(CONFIG_SECTION);
}

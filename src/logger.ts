import * as vscode from 'vscode';

export class Logger implements vscode.Disposable {
  private readonly channel: vscode.OutputChannel;

  constructor() {
    this.channel = vscode.window.createOutputChannel('Git Sync Notifier');
  }

  info(message: string): void {
    this.write('info', message);
  }

  warn(message: string): void {
    this.write('warn', message);
  }

  error(message: string, detail?: unknown): void {
    this.write('error', message);
    if (detail !== undefined) {
      const text =
        detail instanceof Error ? (detail.stack ?? detail.message) : String(detail);
      this.channel.appendLine(text);
    }
  }

  show(): void {
    this.channel.show(true);
  }

  private write(level: string, message: string): void {
    const timestamp = new Date().toISOString();
    this.channel.appendLine(`[${timestamp}] [${level}] ${message}`);
  }

  dispose(): void {
    this.channel.dispose();
  }
}

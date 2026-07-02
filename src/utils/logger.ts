import * as vscode from 'vscode';

/**
 * Thin wrapper around a single `OutputChannel` so diagnostic detail
 * (skipped files, git errors, etc.) is available to curious users via
 * "Output" -> "Git Standup" without ever popping up a modal/toast.
 */
export class Logger implements vscode.Disposable {
  private readonly channel: vscode.OutputChannel;

  constructor(name = 'Git Standup') {
    this.channel = vscode.window.createOutputChannel(name);
  }

  info(message: string): void {
    this.write('INFO', message);
  }

  warn(message: string): void {
    this.write('WARN', message);
  }

  error(message: string, err?: unknown): void {
    this.write('ERROR', message);
    if (err !== undefined) {
      const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
      this.channel.appendLine(detail);
    }
  }

  private write(level: string, message: string): void {
    const timestamp = new Date().toISOString();
    this.channel.appendLine(`[${timestamp}] [${level}] ${message}`);
  }

  dispose(): void {
    this.channel.dispose();
  }
}

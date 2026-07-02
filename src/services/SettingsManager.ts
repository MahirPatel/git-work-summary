import * as vscode from 'vscode';
import { SummarySettings } from '../models/types';

const SECTION = 'gitWorkSummary';

/** Single source of truth for reading `gitWorkSummary.*` configuration. */
export class SettingsManager implements vscode.Disposable {
  private readonly configListener: vscode.Disposable;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor() {
    this.configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SECTION)) {
        this._onDidChange.fire();
      }
    });
  }

  getSettings(scope?: vscode.ConfigurationScope): SummarySettings {
    const config = vscode.workspace.getConfiguration(SECTION, scope);
    return {
      includeGitCommits: config.get<boolean>('includeGitCommits', true),
      includeStagedChanges: config.get<boolean>('includeStagedChanges', true),
      includeUnstagedChanges: config.get<boolean>('includeUnstagedChanges', true),
      includeModifiedFiles: config.get<boolean>('includeModifiedFiles', true),
      maxBullets: clamp(Math.trunc(config.get<number>('maxBullets', 10)), 1, 50),
      ignoredFolders: config.get<string[]>('ignoredFolders', []),
      ignoredExtensions: normalizeExtensions(config.get<string[]>('ignoredExtensions', [])),
      defaultExportFolder: config.get<string>('defaultExportFolder', ''),
      aiModel: config.get<string>('aiModel', 'qwen/qwen3-32b').trim() || 'qwen/qwen3-32b',
      aiMaxCommits: clamp(Math.trunc(config.get<number>('aiMaxCommits', 15)), 1, 50)
    };
  }

  dispose(): void {
    this.configListener.dispose();
    this._onDidChange.dispose();
  }
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function normalizeExtensions(exts: string[]): string[] {
  return exts
    .filter((e) => typeof e === 'string' && e.trim().length > 0)
    .map((e) => (e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`));
}

import * as vscode from 'vscode';
import { SummaryResult } from '../models/types';

/**
 * Holds the most recently generated summary and notifies subscribers
 * (the webview panel, the tree view) when it changes. This decouples
 * "who triggered generation" (a command, invoked from the palette or a
 * button) from "who displays the result" (two independent views).
 */
export class SummaryStateStore implements vscode.Disposable {
  private _current: SummaryResult | undefined;
  private readonly _onDidChange = new vscode.EventEmitter<SummaryResult | undefined>();
  readonly onDidChange = this._onDidChange.event;

  get current(): SummaryResult | undefined {
    return this._current;
  }

  set(result: SummaryResult | undefined): void {
    this._current = result;
    this._onDidChange.fire(result);
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

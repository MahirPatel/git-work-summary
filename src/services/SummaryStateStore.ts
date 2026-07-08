import * as vscode from 'vscode';
import { SummaryResult } from '../models/types';

/**
 * Holds the most recently generated summary - one `SummaryResult` per
 * selected workspace folder - and notifies subscribers (the webview panel,
 * the tree view) when it changes. This decouples "who triggered generation"
 * (a command, invoked from the palette or a button) from "who displays the
 * result" (two independent views). Invariant: `set()` is only ever called
 * with `undefined` (no summary generated / cleared) or a non-empty array -
 * never `[]` - so consumers never need to special-case an empty-but-defined
 * array.
 */
export class SummaryStateStore implements vscode.Disposable {
  private _current: SummaryResult[] | undefined;
  private readonly _onDidChange = new vscode.EventEmitter<SummaryResult[] | undefined>();
  readonly onDidChange = this._onDidChange.event;

  get current(): SummaryResult[] | undefined {
    return this._current;
  }

  set(results: SummaryResult[] | undefined): void {
    this._current = results;
    this._onDidChange.fire(results);
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

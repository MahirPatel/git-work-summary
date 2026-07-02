import * as vscode from 'vscode';

/**
 * Quietly resolves which workspace folder to analyze, without ever
 * prompting the user. Used by the automatic "Generate Summary" path so it
 * stays a single click in the common case.
 *
 * Preference order: an explicitly remembered folder (from a prior
 * `gitWorkSummary.selectWorkspaceFolder` invocation) -> the folder containing
 * the active editor -> the first workspace folder.
 */
export function resolveWorkspaceFolder(
  remembered?: vscode.WorkspaceFolder
): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0];
  }
  if (remembered && folders.some((f) => f.uri.toString() === remembered.uri.toString())) {
    return remembered;
  }
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri) {
    const match = vscode.workspace.getWorkspaceFolder(activeUri);
    if (match) {
      return match;
    }
  }
  return folders[0];
}

/**
 * Explicitly prompts the user to pick a workspace folder (multi-root only;
 * resolves immediately for zero/one folder workspaces). Used by the
 * "Select Workspace Folder" command so users can override the automatic
 * choice above.
 */
export async function pickWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0];
  }
  return vscode.window.showWorkspaceFolderPick({
    placeHolder: 'Select a workspace folder for Git Standup'
  });
}

import * as vscode from 'vscode';
import * as path from 'path';
import { SummaryStateStore } from '../services/SummaryStateStore';
import { CategoryDetail, CategoryDetailFile, GitCommitInfo, SummaryResult } from '../models/types';

interface RepoNode {
  kind: 'repo';
  result: SummaryResult;
}
interface CommitsRootNode {
  kind: 'commits-root';
  commits: GitCommitInfo[];
}
interface CommitNode {
  kind: 'commit';
  commit: GitCommitInfo;
}
interface CategoryNode {
  kind: 'category';
  detail: CategoryDetail;
  workspaceFolderPath: string;
}
interface FileNode {
  kind: 'file';
  file: CategoryDetailFile;
  workspaceFolderPath: string;
}

type TreeNode = RepoNode | CommitsRootNode | CommitNode | CategoryNode | FileNode;

/**
 * "Detected Changes" tree: a structured, drill-down view of exactly what
 * was found (commits today, then files grouped by category). Complements
 * the prose-style webview summary with something inspectable and clickable.
 * When more than one repo was summarized (multi-root selection), an extra
 * top-level "repo" node groups each folder's own commits/categories;
 * with exactly one result the tree stays flat, exactly as before.
 */
export class DetectedChangesTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly stateStore: SummaryStateStore) {
    this.stateStore.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    switch (element.kind) {
      case 'repo':
        return this.buildRepoItem(element);
      case 'commits-root':
        return this.buildCommitsRootItem(element);
      case 'commit':
        return this.buildCommitItem(element);
      case 'category':
        return this.buildCategoryItem(element);
      case 'file':
        return this.buildFileItem(element);
    }
  }

  getChildren(element?: TreeNode): TreeNode[] {
    const results = this.stateStore.current;
    if (!element) {
      if (!results || results.length === 0) {
        return [];
      }
      if (results.length === 1) {
        return this.buildResultChildren(results[0]!);
      }
      return results.map((result): RepoNode => ({ kind: 'repo', result }));
    }

    if (element.kind === 'repo') {
      return this.buildResultChildren(element.result);
    }
    if (element.kind === 'commits-root') {
      return element.commits.map((commit): CommitNode => ({ kind: 'commit', commit }));
    }
    if (element.kind === 'category') {
      return element.detail.files.map(
        (file): FileNode => ({ kind: 'file', file, workspaceFolderPath: element.workspaceFolderPath })
      );
    }
    return [];
  }

  /** Builds the flat commits-root/category children for one repo's result - shared by the single-result root and each `RepoNode`'s children. */
  private buildResultChildren(result: SummaryResult): TreeNode[] {
    const nodes: TreeNode[] = [];
    if (result.commits.length > 0) {
      nodes.push({ kind: 'commits-root', commits: result.commits });
    }
    for (const detail of result.details) {
      nodes.push({ kind: 'category', detail, workspaceFolderPath: result.workspaceFolderPath });
    }
    return nodes;
  }

  private buildRepoItem(element: RepoNode): vscode.TreeItem {
    const item = new vscode.TreeItem(element.result.workspaceFolderName, vscode.TreeItemCollapsibleState.Expanded);
    item.iconPath = new vscode.ThemeIcon('folder-library');
    item.contextValue = 'gitWorkSummary.repo';
    return item;
  }

  private buildCommitsRootItem(element: CommitsRootNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      `Commits Today (${element.commits.length})`,
      vscode.TreeItemCollapsibleState.Expanded
    );
    item.iconPath = new vscode.ThemeIcon('git-commit');
    item.contextValue = 'gitWorkSummary.commitsRoot';
    return item;
  }

  private buildCommitItem(element: CommitNode): vscode.TreeItem {
    const item = new vscode.TreeItem(element.commit.message, vscode.TreeItemCollapsibleState.None);
    item.description = `${element.commit.author} · ${element.commit.shortHash}`;
    item.iconPath = new vscode.ThemeIcon('git-commit');
    item.tooltip = `${element.commit.files.length} file(s) changed\n${element.commit.date}`;
    item.contextValue = 'gitWorkSummary.commit';
    return item;
  }

  private buildCategoryItem(element: CategoryNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      `${element.detail.category} (${element.detail.files.length})`,
      vscode.TreeItemCollapsibleState.Collapsed
    );
    item.iconPath = new vscode.ThemeIcon('folder');
    item.contextValue = 'gitWorkSummary.category';
    return item;
  }

  private buildFileItem(element: FileNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      path.posix.basename(element.file.relativePath),
      vscode.TreeItemCollapsibleState.None
    );
    item.description = path.posix.dirname(element.file.relativePath);
    item.tooltip = `${element.file.relativePath}\n${element.file.language} · ${element.file.changeTypes.join(', ')}`;
    item.resourceUri = vscode.Uri.file(path.join(element.workspaceFolderPath, element.file.relativePath));
    item.iconPath = vscode.ThemeIcon.File;
    item.contextValue = 'gitWorkSummary.file';
    item.command = {
      command: 'gitWorkSummary.openFile',
      title: 'Open File',
      arguments: [item.resourceUri]
    };
    return item;
  }
}

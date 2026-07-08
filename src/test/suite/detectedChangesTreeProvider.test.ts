import * as assert from 'assert';
import { DetectedChangesTreeProvider } from '../../views/DetectedChangesTreeProvider';
import { SummaryStateStore } from '../../services/SummaryStateStore';
import { SummaryResult } from '../../models/types';

function makeResult(overrides: Partial<SummaryResult>): SummaryResult {
  return {
    bullets: ['Did a thing'],
    workItems: [],
    aiSummaryUsed: false,
    teamWiseSummaryUsed: false,
    period: 'today',
    dateRange: { startDate: '2026-07-08', endDate: '2026-07-08' },
    generatedAt: new Date().toISOString(),
    workspaceFolderName: 'repo',
    workspaceFolderPath: '/repos/repo',
    stats: { commitCount: 0, filesChangedCount: 1, gitAvailable: true, isRepository: true },
    details: [
      {
        category: 'Backend',
        files: [{ relativePath: 'src/a.ts', language: 'TypeScript', changeTypes: ['modified'], sources: ['commit'] }]
      }
    ],
    commits: [],
    notices: [],
    ...overrides
  };
}

describe('DetectedChangesTreeProvider', () => {
  it('exposes a flat commits-root/category tree with no repo node when there is exactly one result', () => {
    const stateStore = new SummaryStateStore();
    const provider = new DetectedChangesTreeProvider(stateStore);
    stateStore.set([makeResult({})]);

    const roots = provider.getChildren();
    assert.strictEqual(roots.length, 1);
    assert.strictEqual(roots[0]!.kind, 'category');
  });

  it('groups multiple results under a repo node per result, in order', () => {
    const stateStore = new SummaryStateStore();
    const provider = new DetectedChangesTreeProvider(stateStore);
    const menu = makeResult({ workspaceFolderName: 'menu', workspaceFolderPath: '/repos/menu' });
    const inventory = makeResult({ workspaceFolderName: 'inventory', workspaceFolderPath: '/repos/inventory' });
    stateStore.set([menu, inventory]);

    const roots = provider.getChildren();
    assert.strictEqual(roots.length, 2);
    assert.deepStrictEqual(
      roots.map((r) => r.kind),
      ['repo', 'repo']
    );
    const [firstRoot, secondRoot] = roots;
    if (!firstRoot || !secondRoot || firstRoot.kind !== 'repo' || secondRoot.kind !== 'repo') {
      assert.fail('expected both root nodes to be repo nodes');
    }
    assert.strictEqual(firstRoot.result.workspaceFolderName, 'menu');
    assert.strictEqual(secondRoot.result.workspaceFolderName, 'inventory');
  });

  it('resolves each file to its own repo path, not another repo\'s, when multiple repos are shown', () => {
    const stateStore = new SummaryStateStore();
    const provider = new DetectedChangesTreeProvider(stateStore);
    const menu = makeResult({
      workspaceFolderName: 'menu',
      workspaceFolderPath: '/repos/menu',
      details: [
        {
          category: 'Backend',
          files: [{ relativePath: 'src/menu.ts', language: 'TypeScript', changeTypes: ['modified'], sources: ['commit'] }]
        }
      ]
    });
    const inventory = makeResult({
      workspaceFolderName: 'inventory',
      workspaceFolderPath: '/repos/inventory',
      details: [
        {
          category: 'Backend',
          files: [
            { relativePath: 'src/inventory.ts', language: 'TypeScript', changeTypes: ['modified'], sources: ['commit'] }
          ]
        }
      ]
    });
    stateStore.set([menu, inventory]);

    const [menuRepoNode, inventoryRepoNode] = provider.getChildren();
    if (!menuRepoNode || !inventoryRepoNode || menuRepoNode.kind !== 'repo' || inventoryRepoNode.kind !== 'repo') {
      assert.fail('expected repo nodes');
    }

    const [menuCategoryNode] = provider.getChildren(menuRepoNode);
    const [inventoryCategoryNode] = provider.getChildren(inventoryRepoNode);
    if (
      !menuCategoryNode ||
      !inventoryCategoryNode ||
      menuCategoryNode.kind !== 'category' ||
      inventoryCategoryNode.kind !== 'category'
    ) {
      assert.fail('expected category nodes');
    }

    const [menuFileNode] = provider.getChildren(menuCategoryNode);
    const [inventoryFileNode] = provider.getChildren(inventoryCategoryNode);
    if (!menuFileNode || !inventoryFileNode || menuFileNode.kind !== 'file' || inventoryFileNode.kind !== 'file') {
      assert.fail('expected file nodes');
    }

    assert.strictEqual(menuFileNode.workspaceFolderPath, '/repos/menu');
    assert.strictEqual(menuFileNode.file.relativePath, 'src/menu.ts');
    assert.strictEqual(inventoryFileNode.workspaceFolderPath, '/repos/inventory');
    assert.strictEqual(inventoryFileNode.file.relativePath, 'src/inventory.ts');
  });

  it('returns no nodes when nothing has been generated yet', () => {
    const stateStore = new SummaryStateStore();
    const provider = new DetectedChangesTreeProvider(stateStore);
    assert.deepStrictEqual(provider.getChildren(), []);
  });
});

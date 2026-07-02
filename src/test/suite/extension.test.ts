import * as assert from 'assert';
import * as vscode from 'vscode';

describe('Extension activation', () => {
  it('activates and registers every gitWorkSummary.* command', async () => {
    const ext = vscode.extensions.getExtension('mahirpatel.git-standup');
    assert.ok(ext, 'Extension should be discoverable by id');
    await ext?.activate();

    const commands = await vscode.commands.getCommands(true);
    const expected = [
      'gitWorkSummary.generateToday',
      'gitWorkSummary.generateYesterday',
      'gitWorkSummary.generateWeekly',
      'gitWorkSummary.generateMonthly',
      'gitWorkSummary.generateCustom',
      'gitWorkSummary.clearSummary',
      'gitWorkSummary.copySummary',
      'gitWorkSummary.exportMarkdown',
      'gitWorkSummary.refresh',
      'gitWorkSummary.selectWorkspaceFolder',
      'gitWorkSummary.openSettings',
      'gitWorkSummary.openFile',
      'gitWorkSummary.setGroqApiKey',
      'gitWorkSummary.clearGroqApiKey',
      'gitWorkSummary.toggleAiMode',
      'gitWorkSummary.setAiMode',
      'gitWorkSummary.generateCommitMessage',
      'gitWorkSummary.refreshStatus'
    ];

    for (const command of expected) {
      assert.ok(commands.includes(command), `Expected command "${command}" to be registered`);
    }
  });
});

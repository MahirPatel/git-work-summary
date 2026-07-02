import * as path from 'path';
import { runTests } from '@vscode/test-electron';

/**
 * Entry point for `npm test`. Downloads (and caches) a real VS Code
 * instance and runs the compiled Mocha suite inside its extension host,
 * so tests that touch the `vscode` module behave exactly as they would
 * for a real user.
 */
async function main(): Promise<void> {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');

    await runTests({ extensionDevelopmentPath, extensionTestsPath });
  } catch (err) {
    console.error('Failed to run tests');
    console.error(err);
    process.exit(1);
  }
}

void main();

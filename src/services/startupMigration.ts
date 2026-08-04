import * as vscode from 'vscode';
import { GROQ_API_KEY_SECRET } from '../commands';
import { DEFAULT_GROQ_API_KEY } from '../config/defaultApiKey';

const MIGRATED_VERSION_KEY = 'gitWorkSummary.migratedToVersion';

/**
 * One-time per-version migration. The previous default Groq model was deprecated
 * upstream, so every install is forced onto the new one regardless of its current
 * setting. A default API key is backfilled only when nothing is configured yet
 * (this setting and Secret Storage both empty) — an existing personal key,
 * wherever it lives, is never touched.
 */
export async function runStartupMigration(context: vscode.ExtensionContext): Promise<void> {
  const currentVersion = context.extension.packageJSON.version as string;
  if (context.globalState.get<string>(MIGRATED_VERSION_KEY) === currentVersion) {
    return;
  }

  const config = vscode.workspace.getConfiguration('gitWorkSummary');
  await config.update('aiModel', 'qwen/qwen3.6-27b', vscode.ConfigurationTarget.Global);

  const settingsKey = config.get<string>('apiKey', '').trim();
  const secretKey = await context.secrets.get(GROQ_API_KEY_SECRET);
  if (!settingsKey && !secretKey && DEFAULT_GROQ_API_KEY) {
    await config.update('apiKey', DEFAULT_GROQ_API_KEY, vscode.ConfigurationTarget.Global);
  }

  await context.globalState.update(MIGRATED_VERSION_KEY, currentVersion);
}

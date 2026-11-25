import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildHookCommand } from './installer.mjs';
import { resolvePluginLayout } from './release-layout.mjs';
import { namingModelIssue, namingSelectionConfigured } from './backend.mjs';

// pluginRoot 默认取布局解析的插件根：源码模式为源码目录，发布模式为发布根（hooks 清单所在处）。
export async function runDoctor({ backend, event, config, pluginRoot = resolvePluginLayout().root, configFile = join(homedir(), '.zcode', 'cli', 'config.json') }) {
  let userConfig = {};
  try { userConfig = JSON.parse(await readFile(configFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const native = config.registration === 'native';
  const hookFile = native ? join(pluginRoot, 'hooks', 'hooks.json') : configFile;
  let pluginConfig = {};
  if (native) {
    try { pluginConfig = JSON.parse(await readFile(hookFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const command = native ? undefined : buildHookCommand({ pluginRoot });
  const hooks = (native ? pluginConfig.hooks?.Stop ?? [] : userConfig.hooks?.events?.Stop ?? []).flatMap(entry => entry.hooks ?? [])
    .filter(hook => hook.type === 'command' && (native || hook.command === command));
  const enabled = userConfig.hooks?.enabled !== false && (!native || userConfig.plugins?.enabled !== false) && hooks.some(hook => hook.enabled !== false);
  const background = hooks.some(hook => hook.enabled !== false && hook.async === true);
  const snapshot = await backend.read();
  const view = await backend.models();
  let reasonCode;
  if (config.transport === 'source-server') {
    if (!namingSelectionConfigured(config.selection)) reasonCode = 'naming_selection_missing';
    else if (snapshot.sourceTaskMissing) reasonCode = 'source_task_unindexed';
    else if (namingModelIssue(view, config.selection)) reasonCode = 'naming_model_unavailable';
  }
  return {
    status: config.enabled !== false && enabled && background && !reasonCode ? 'ready' : 'not_ready',
    ...(reasonCode ? { reasonCode } : {}),
    sessionId: event.session_id, title: snapshot.title, turnCount: snapshot.turnCount,
    selectedTurns: snapshot.context.recent_turns.length, configuredModel: config.selection,
    providerCount: view.providers.length,
    hook: !hooks.length ? 'not_configured' : enabled ? 'configured' : 'disabled',
    hookDetails: { configFile: hookFile, source: native ? 'plugin' : 'user', enabled, async: background, execution: 'not_verified', ...(native ? { activation: 'not_verified', userConfigFile: configFile } : {}) }
  };
}

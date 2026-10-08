import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHookCommand } from './install.mjs';

export async function runDoctor({ backend, event, config, pluginRoot = fileURLToPath(new URL('.', import.meta.url)), configFile = join(homedir(), '.zcode', 'cli', 'config.json') }) {
  let userConfig = {};
  try { userConfig = JSON.parse(await readFile(configFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const command = buildHookCommand({ pluginRoot });
  const hooks = (userConfig.hooks?.events?.Stop ?? []).flatMap(entry => entry.hooks ?? [])
    .filter(hook => hook.type === 'command' && hook.command === command);
  const enabled = userConfig.hooks?.enabled !== false && hooks.some(hook => hook.enabled !== false);
  const background = hooks.some(hook => hook.enabled !== false && hook.async === true);
  const snapshot = await backend.read();
  const view = await backend.models();
  return {
    status: config.enabled !== false && enabled && background ? 'ready' : 'not_ready',
    sessionId: event.session_id, title: snapshot.title, turnCount: snapshot.turnCount,
    selectedTurns: snapshot.context.recent_turns.length, configuredModel: config.selection,
    providerCount: view.providers.length,
    hook: !hooks.length ? 'not_configured' : enabled ? 'configured' : 'disabled',
    hookDetails: { configFile, enabled, async: background, execution: 'not_verified' }
  };
}

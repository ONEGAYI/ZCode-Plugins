import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { installToastAssets, removeToastAssets } from '../notification-install.mjs';

test('公共通知安装按调用方注册身份，重复安装幂等，卸载不影响另一调用方', async () => {
  const files = new Map(), registry = new Map(), scripts = [];
  const shell = {
    mkdir: async () => {},
    readText: async path => {
      if (!files.has(path)) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      return files.get(path);
    },
    writeText: async (path, text) => { files.set(path, text); },
    remove: async path => { files.delete(path); },
    run: async (_cmd, args) => {
      if (args[0] === 'add') registry.set(args[1], args);
      else registry.delete(args[1]);
    },
    ps: async script => { scripts.push(script); }
  };
  const title = { pluginRoot: 'D:/plugins/title', dataDir: 'D:/data/title', nodeExe: 'C:/Node/node.exe',
    protocol: 'example-title', appId: 'Example.Title.Toast', shortcutName: '标题提醒.lnk', description: '标题提醒', shell };
  const mcp = { ...title, pluginRoot: 'D:/plugins/mcp', dataDir: 'D:/data/mcp', protocol: 'example-mcp',
    appId: 'Example.Mcp.Toast', shortcutName: '会话提醒.lnk', description: '会话提醒' };
  assert.equal((await installToastAssets(title)).appId, 'Example.Title.Toast');
  assert.equal((await installToastAssets(mcp)).appId, 'Example.Mcp.Toast');
  assert.equal((await installToastAssets(title)).actions.vbs, 'unchanged');
  assert.equal(files.get(join(mcp.dataDir, 'toast-appid.txt')), 'Example.Mcp.Toast');
  assert.ok(scripts[1].includes('会话提醒.lnk') && scripts[1].includes('Example.Mcp.Toast'));
  assert.ok(files.get(join(mcp.dataDir, 'toast-launch.vbs')).includes(join(mcp.pluginRoot, 'toast-action.mjs')));
  await removeToastAssets(title);
  assert.ok(!registry.has('HKCU\\Software\\Classes\\example-title'));
  assert.ok(registry.has('HKCU\\Software\\Classes\\example-mcp'));
  assert.ok(files.has(join(mcp.dataDir, 'toast-appid.txt')));
});

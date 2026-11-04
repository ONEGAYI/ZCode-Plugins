import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { installToastAssets, removeToastAssets } from '../notification-install.mjs';
import { toastRootFor } from '../toast-runtime.mjs';

// 全注入 shell：文件用 Map 模拟，注册表键、PowerShell 与 node 校验调用全部拦截。
const makeShell = (checkPasses = true) => {
  const files = new Map(), reg = new Map(), psScripts = [], runs = [];
  const shell = {
    files, reg, psScripts, runs,
    mkdir: async () => {},
    readText: async path => {
      if (!files.has(path)) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      return files.get(path);
    },
    writeText: async (path, text) => { files.set(path, text); },
    remove: async path => { files.delete(path); },
    rename: async (from, to) => {
      if (!files.has(from)) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      files.set(to, files.get(from));
      files.delete(from);
    },
    stat: async path => (files.has(path) ? { isFile: true } : null),
    run: async (cmd, args) => {
      runs.push({ cmd, args });
      if (args[0] === 'add') { reg.set(args[1], args); return ''; }
      if (args[0] === 'delete') { reg.delete(args[1]); return ''; }
      if (args[0] === 'query') return '    (默认)    REG_SZ    wscript.exe "D:\\stub\\toast-launch.vbs" "%1"';
      if (args[0] === '--check') {
        if (!checkPasses) throw new Error('node --check 失败：SyntaxError');
        return '';
      }
      return '';
    },
    ps: async script => { psScripts.push(script); },
  };
  return shell;
};

const HOME = 'H:\\toast-install-home';

test('公共通知安装按调用方注册身份，vbs 与快捷方式不引用版本缓存，重复安装幂等', async () => {
  const shell = makeShell();
  const toastRoot = toastRootFor(HOME);
  const title = { dataDir: 'D:/data/title', protocol: 'example-title', appId: 'Example.Title.Toast',
    shortcutName: '标题提醒.lnk', description: '标题提醒', homeDir: HOME, templateFile: 'toast-prompt-template.md',
    nodeExe: 'C:/Node/node.exe', pluginsFile: 'D:/自定义 存储/installed_plugins.json', shell };
  const first = await installToastAssets(title);
  assert.equal(first.appId, 'Example.Title.Toast');
  assert.equal(first.actions.vbs, 'written');
  const vbs = shell.files.get(join(title.dataDir, 'toast-launch.vbs'));
  assert.ok(vbs.includes(join(toastRoot, 'launch.vbs')), '调用方 vbs 必须转发到缓存外稳定启动器');
  assert.ok(!vbs.includes('toast-action.mjs'), '调用方 vbs 不得引用版本缓存内的命令入口');
  assert.ok(!vbs.includes('node'), '调用方 vbs 不直接引用 Node 路径');
  // 快捷方式与稳定部署落位
  assert.ok(shell.psScripts[0].includes(title.dataDir.replace(/'/g, "''")), '快捷方式工作目录指向调用方数据目录');
  assert.ok(!shell.psScripts[0].includes('D:/plugins'), '快捷方式工作目录不得指向版本缓存');
  assert.ok(shell.files.has(join(toastRoot, 'executor.mjs')), '共享执行器必须部署');
  assert.ok(shell.files.has(join(toastRoot, 'identities', 'example-title.json')), '身份描述必须外置登记');
  const identity = JSON.parse(shell.files.get(join(toastRoot, 'identities', 'example-title.json')));
  assert.equal(identity.protocol, 'example-title');
  assert.equal(identity.templateFile, 'toast-prompt-template.md');
  assert.equal(identity.pluginsFile, resolve(title.pluginsFile));
  // 幂等
  const second = await installToastAssets(title);
  assert.equal(second.actions.vbs, 'unchanged');
  assert.equal(second.actions.runtime, 'unchanged');
});

test('两个调用方共享稳定运行时，身份互不覆盖', async () => {
  const shell = makeShell();
  const toastRoot = toastRootFor(HOME);
  const base = { homeDir: HOME, nodeExe: 'C:/Node/node.exe', shell };
  const title = { ...base, dataDir: 'D:/data/title', protocol: 'example-title', appId: 'Example.Title.Toast', shortcutName: '标题提醒.lnk', description: '标题提醒' };
  const mcp = { ...base, dataDir: 'D:/data/mcp', protocol: 'example-mcp', appId: 'Example.Mcp.Toast', shortcutName: '会话提醒.lnk', description: '会话提醒' };
  await installToastAssets(title);
  await installToastAssets(mcp);
  const mcpVbs = shell.files.get(join(mcp.dataDir, 'toast-launch.vbs'));
  assert.ok(mcpVbs.includes('If uri <> "example-mcp://fix" And uri <> "example-mcp://mute" Then WScript.Quit 1'), '转发桥只放行本协议白名单动作');
  assert.ok(shell.files.has(join(toastRoot, 'identities', 'example-title.json')));
  assert.ok(shell.files.has(join(toastRoot, 'identities', 'example-mcp.json')));
  assert.equal(shell.runs.filter(run => run.args[0] === '--check').length, 1, '共享执行器只部署校验一次');
});

test('卸载只移除本身份与自有资产，保留共享运行时与另一调用方', async () => {
  const shell = makeShell();
  const toastRoot = toastRootFor(HOME);
  const base = { homeDir: HOME, nodeExe: 'C:/Node/node.exe', shell };
  const title = { ...base, dataDir: 'D:/data/title', protocol: 'example-title', appId: 'Example.Title.Toast', shortcutName: '标题提醒.lnk', description: '标题提醒' };
  const mcp = { ...base, dataDir: 'D:/data/mcp', protocol: 'example-mcp', appId: 'Example.Mcp.Toast', shortcutName: '会话提醒.lnk', description: '会话提醒' };
  await installToastAssets(title);
  await installToastAssets(mcp);
  await removeToastAssets({ dataDir: title.dataDir, protocol: title.protocol, shortcutName: title.shortcutName, homeDir: HOME, shell });
  assert.ok(!shell.reg.has('HKCU\\Software\\Classes\\example-title'), '必须删除自有协议键');
  assert.ok(shell.reg.has('HKCU\\Software\\Classes\\example-mcp'), '不得删除另一调用方协议键');
  assert.ok(!shell.files.has(join(toastRoot, 'identities', 'example-title.json')), '必须移除本身份描述');
  assert.ok(shell.files.has(join(toastRoot, 'identities', 'example-mcp.json')), '不得移除另一身份描述');
  assert.ok(shell.files.has(join(toastRoot, 'executor.mjs')), '不得移除共享执行器');
  assert.ok(shell.files.has(join(toastRoot, 'launch.vbs')), '不得移除稳定启动器');
  assert.ok(!shell.files.has(join(title.dataDir, 'toast-launch.vbs')), '必须移除自有 vbs');
  assert.ok(shell.files.has(join(mcp.dataDir, 'toast-appid.txt')), '不得删除另一调用方 AppID 缓存');
});

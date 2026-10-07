import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { copyPromptAndOpenWorkspace } from '../notification-action.mjs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

// 本测试文件不允许调用真实 PowerShell；即使注入参数被错误忽略，也不能写系统剪贴板。
const originalExecFile = childProcess.execFile;
let nativeCalls = 0;
childProcess.execFile = () => { nativeCalls++; throw new Error('notification test attempted native execution'); };
syncBuiltinESMExports();
after(() => {
  childProcess.execFile = originalExecFile;
  syncBuiltinESMExports();
  assert.equal(nativeCalls, 0, 'notification tests must use injected system boundaries');
});

test('公共按钮动作接收调用方提示词，先复制再打开默认工作区', async () => {
  const actions = [];
  await copyPromptAndOpenWorkspace({ prompt: '请检查会话 MCP 的配置', dataDir: 'D:/data/mcp',
    setClipboard: async (text, options) => { actions.push(['copy', text, options.dataDir]); },
    openWorkspace: async uri => { actions.push(['open', uri]); } });
  assert.deepEqual(actions, [['copy', '请检查会话 MCP 的配置', 'D:/data/mcp'],
    ['open', 'zcode://workspace/open?path=' + encodeURIComponent(join(homedir(), '.zcode', 'workspace', 'default'))]]);
});

test('复制失败明确报错且不打开工作区', async () => {
  let opened = false;
  await assert.rejects(copyPromptAndOpenWorkspace({ prompt: '检查配置', dataDir: 'D:/data',
    setClipboard: async () => { throw new Error('clipboard failure'); },
    openWorkspace: async () => { opened = true; } }), /clipboard failure/);
  assert.equal(opened, false);
});

test('剪贴板写入与首次回读均受竞争影响后仍重试，成功才打开工作区', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'zcode-common-clipboard-'));
  t.after(() => rm(dataDir, { recursive: true }));
  let calls = 0, opened = false;
  await copyPromptAndOpenWorkspace({ prompt: '检查配置', dataDir,
    executePowerShell: async () => {
      calls++;
      if (calls < 3) throw new Error('clipboard temporarily locked');
      return { stdout: '' };
    },
    openWorkspace: async () => { opened = true; }
  });
  assert.equal(opened, true);
  assert.equal(calls, 3);
});

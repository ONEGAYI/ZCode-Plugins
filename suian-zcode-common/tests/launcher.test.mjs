import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('VBS 隐藏 PowerShell 控制台，等待子进程并传回真实退出码', { skip: process.platform !== 'win32', timeout: 10000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'zcode-vbs-launcher-'));
  t.after(() => rm(root, { recursive: true }));
  const reportFile = join(root, 'own-child-window.json');
  const script = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -TypeDefinition @\'',
    'using System; using System.Runtime.InteropServices;',
    'public static class GatewayLauncherWindowProbe {',
    '  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();',
    '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);',
    '}',
    "'@",
    '$visible = [GatewayLauncherWindowProbe]::IsWindowVisible([GatewayLauncherWindowProbe]::GetConsoleWindow())',
    '[IO.File]::WriteAllText($env:ZCODE_GATEWAY_TEST_REPORT, (@{ console_visible=$visible } | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))',
    'exit 23'
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  await assert.rejects(promisify(execFile)(join(process.env.SystemRoot, 'System32', 'wscript.exe'),
    ['//B', '//NoLogo', fileURLToPath(new URL('../run.vbs', import.meta.url)), encoded],
    { windowsHide: true, timeout: 8000, env: { ...process.env, ZCODE_GATEWAY_TEST_REPORT: reportFile } }), error => error.code === 23);
  assert.deepEqual(JSON.parse(await readFile(reportFile, 'utf8')), { console_visible: false });
});

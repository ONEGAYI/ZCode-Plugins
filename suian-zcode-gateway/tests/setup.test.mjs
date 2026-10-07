import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const setup = fileURLToPath(new URL('../setup.ps1', import.meta.url));
const gatewayRoot = dirname(setup);
const nativeExec = promisify(execFile);

// 只替换 Windows 系统边界，真实执行 setup.ps1 与临时目录内的文件读写。
const systemFixture = String.raw`
param([string]$Script, [string]$Action, [string]$DataDir, [string]$SkillsDir, [string]$StateFile)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$global:fixture = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
function Save-Fixture { [IO.File]::WriteAllText($StateFile, ($global:fixture | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding($false))) }
function Get-ItemProperty { param([string]$LiteralPath) if ($LiteralPath -ne 'HKCU:\Environment') { throw '禁止访问其他注册表路径' }; if ($null -eq $global:fixture.relay) { return [pscustomobject]@{} }; return [pscustomobject]@{ ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL = $global:fixture.relay } }
function New-ItemProperty { param([string]$LiteralPath, [string]$Name, [string]$Value, [string]$PropertyType, [switch]$Force) if ($LiteralPath -ne 'HKCU:\Environment' -or $Name -ne 'ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL') { throw '修改了非目标变量' }; $global:fixture.relay = $Value; Save-Fixture }
function Remove-ItemProperty { param([string]$LiteralPath, [string]$Name) if ($LiteralPath -ne 'HKCU:\Environment' -or $Name -ne 'ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL') { throw '删除了非目标变量' }; $global:fixture.relay = $null; Save-Fixture }
function Get-ScheduledTask { if ($null -ne $global:fixture.task) { return $global:fixture.task } }
function New-ScheduledTaskAction { param([string]$Execute, [string]$Argument) return [pscustomobject]@{ Execute=$Execute; Arguments=$Argument } }
function New-ScheduledTaskTrigger { param([switch]$AtLogOn, [string]$User) return [pscustomobject]@{ AtLogOn=[bool]$AtLogOn; User=$User } }
function New-ScheduledTaskPrincipal { param([string]$UserId, [string]$LogonType, [string]$RunLevel) return [pscustomobject]@{ UserId=$UserId; LogonType=$LogonType; RunLevel=$RunLevel } }
function New-ScheduledTaskSettingsSet { param([TimeSpan]$ExecutionTimeLimit, [int]$RestartCount, [TimeSpan]$RestartInterval, [string]$MultipleInstances, [switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries) return [pscustomobject]@{ ExecutionTimeLimit=$ExecutionTimeLimit.TotalSeconds; RestartCount=$RestartCount; MultipleInstances=$MultipleInstances } }
function Register-ScheduledTask { param([string]$TaskName, $Action, $Trigger, $Principal, $Settings, [switch]$Force) $global:fixture.task = [pscustomobject]@{ TaskName=$TaskName; TaskPath='\'; Actions=$Action; Trigger=$Trigger; Principal=$Principal; Settings=$Settings; State='Ready' }; $global:fixture.registrations++; Save-Fixture }
function Start-ScheduledTask { param([string]$TaskName) if ($TaskName -ne $global:fixture.task.TaskName) { throw '启动了其他任务' }; $global:fixture.task.State='Running'; $global:fixture.starts++; Save-Fixture }
function Stop-ScheduledTask { throw 'Gateway already accepted self shutdown; do not terminate its exiting launcher' }
function Unregister-ScheduledTask { param([string]$TaskName, [bool]$Confirm) if ($TaskName -ne $global:fixture.task.TaskName -or $Confirm) { throw '删除了其他任务' }; $global:fixture.task=$null; Save-Fixture }
function Invoke-RestMethod { param([string]$Uri, [int]$TimeoutSec, [switch]$UseBasicParsing, [string]$Method, $Headers) if ($global:fixture.health -eq 'failure') { throw 'fixture: 网关启动失败' }; $config = Get-Content -LiteralPath (Join-Path $DataDir 'config.json') -Raw | ConvertFrom-Json; if ($Method -eq 'Post') { if ($Headers.Authorization -ne ('Bearer ' + $config.control_token)) { throw '控制令牌错误' }; $global:fixture.shutdowns++; Save-Fixture; return [pscustomobject]@{ ok=$true } }; $id = if ($global:fixture.health -eq 'foreign') { 'foreign-instance' } else { $config.instance_id }; return [pscustomobject]@{ service='suian-zcode-gateway'; version=1; instance_id=$id; upstream_url=$config.upstream_url; desktop_connected=$global:fixture.desktop; upstream_connected=$false; paired=$false } }
& $Script -Action $Action -DataDir $DataDir -SkillsDir $SkillsDir
`;

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'zcode-gateway-'));
  t.after(() => rm(root, { recursive: true }));
  const stateFile = join(root, 'system.json');
  const script = join(root, 'Windows 边界 fixture.ps1');
  const dataDir = join(root, '公共 data');
  const skillsDir = join(root, 'skills');
  const initial = { relay: 'wss://previous.example/ws', task: null, registrations: 0, starts: 0, shutdowns: 0, health: 'ready', desktop: false, ...overrides };
  await writeFile(stateFile, JSON.stringify(initial));
  await writeFile(script, '\uFEFF' + systemFixture);
  const run = async (action) => {
    const { stdout } = await nativeExec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Script', setup, '-Action', action, '-DataDir', dataDir, '-SkillsDir', skillsDir, '-StateFile', stateFile], { windowsHide: true });
    return JSON.parse(stdout.trim());
  };
  const state = async () => JSON.parse(await readFile(stateFile, 'utf8'));
  return { root, stateFile, dataDir, skillsDir, run, state };
}

test('公共安装部署唯一用户启动任务和 skill，网关就绪后才设置 Desktop 用户环境', { skip: process.platform !== 'win32' }, async (t) => {
  const f = await fixture(t);
  const result = await f.run('Install');
  assert.equal(result.ok, true);
  assert.equal(result.relay_url, 'ws://127.0.0.1:17329/ws');
  assert.equal(result.restart_required, true);
  const state = await f.state();
  assert.equal(state.relay, 'ws://127.0.0.1:17329/ws');
  assert.equal(state.task.State, 'Running');
  assert.equal(state.task.Principal.RunLevel, 'Limited');
  assert.equal(state.task.Principal.LogonType, 'Interactive');
  assert.equal(state.task.Trigger.AtLogOn, true);
  assert.equal(state.task.Settings.ExecutionTimeLimit, 0);
  const encoded = state.task.Actions.Arguments.match(/-EncodedCommand ([A-Za-z0-9+/=]+)$/)[1];
  const launch = Buffer.from(encoded, 'base64').toString('utf16le');
  assert.ok(launch.includes(join(gatewayRoot, 'run.ps1')));
  const config = JSON.parse((await readFile(join(f.dataDir, 'config.json'), 'utf8')).replace(/^\uFEFF/, ''));
  assert.equal(config.previous_user_relay, 'wss://previous.example/ws');
  assert.equal(config.gateway_root, gatewayRoot);
  assert.match(config.control_token, /^[a-f0-9]{32}$/);
  assert.ok(!JSON.stringify(result).includes(config.control_token));
  const skill = await readFile(join(f.skillsDir, 'suian-zcode-gateway', 'SKILL.md'), 'utf8');
  assert.ok(skill.includes(gatewayRoot));
  assert.ok(!skill.includes('<!-- suian-zcode-gateway:root -->'));
});

test('重复初始化复用唯一实例与原环境备份；状态区分未配置和 Desktop 已连接', { skip: process.platform !== 'win32' }, async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run('Status')).configured, false);
  await f.run('Install');
  await f.run('Install');
  const state = await f.state();
  assert.equal(state.registrations, 1);
  assert.equal(state.starts, 1);
  const config = JSON.parse(await readFile(join(f.dataDir, 'config.json'), 'utf8'));
  assert.equal(config.previous_user_relay, 'wss://previous.example/ws');
  const waiting = await f.run('Status');
  assert.equal(waiting.configured, true);
  assert.equal(waiting.user_env_matches, true);
  assert.equal(waiting.gateway_running, true);
  assert.equal(waiting.desktop_connected, false);
  assert.equal(waiting.restart_required, true);
  state.desktop = true;
  await writeFile(f.stateFile, JSON.stringify(state));
  const connected = await f.run('Status');
  assert.equal(connected.desktop_connected, true);
  assert.equal(connected.restart_required, false);
  assert.equal(connected.paired, false);
});

test('移除前拒绝切断 Desktop；退出后恢复原用户环境或保留外部修改', { skip: process.platform !== 'win32' }, async (t) => {
  for (const original of ['wss://previous.example/ws', null, 'external']) {
    const f = await fixture(t, { relay: original === 'external' ? null : original });
    await f.run('Install');
    let state = await f.state();
    state.desktop = true;
    await writeFile(f.stateFile, JSON.stringify(state));
    await assert.rejects(f.run('Remove'), /quit ZCode/);
    assert.equal((await f.state()).task.State, 'Running');
    state.desktop = false;
    if (original === 'external') state.relay = 'wss://external.example/ws';
    await writeFile(f.stateFile, JSON.stringify(state));
    const result = await f.run('Remove');
    state = await f.state();
    assert.equal(state.task, null);
    assert.equal(state.shutdowns, 1);
    assert.equal(state.relay, original === 'external' ? 'wss://external.example/ws' : original);
    assert.equal(result.user_env_action, original === 'external' ? 'preserved_external' : 'restored');
    await assert.rejects(readFile(join(f.dataDir, 'config.json')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(f.skillsDir, 'suian-zcode-gateway', 'SKILL.md')), { code: 'ENOENT' });
    assert.equal((await f.run('Remove')).action, 'not_installed');
  }
});

test('启动失败或健康接口属于其他实例时明确失败，不写网关环境变量', { skip: process.platform !== 'win32' }, async (t) => {
  for (const health of ['failure', 'foreign']) {
    const f = await fixture(t, { health });
    await assert.rejects(f.run('Install'), health === 'failure' ? /fixture: 网关启动失败/ : /different instance/);
    assert.equal((await f.state()).relay, 'wss://previous.example/ws');
    const config = JSON.parse(await readFile(join(f.dataDir, 'config.json'), 'utf8'));
    assert.equal(config.previous_user_relay, 'wss://previous.example/ws');
  }
});

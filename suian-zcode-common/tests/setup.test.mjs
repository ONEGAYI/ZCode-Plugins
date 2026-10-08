import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const setup = fileURLToPath(new URL('../setup.ps1', import.meta.url));
const gatewayRoot = dirname(setup);
const nativeExec = promisify(execFile);

// 只替换 Windows 系统边界，真实执行 setup.ps1 与临时目录内的文件读写。
const systemFixture = String.raw`
param([string]$Script, [string]$Action, [string]$DataDir, [string]$SkillsDir, [string]$StateFile, [int]$HealthTimeoutSec, [int]$Port, [string]$Mode)
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
function Start-ScheduledTask { param([string]$TaskName) if ($TaskName -ne $global:fixture.task.TaskName) { throw '启动了其他任务' }; $global:fixture.task.State='Running'; $global:fixture.health_available=$true; $global:fixture.starts++; Save-Fixture }
function Stop-ScheduledTask { throw 'Gateway already accepted self shutdown; do not terminate its exiting launcher' }
function Unregister-ScheduledTask { param([string]$TaskName, [bool]$Confirm) if ($TaskName -ne $global:fixture.task.TaskName -or $Confirm) { throw '删除了其他任务' }; $global:fixture.task=$null; Save-Fixture }
function Invoke-RestMethod {
    param([string]$Uri, [int]$TimeoutSec, [switch]$UseBasicParsing, [string]$Method, $Headers)
    $global:fixture.http_attempts++; Save-Fixture
    if ($global:fixture.health -eq 'failure') { throw 'fixture: 网关启动失败' }
    $config = Get-Content -LiteralPath (Join-Path $DataDir 'config.json') -Raw | ConvertFrom-Json
    if (([Uri]$Uri).Port -ne $config.port) { throw [Net.WebException]::new('fixture: wrong health port', [Net.WebExceptionStatus]::ConnectFailure) }
    if ($Method -eq 'Post') {
        if ($Headers.Authorization -ne ('Bearer ' + $config.control_token)) { throw '控制令牌错误' }
        $global:fixture.shutdowns++; $global:fixture.draining=($global:fixture.shutdown_health_reads -gt 0); $global:fixture.health_available=$global:fixture.draining; if ($null -ne $global:fixture.task) { $global:fixture.task.State='Ready' }; Save-Fixture
        return [pscustomobject]@{ ok=$true }
    }
    if (-not $global:fixture.health_available) { throw [Net.WebException]::new('fixture: no health listener', [Net.WebExceptionStatus]::ConnectFailure) }
    if ($global:fixture.draining) { $global:fixture.shutdown_health_reads--; if ($global:fixture.shutdown_health_reads -eq 0) { $global:fixture.draining=$false; $global:fixture.health_available=$false } }
    $global:fixture.health_requests++
    if ($global:fixture.timeouts_left -gt 0 -or $TimeoutSec -lt $global:fixture.health_min_timeout) {
        if ($global:fixture.timeouts_left -gt 0) { $global:fixture.timeouts_left-- }
        Save-Fixture
        throw [Net.WebException]::new('fixture: health timeout', [Net.WebExceptionStatus]::Timeout)
    }
    Save-Fixture
    $id = if ($global:fixture.health -eq 'foreign') { 'foreign-instance' } else { $config.instance_id }
    $mode = if ($config.PSObject.Properties['mode']) { $config.mode } else { 'relay' }
    $reply = [pscustomobject]@{ service='suian-zcode-gateway'; version=1; instance_id=$id; upstream_url=$config.upstream_url; mode=$mode; desktop_connected=$global:fixture.desktop; desktop_ready=$global:fixture.desktop; upstream_connected=$false; paired=$false; rpc_protocol_version=1; upstream_paired=$false; local_clients=0 }
    if ($global:fixture.legacy_health) { $reply.PSObject.Properties.Remove('mode'); $reply.PSObject.Properties.Remove('desktop_ready') }
    return $reply
}
$params = @{ Action=$Action; DataDir=$DataDir; SkillsDir=$SkillsDir }
if ($PSBoundParameters.ContainsKey('HealthTimeoutSec')) { $params.HealthTimeoutSec=$HealthTimeoutSec }
if ($PSBoundParameters.ContainsKey('Port')) { $params.Port=$Port }
if ($PSBoundParameters.ContainsKey('Mode')) { $params.Mode=$Mode }
& $Script @params
`;

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'zcode-gateway-'));
  t.after(() => rm(root, { recursive: true }));
  const stateFile = join(root, 'system.json');
  const script = join(root, 'Windows 边界 fixture.ps1');
  const dataDir = join(root, '公共 data');
  const skillsDir = join(root, 'skills');
  const initial = { relay: 'wss://previous.example/ws', task: null, registrations: 0, starts: 0, shutdowns: 0, health: 'ready', desktop: false, legacy_health: false, health_min_timeout: 0, timeouts_left: 0, health_requests: 0, http_attempts: 0, health_available: false, draining: false, shutdown_health_reads: 0, ...overrides };
  await writeFile(stateFile, JSON.stringify(initial));
  await writeFile(script, '\uFEFF' + systemFixture);
  const run = async (action, { healthTimeoutSec, port, mode } = {}) => {
    const { stdout } = await nativeExec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Script', setup, '-Action', action, '-DataDir', dataDir, '-SkillsDir', skillsDir, '-StateFile', stateFile, ...(healthTimeoutSec === undefined ? [] : ['-HealthTimeoutSec', String(healthTimeoutSec)]), ...(port === undefined ? [] : ['-Port', String(port)]), ...(mode === undefined ? [] : ['-Mode', mode])], { windowsHide: true });
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
  assert.equal(state.task.Actions.Execute, join(process.env.SystemRoot, 'System32', 'wscript.exe'));
  const launcherFile = join(f.dataDir, 'gateway-launch.vbs');
  assert.ok(state.task.Actions.Arguments.includes('"' + launcherFile + '"'));
  assert.ok((await readFile(launcherFile, 'utf16le')).includes('Option Explicit'));
  const encoded = state.task.Actions.Arguments.match(/([A-Za-z0-9+/=]+)$/)[1];
  const launch = Buffer.from(encoded, 'base64').toString('utf16le');
  assert.ok(launch.includes(join(gatewayRoot, 'run.ps1')));
  const config = JSON.parse((await readFile(join(f.dataDir, 'config.json'), 'utf8')).replace(/^\uFEFF/, ''));
  assert.equal(config.previous_user_relay, 'wss://previous.example/ws');
  assert.equal(config.gateway_root, gatewayRoot);
  assert.match(config.control_token, /^[a-f0-9]{32}$/);
  assert.ok(!JSON.stringify(result).includes(config.control_token));
  const skill = await readFile(join(f.skillsDir, 'suian-zcode-common', 'SKILL.md'), 'utf8');
  assert.ok(skill.includes(gatewayRoot));
  assert.ok(!skill.includes('<!-- suian-zcode-common:root -->'));
});

test('本地模式可首次安装，重载保留模式，切换模式先暂停远控并保留原环境备份', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const installed = await f.run('Install', { mode: 'local-only' });
  assert.equal(installed.mode, 'local-only');
  assert.equal(installed.gateway_running, true);
  const before = JSON.parse(await readFile(join(f.dataDir, 'config.json'), 'utf8'));
  assert.equal(before.mode, 'local-only');
  let state = await f.state(); state.desktop = true;
  await writeFile(f.stateFile, JSON.stringify(state));
  const ready = await f.run('Status');
  assert.equal(ready.mode, 'local-only');
  assert.equal(ready.desktop_ready, true);
  assert.equal(ready.upstream_connected, false);
  await assert.rejects(f.run('Install', { mode: 'relay' }), /use Restart/);
  await assert.rejects(f.run('Restart', { mode: 'relay' }), /Stop mobile remote control/);
  assert.deepEqual(JSON.parse(await readFile(join(f.dataDir, 'config.json'), 'utf8')), before);
  state = await f.state(); state.desktop = false;
  await writeFile(f.stateFile, JSON.stringify(state));
  assert.equal((await f.run('Restart')).mode, 'local-only');
  assert.equal((await f.run('Restart', { mode: 'relay' })).mode, 'relay');
  const after = JSON.parse(await readFile(join(f.dataDir, 'config.json'), 'utf8'));
  assert.equal(after.mode, 'relay');
  for (const field of ['port', 'upstream_url', 'previous_user_relay', 'control_token']) assert.equal(after[field], before[field]);
});

test('旧配置和旧健康端点缺少模式时按 relay 兼容，不改变原环境备份', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t, { legacy_health: true });
  await f.run('Install');
  const configFile = join(f.dataDir, 'config.json');
  const config = JSON.parse(await readFile(configFile, 'utf8')); delete config.mode;
  await writeFile(configFile, JSON.stringify(config));
  const status = await f.run('Status');
  assert.equal(status.mode, 'relay');
  assert.equal(status.desktop_ready, null);
  assert.equal((await f.run('Install')).mode, 'relay');
  assert.equal((await f.state()).starts, 1);
  assert.equal(JSON.parse(await readFile(configFile, 'utf8')).previous_user_relay, config.previous_user_relay);
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
   assert.equal(waiting.rpc_available, true);
   assert.equal(waiting.upstream_paired, false);
   assert.equal(waiting.local_clients, 0);
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
    const result = await f.run('Remove', { port: 17331 });
    state = await f.state();
    assert.equal(state.task, null);
    assert.equal(state.shutdowns, 1);
    assert.equal(state.relay, original === 'external' ? 'wss://external.example/ws' : original);
    assert.equal(result.user_env_action, original === 'external' ? 'preserved_external' : 'restored');
    await assert.rejects(readFile(join(f.dataDir, 'config.json')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(f.dataDir, 'gateway-launch.vbs')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(f.skillsDir, 'suian-zcode-common', 'SKILL.md')), { code: 'ENOENT' });
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

test('重载拒绝切断远控；暂停远控后迁移旧目录并保留端口、上游、环境备份与控制令牌', { skip: process.platform !== 'win32' }, async (t) => {
  const f = await fixture(t);
  await f.run('Install');
  const configFile = join(f.dataDir, 'config.json');
  const old = JSON.parse(await readFile(configFile, 'utf8'));
  old.gateway_root = 'D:/old-repo/suian-zcode-gateway';
  old.instance_id = createHash('sha256').update(old.gateway_root.toLowerCase()).digest('hex');
  old.port = 17330;
  old.upstream_url = 'wss://zcode.chatglm.site/ws';
  await writeFile(configFile, JSON.stringify(old));
  const oldSkillFile = join(f.skillsDir, 'suian-zcode-gateway', 'SKILL.md');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dirname(oldSkillFile), { recursive: true });
  await writeFile(oldSkillFile, '**本机网关根**：`' + old.gateway_root + '`');
  let state = await f.state();
  state.desktop = true;
  await writeFile(f.stateFile, JSON.stringify(state));
  await assert.rejects(f.run('Restart'), /Stop mobile remote control in ZCode.*keep ZCode open/);
  assert.equal((await f.state()).shutdowns, 0);
  assert.deepEqual(JSON.parse(await readFile(configFile, 'utf8')), old);
  state.desktop = false;
  await writeFile(f.stateFile, JSON.stringify(state));
  const result = await f.run('Restart');
  const updated = JSON.parse(await readFile(configFile, 'utf8'));
  assert.equal(result.action, 'restarted');
  assert.equal(updated.gateway_root, gatewayRoot);
  for (const field of ['port', 'upstream_url', 'previous_user_relay', 'control_token'])
    assert.equal(updated[field], old[field]);
  state = await f.state();
  assert.equal(state.registrations, 2);
  assert.equal(state.starts, 2);
  assert.equal(state.shutdowns, 1);
  assert.equal(state.relay, 'ws://127.0.0.1:17330/ws');
  await assert.rejects(readFile(oldSkillFile), { code: 'ENOENT' });
});

test('修改端口先停止旧端口实例，再完成新配置；应用重启留到安装完成后', { skip: process.platform !== 'win32' }, async (t) => {
  const f = await fixture(t);
  await f.run('Install');
  const configFile = join(f.dataDir, 'config.json');
  const before = await readFile(configFile, 'utf8');
  let state = await f.state();
  state.desktop = true;
  await writeFile(f.stateFile, JSON.stringify(state));
  await assert.rejects(f.run('Install', { port: 17331 }), /use Restart/);
  await assert.rejects(f.run('Restart', { port: 17331 }), /Stop mobile remote control in ZCode.*keep ZCode open/);
  assert.equal(await readFile(configFile, 'utf8'), before);
  assert.equal((await f.state()).shutdowns, 0);
  state = await f.state();
  state.desktop = false;
  await writeFile(f.stateFile, JSON.stringify(state));
  const result = await f.run('Restart', { port: 17331 });
  assert.equal(result.action, 'restarted');
  assert.equal(result.gateway_running, true);
  assert.equal(result.relay_url, 'ws://127.0.0.1:17331/ws');
  assert.equal(result.health_url, 'http://127.0.0.1:17331/health');
  assert.equal(result.desktop_connected, false);
  assert.equal(result.restart_required, true);
  const updated = JSON.parse(await readFile(configFile, 'utf8'));
  assert.equal(updated.port, 17331);
  for (const field of ['control_token', 'previous_user_relay']) assert.equal(updated[field], JSON.parse(before)[field]);
  assert.equal((await f.state()).shutdowns, 1);
  assert.equal((await f.state()).relay, 'ws://127.0.0.1:17331/ws');
});

test('显式指定新端口也先验证旧配置端口，非法值不发请求或改配置', { skip: process.platform !== 'win32' }, async (t) => {
  for (const port of ['17329@example.invalid', 0, 65536, 17329.5]) {
    const f = await fixture(t);
    await f.run('Install');
    const configFile = join(f.dataDir, 'config.json');
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    config.port = port;
    const before = JSON.stringify(config);
    await writeFile(configFile, before);
    const state = await f.state();
    await assert.rejects(f.run('Restart', { port: 17331 }), /Installed gateway port must be an integer from 1 to 65535/);
    assert.equal((await f.state()).http_attempts, state.http_attempts);
    assert.equal((await f.state()).shutdowns, 0);
    assert.equal((await f.state()).relay, state.relay);
    assert.equal(await readFile(configFile, 'utf8'), before);
  }
});

test('健康响应需要超过一秒时仍可确认运行，偶发超时只重试一次', { skip: process.platform !== 'win32' }, async (t) => {
  const f = await fixture(t);
  await f.run('Install');
  const state = await f.state();
  state.desktop = true;
  state.health_min_timeout = 3;
  state.timeouts_left = 1;
  const before = state.health_requests;
  await writeFile(f.stateFile, JSON.stringify(state));
  const result = await f.run('Status');
  assert.equal(result.gateway_running, true);
  assert.equal(result.desktop_connected, true);
  assert.equal((await f.state()).health_requests - before, 2);
});

test('持续健康超时报未知状态且不改配置，允许明确指定检查时长', { skip: process.platform !== 'win32' }, async (t) => {
  const f = await fixture(t);
  await f.run('Install');
  const beforeConfig = await readFile(join(f.dataDir, 'config.json'), 'utf8');
  const state = await f.state();
  state.health_min_timeout = 7;
  const before = state.health_requests;
  await writeFile(f.stateFile, JSON.stringify(state));
  await assert.rejects(f.run('Status'), /running state is unknown/);
  assert.equal((await f.state()).health_requests - before, 2);
  assert.equal(await readFile(join(f.dataDir, 'config.json'), 'utf8'), beforeConfig);
  assert.equal((await f.state()).task.State, 'Running');
  assert.equal((await f.run('Status', { healthTimeoutSec: 8 })).gateway_running, true);
});

test('旧 PowerShell 启动任务在活跃连接时只报告待升级，安全重载后切换 VBS', { skip: process.platform !== 'win32' }, async (t) => {
  const f = await fixture(t);
  await f.run('Install');
  let state = await f.state();
  state.task.Actions.Execute = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  state.desktop = true;
  await writeFile(f.stateFile, JSON.stringify(state));
  const status = await f.run('Status');
  assert.equal(status.gateway_running, true);
  assert.equal(status.launcher_update_required, true);
  assert.equal(status.restart_required, true);
  const installed = await f.run('Install');
  assert.equal(installed.launcher_update_required, true);
  assert.equal((await f.state()).registrations, 1);
  await assert.rejects(f.run('Restart'), /Stop mobile remote control in ZCode.*keep ZCode open/);
  state = await f.state();
  state.desktop = false;
  await writeFile(f.stateFile, JSON.stringify(state));
  const restarted = await f.run('Restart');
  assert.equal(restarted.vbs_launcher, true);
  const updated = await f.run('Status');
  assert.equal(updated.vbs_launcher, true);
  assert.equal(updated.launcher_update_required, false);
});

test('任务已结束但网关仍存活时状态以健康为准，活跃 Desktop 阻止移除与重载', { skip: process.platform !== 'win32' }, async (t) => {
  const f = await fixture(t);
  await f.run('Install');
  let state = await f.state();
  state.task.State = 'Ready';
  state.desktop = true;
  await writeFile(f.stateFile, JSON.stringify(state));
  const status = await f.run('Status');
  assert.equal(status.gateway_running, true);
  assert.equal(status.task_running, false);
  assert.equal(status.desktop_connected, true);
  assert.equal(status.health_status, 'reachable');
  assert.equal(status.restart_required, true);
  const reused = await f.run('Install');
  assert.equal(reused.gateway_running, true);
  assert.equal(reused.task_running, false);
  assert.equal(reused.launcher_update_required, true);
  assert.equal((await f.state()).registrations, 1);
  const before = await readFile(join(f.dataDir, 'config.json'), 'utf8');
  await assert.rejects(f.run('Remove'), /quit ZCode/);
  await assert.rejects(f.run('Restart'), /Stop mobile remote control in ZCode.*keep ZCode open/);
  assert.equal(await readFile(join(f.dataDir, 'config.json'), 'utf8'), before);
  assert.equal((await f.state()).shutdowns, 0);
  state = await f.state();
  state.desktop = false;
  state.shutdown_health_reads = 2;
  const beforeRestart = state.health_requests;
  await writeFile(f.stateFile, JSON.stringify(state));
  assert.equal((await f.run('Restart')).vbs_launcher, true);
  assert.equal((await f.state()).shutdowns, 1);
  assert.equal((await f.state()).task.State, 'Running');
  assert.equal((await f.state()).health_requests - beforeRestart, 4);
  assert.equal((await f.state()).shutdown_health_reads, 0);
});

test('健康端点不可达与任务状态分别报告，配置保留以供安全重新启动', { skip: process.platform !== 'win32' }, async (t) => {
  const f = await fixture(t);
  await f.run('Install');
  const state = await f.state();
  state.task.State = 'Ready';
  state.health_available = false;
  await writeFile(f.stateFile, JSON.stringify(state));
  const status = await f.run('Status');
  assert.equal(status.gateway_running, false);
  assert.equal(status.task_running, false);
  assert.equal(status.health_status, 'unreachable');
  state.task.State = 'Running';
  await writeFile(f.stateFile, JSON.stringify(state));
  const before = await readFile(join(f.dataDir, 'config.json'), 'utf8');
  await assert.rejects(f.run('Restart'), /running state is unknown/);
  await assert.rejects(f.run('Remove'), /running state is unknown/);
  assert.equal(await readFile(join(f.dataDir, 'config.json'), 'utf8'), before);
  state.task.State = 'Ready';
  await writeFile(f.stateFile, JSON.stringify(state));
  assert.equal((await f.run('Restart')).gateway_running, true);
});

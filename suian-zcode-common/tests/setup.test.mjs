import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import WebSocket, { WebSocketServer } from 'ws';
import { gatewayBuild } from '../gateway-build.mjs';
import { computeGatewayBuildId } from '../gateway-deploy.mjs';

const setup = fileURLToPath(new URL('../setup.ps1', import.meta.url));
const gatewayRoot = dirname(setup);
const deployBuildId = await computeGatewayBuildId(gatewayRoot);
const nativeExec = promisify(execFile);

// 只替换 Windows 系统边界，真实执行 setup.ps1 与临时目录内的文件读写。
const systemFixture = String.raw`
param([string]$Script, [string]$Action, [string]$DataDir, [string]$SkillsDir, [string]$ToolsRoot, [string]$StateFile, [int]$HealthTimeoutSec, [int]$Port, [string]$Mode, [int]$RelayProtocolVersion, [string]$ZcodeAppVersion, [string]$UpstreamUrl, [int]$BusyTimeoutSec, [int]$BusyRetryMs, [string]$ZcodeInstallDir, [string]$LocalOnlyWorkspace, [string]$LocalOnlyDataRoot, [int]$KeepaliveIntervalMin, [switch]$NativePlugin)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$global:fixture = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
$env:ZCODE_APP_VERSION = $global:fixture.app_version_env
function Save-Fixture { [IO.File]::WriteAllText($StateFile, ($global:fixture | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding($false))) }
function Add-Type {
    param([string]$TypeDefinition)
    $global:fixture.broadcast_declaration=$TypeDefinition; Save-Fixture
    Microsoft.PowerShell.Utility\Add-Type -TypeDefinition @'
using System;
namespace SuianZcodeGateway {
    public static class EnvironmentBroadcast {
        public static Action OnSend;
        public static bool Fail;
        public static IntPtr Window;
        public static uint Message, Flags, Timeout;
        public static UIntPtr WParam;
        public static string Area;
        public static IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wparam, string area, uint flags, uint timeout, out UIntPtr result) {
            Window=window; Message=message; WParam=wparam; Area=area; Flags=flags; Timeout=timeout;
            OnSend(); result=UIntPtr.Zero;
            return Fail ? IntPtr.Zero : new IntPtr(1);
        }
    }
}
'@
    [SuianZcodeGateway.EnvironmentBroadcast]::Fail=$global:fixture.broadcast_fail
    [SuianZcodeGateway.EnvironmentBroadcast]::OnSend=[Action]{
        $global:fixture.broadcasts += [pscustomobject]@{
            window=[SuianZcodeGateway.EnvironmentBroadcast]::Window.ToInt64(); message=[SuianZcodeGateway.EnvironmentBroadcast]::Message
            wparam=[SuianZcodeGateway.EnvironmentBroadcast]::WParam.ToUInt64(); area=[SuianZcodeGateway.EnvironmentBroadcast]::Area
            flags=[SuianZcodeGateway.EnvironmentBroadcast]::Flags; timeout=[SuianZcodeGateway.EnvironmentBroadcast]::Timeout; registry_relay=$global:fixture.relay
        }
        Save-Fixture
    }
}
function Get-ItemProperty { param([string]$LiteralPath) if ($LiteralPath -ne 'HKCU:\Environment') { throw '禁止访问其他注册表路径' }; if ($null -eq $global:fixture.relay) { return [pscustomobject]@{} }; return [pscustomobject]@{ ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL = $global:fixture.relay } }
function New-ItemProperty { param([string]$LiteralPath, [string]$Name, [string]$Value, [string]$PropertyType, [switch]$Force) if ($LiteralPath -ne 'HKCU:\Environment' -or $Name -ne 'ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL') { throw '修改了非目标变量' }; $global:fixture.relay = $Value; Save-Fixture }
function Remove-ItemProperty { param([string]$LiteralPath, [string]$Name) if ($LiteralPath -ne 'HKCU:\Environment' -or $Name -ne 'ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL') { throw '删除了非目标变量' }; $global:fixture.relay = $null; Save-Fixture }
function Get-ScheduledTask { if ($null -ne $global:fixture.task) { return $global:fixture.task } }
# LO-04：补丁工具桩。patch_stub 决定 status/prepare 回执；对 apply/restore 一律失败——
# setup 的任何 Action 都不得直接执行应用或还原（票面：准备成功不宣称已应用）。
function Invoke-PatchCli {
    param([string[]]$CliArguments)
    $cmd = $CliArguments[0]
    $stub = [string]$global:fixture.patch_stub
    $outDir = $null
    for ($i = 0; $i -lt $CliArguments.Count - 1; $i++) { if ($CliArguments[$i] -eq '--out') { $outDir = $CliArguments[$i + 1] } }
    $global:fixture.patch_calls += ,@($CliArguments); Save-Fixture
    if ($cmd -eq 'status') {
        switch ($stub) {
            'unsupported' { return [pscustomobject]@{ ok=$true; exitCode=0; supported=$false; patchState='unknown'; package=[pscustomobject]@{exeFileVersion='3.17.0'; appAsarSha256='3.17.0-digest'; appAsarBytes=1}; mismatches=@('exe 版本不符：实际 3.17.0，期望 3.16.2.8769'); backup=[pscustomobject]@{exists=$false; sha256=$null; matchesOriginal=$false} } }
            'digest' { return [pscustomobject]@{ ok=$true; exitCode=0; supported=$false; patchState='conflict'; package=[pscustomobject]@{exeFileVersion='3.16.2.8769'; appAsarSha256='foreign-digest'; appAsarBytes=1}; mismatches=@('app.asar 摘要不属于已登记原版或补丁版：foreign-digest'); backup=[pscustomobject]@{exists=$false; sha256=$null; matchesOriginal=$false} } }
            'resolve_fail' { return [pscustomobject]@{ ok=$false; exitCode=10; code='unsupported_package'; reason='目标身份解析失败：目标目录缺少必需文件' } }
            'patched' { return [pscustomobject]@{ ok=$true; exitCode=0; supported=$true; patchState='patched'; patchInfo=[pscustomobject]@{patchVersion=2}; package=[pscustomobject]@{exeFileVersion='3.16.2.8769'; appAsarSha256='patched-digest'; appAsarBytes=1}; backup=[pscustomobject]@{exists=$true; sha256='original-digest'; matchesOriginal=$true} } }
            'upgrade' { return [pscustomobject]@{ ok=$true; exitCode=0; supported=$true; patchState='patched'; patchInfo=[pscustomobject]@{patchVersion=1; upgradeAvailable=2}; package=[pscustomobject]@{exeFileVersion='3.16.2.8769'; appAsarSha256='v1-digest'; appAsarBytes=1}; backup=[pscustomobject]@{exists=$true; sha256='original-digest'; matchesOriginal=$true} } }
            default { return [pscustomobject]@{ ok=$true; exitCode=0; supported=$true; patchState='original'; package=[pscustomobject]@{exeFileVersion='3.16.2.8769'; appAsarSha256='1f96-original'; appAsarBytes=341334118}; backup=[pscustomobject]@{exists=$false; sha256=$null; matchesOriginal=$false} } }
        }
    }
    if ($cmd -eq 'prepare') {
        if ($stub -eq 'prepare_fail') { return [pscustomobject]@{ ok=$false; exitCode=16; code='anchor_mismatch'; reason='锚点 P1-mode-gate 未命中（结构变化，需人工分析）' } }
        return [pscustomobject]@{ ok=$true; exitCode=0; outDir=$outDir; candidateAsarPath=(Join-Path $outDir 'app.asar'); candidateMetaPath=(Join-Path $outDir 'candidate.json'); candidate=[pscustomobject]@{ patchVersion=2; patched=[pscustomobject]@{appAsarSha256='cb54-patched-digest'}; injections=@('P0-fs-import','P1-mode-gate') } }
    }
    throw ('fixture: setup 不得直接调用补丁工具的 ' + $cmd)
}
function New-ScheduledTaskAction { [CmdletBinding()] param([string]$Execute, [string]$Argument, [string]$WorkingDirectory) return [pscustomobject]@{ Execute=$Execute; Arguments=$Argument; WorkingDirectory=$WorkingDirectory } }
function New-ScheduledTaskTrigger { [CmdletBinding()] param([switch]$AtLogOn, [string]$User, [switch]$Once, [datetime]$At, [TimeSpan]$RepetitionInterval, [TimeSpan]$RepetitionDuration) if ($Once) { return [pscustomobject]@{ Once=$true; At=$At; RepetitionIntervalMinutes=[Math]::Round($RepetitionInterval.TotalMinutes); RepetitionDurationDays=[Math]::Round($RepetitionDuration.TotalDays) } }; return [pscustomobject]@{ AtLogOn=[bool]$AtLogOn; User=$User } }
function New-ScheduledTaskPrincipal { [CmdletBinding()] param([string]$UserId, [string]$LogonType, [string]$RunLevel) return [pscustomobject]@{ UserId=$UserId; LogonType=$LogonType; RunLevel=$RunLevel } }
function New-ScheduledTaskSettingsSet { [CmdletBinding()] param([TimeSpan]$ExecutionTimeLimit, [int]$RestartCount, [TimeSpan]$RestartInterval, [string]$MultipleInstances, [switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries) return [pscustomobject]@{ ExecutionTimeLimit=$ExecutionTimeLimit.TotalSeconds; RestartCount=$RestartCount; MultipleInstances=$MultipleInstances } }
function Register-ScheduledTask { [CmdletBinding()] param([string]$TaskName, $Action, $Trigger, $Principal, $Settings, [switch]$Force) if ($global:fixture.fail_register_count -gt 0) { $global:fixture.fail_register_count--; Save-Fixture; throw 'fixture: register denied' }; $nextState = if ($null -ne $global:fixture.task -and $global:fixture.task.State -eq 'Running') { 'Running' } else { 'Ready' }; $global:fixture.task = [pscustomobject]@{ TaskName=$TaskName; TaskPath='\'; Actions=$Action; Trigger=(@($Trigger)[0]); Triggers=@($Trigger); Principal=$Principal; Settings=$Settings; State=$nextState }; $global:fixture.registrations++; Save-Fixture }
function Start-ScheduledTask { [CmdletBinding()] param([string]$TaskName) if ($global:fixture.fail_start_count -gt 0) { $global:fixture.fail_start_count--; Save-Fixture; throw 'fixture: start denied' }; if ($TaskName -ne $global:fixture.task.TaskName) { throw '启动了其他任务' }; $global:fixture.task.State='Running'; $global:fixture.health_available=$true; $global:fixture.starts++; Save-Fixture }
function Stop-ScheduledTask { throw 'Gateway already accepted self shutdown; do not terminate its exiting launcher' }
function Unregister-ScheduledTask { [CmdletBinding()] param([string]$TaskName, [bool]$Confirm) if ($TaskName -ne $global:fixture.task.TaskName -or $Confirm) { throw '删除了其他任务' }; if ($global:fixture.unregister_fail) { throw 'fixture: task cleanup failed' }; $global:fixture.task=$null; Save-Fixture }
function Invoke-RestMethod {
    param([string]$Uri, [int]$TimeoutSec, [switch]$UseBasicParsing, [string]$Method, $Headers)
    $global:fixture.http_attempts++; Save-Fixture
    if ($global:fixture.health -eq 'failure') { throw 'fixture: 网关启动失败' }
    if ($null -ne $global:fixture.reject_build -and $null -ne $global:fixture.build -and $global:fixture.build.PSObject.Properties['id'] -and $global:fixture.build.id -eq $global:fixture.reject_build) { throw [Net.WebException]::new('fixture: rejected candidate', [Net.WebExceptionStatus]::ConnectFailure) }
    $config = Get-Content -LiteralPath (Join-Path $DataDir 'config.json') -Raw | ConvertFrom-Json
    if (([Uri]$Uri).Port -ne $config.port) { throw [Net.WebException]::new('fixture: wrong health port', [Net.WebExceptionStatus]::ConnectFailure) }
    if ($global:fixture.real_health) { return Microsoft.PowerShell.Utility\Invoke-RestMethod @PSBoundParameters }
    if ($Method -eq 'Post') {
        if ($Headers.Authorization -ne ('Bearer ' + $config.control_token)) { throw '控制令牌错误' }
        # 升级关闭（idle）：模拟忙拒绝（rpc_in_flight>0 或可数的人为拒绝），由 setup 侧回到退避循环。
        $isIdle = ([Uri]$Uri).Query -like '*idle=*'
        if ($isIdle -and $global:fixture.desktop -and (($null -ne $global:fixture.rpc_in_flight -and [int]$global:fixture.rpc_in_flight -gt 0) -or $global:fixture.idle_shutdown_rejects -gt 0)) {
            if ($global:fixture.idle_shutdown_rejects -gt 0) { $global:fixture.idle_shutdown_rejects-- }
            Save-Fixture
            throw [Net.WebException]::new('fixture: upgrade shutdown busy', [Net.WebExceptionStatus]::ProtocolError)
        }
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
    $protocol = if ($config.PSObject.Properties['relay_protocol_version']) { $config.relay_protocol_version } else { 1 }
    if ($null -ne $global:fixture.health_protocol) { $protocol = $global:fixture.health_protocol }
    # busy_reads_left：剩余忙读取次数——大于 0 时强制 desktop_connected=true 且 rpc_in_flight 递减，耗尽后回落 state.desktop 与 state.rpc_in_flight。
    $connected = $global:fixture.desktop
    $inFlight = $global:fixture.rpc_in_flight
    if ($global:fixture.busy_reads_left -gt 0) { $connected = $true; $inFlight = [Math]::Max(1, $global:fixture.busy_reads_left); $global:fixture.busy_reads_left--; Save-Fixture }
    $reply = [pscustomobject]@{ service='suian-zcode-gateway'; version=1; instance_id=$id; upstream_url=$config.upstream_url; mode=$mode; desktop_connected=$connected; desktop_ready=$connected; upstream_connected=$false; paired=$false; rpc_protocol_version=1; upstream_paired=$false; local_clients=0 }
    if ($null -ne $inFlight) { Add-Member -InputObject $reply -NotePropertyName rpc_in_flight -NotePropertyValue ([int]$inFlight) }
    if ($null -ne $global:fixture.build) {
        $b = $global:fixture.build
        if ($b -is [string]) { $b = @{ id=$b }.psobject } elseif ($b.PSObject.Properties['root'] -and $null -ne $b.root) { } else { $b = [pscustomobject]@{ id=$b.id; version=$b.version; root=(Join-Path $ToolsRoot ('deployments\' + $b.id)) } }
        Add-Member -InputObject $reply -NotePropertyName build -NotePropertyValue $b
    }
    Add-Member -InputObject $reply -NotePropertyName relay_protocol_version -NotePropertyValue $protocol
    if ($global:fixture.legacy_health) { $reply.PSObject.Properties.Remove('mode'); $reply.PSObject.Properties.Remove('desktop_ready'); $reply.PSObject.Properties.Remove('relay_protocol_version') }
    return $reply
}
$params = @{ Action=$Action; DataDir=$DataDir; SkillsDir=$SkillsDir; ToolsRoot=$ToolsRoot }
if ($PSBoundParameters.ContainsKey('HealthTimeoutSec')) { $params.HealthTimeoutSec=$HealthTimeoutSec }
if ($PSBoundParameters.ContainsKey('Port')) { $params.Port=$Port }
if ($PSBoundParameters.ContainsKey('Mode')) { $params.Mode=$Mode }
if ($PSBoundParameters.ContainsKey('RelayProtocolVersion')) { $params.RelayProtocolVersion=$RelayProtocolVersion }
if ($PSBoundParameters.ContainsKey('ZcodeAppVersion')) { $params.ZcodeAppVersion=$ZcodeAppVersion }
if ($PSBoundParameters.ContainsKey('UpstreamUrl')) { $params.UpstreamUrl=$UpstreamUrl }
if ($PSBoundParameters.ContainsKey('BusyTimeoutSec')) { $params.BusyTimeoutSec=$BusyTimeoutSec }
if ($PSBoundParameters.ContainsKey('BusyRetryMs')) { $params.BusyRetryMs=$BusyRetryMs }
if ($PSBoundParameters.ContainsKey('ZcodeInstallDir')) { $params.ZcodeInstallDir=$ZcodeInstallDir }
if ($PSBoundParameters.ContainsKey('LocalOnlyWorkspace')) { $params.LocalOnlyWorkspace=$LocalOnlyWorkspace }
if ($PSBoundParameters.ContainsKey('LocalOnlyDataRoot')) { $params.LocalOnlyDataRoot=$LocalOnlyDataRoot }
if ($PSBoundParameters.ContainsKey('KeepaliveIntervalMin')) { $params.KeepaliveIntervalMin=$KeepaliveIntervalMin }
if ($NativePlugin) { $params.NativePlugin=$true }
& $Script @params
`;

async function fixture(t, overrides = {}, { setupScript = setup } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'zcode-gateway-'));
  t.after(() => rm(root, { recursive: true }));
  const stateFile = join(root, 'system.json');
  const script = join(root, 'Windows 边界 fixture.ps1');
  const dataDir = join(root, '公共 data');
  const skillsDir = join(root, 'skills');
  const toolsRoot = join(root, '稳定 网关 tools');
  const initial = { relay: 'wss://previous.example/ws', app_version_env: null, task: null, registrations: 0, starts: 0, shutdowns: 0, health: 'ready', health_protocol: null, real_health: false, build: { id: deployBuildId, version: gatewayBuild.version }, reject_build: null, desktop: false, rpc_in_flight: null, busy_reads_left: 0, idle_shutdown_rejects: 0, legacy_health: false, health_min_timeout: 0, timeouts_left: 0, health_requests: 0, http_attempts: 0, health_available: false, draining: false, shutdown_health_reads: 0, broadcasts: [], broadcast_fail: false, broadcast_declaration: null, unregister_fail: false, fail_start_count: 0, fail_register_count: 0, patch_stub: 'original', patch_calls: [], ...overrides };
  await writeFile(stateFile, JSON.stringify(initial));
  await writeFile(script, '\uFEFF' + systemFixture);
  const run = async (action, { healthTimeoutSec, port, mode, nativePlugin, relayProtocolVersion, zcodeAppVersion, upstreamUrl, busyTimeoutSec, busyRetryMs, zcodeInstallDir, localOnlyWorkspace, localOnlyDataRoot, keepaliveIntervalMin, setupScript: scriptOverride } = {}) => {
    const { stdout } = await nativeExec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Script', scriptOverride ?? setupScript, '-Action', action, '-DataDir', dataDir, '-SkillsDir', skillsDir, '-ToolsRoot', toolsRoot, '-StateFile', stateFile, ...(healthTimeoutSec === undefined ? [] : ['-HealthTimeoutSec', String(healthTimeoutSec)]), ...(port === undefined ? [] : ['-Port', String(port)]), ...(mode === undefined ? [] : ['-Mode', mode]), ...(relayProtocolVersion === undefined ? [] : ['-RelayProtocolVersion', String(relayProtocolVersion)]), ...(zcodeAppVersion === undefined ? [] : ['-ZcodeAppVersion', zcodeAppVersion]), ...(upstreamUrl === undefined ? [] : ['-UpstreamUrl', upstreamUrl]), ...(busyTimeoutSec === undefined ? [] : ['-BusyTimeoutSec', String(busyTimeoutSec)]), ...(busyRetryMs === undefined ? [] : ['-BusyRetryMs', String(busyRetryMs)]), ...(zcodeInstallDir === undefined ? [] : ['-ZcodeInstallDir', zcodeInstallDir]), ...(localOnlyWorkspace === undefined ? [] : ['-LocalOnlyWorkspace', localOnlyWorkspace]), ...(localOnlyDataRoot === undefined ? [] : ['-LocalOnlyDataRoot', localOnlyDataRoot]), ...(keepaliveIntervalMin === undefined ? [] : ['-KeepaliveIntervalMin', String(keepaliveIntervalMin)]), ...(nativePlugin ? ['-NativePlugin'] : [])], { windowsHide: true });
    return JSON.parse(stdout.trim());
  };
  const state = async () => JSON.parse(await readFile(stateFile, 'utf8'));
  return { root, stateFile, dataDir, skillsDir, toolsRoot, setupScript, run, state };
}

test('启动或注册任务异常进入回退，首次撤销安装，升级恢复原端口与运行任务', { skip: process.platform !== 'win32' }, async t => {
  for(const failed of ['fail_start_count','fail_register_count']) {
    const fresh=await fixture(t,{[failed]:1});
    await assert.rejects(fresh.run('Install'),/rolled back/);
    assert.equal((await fresh.state()).task,null);
    await assert.rejects(stat(join(fresh.dataDir,'config.json')),{code:'ENOENT'});
  }
  const f=await fixture(t,{fail_start_count:0});
  await f.run('Install');
  const config=await readFile(join(f.dataDir,'config.json'),'utf8');
  const active=await readFile(join(f.toolsRoot,'active-gateway.json'),'utf8');
  const state=await f.state();state.fail_start_count=1;
  await writeFile(f.stateFile,JSON.stringify(state));
  await assert.rejects(f.run('Restart',{port:17331}),error=>{
    assert.match(error.stderr,/start denied.*fallback: restored/s);
    assert.doesNotMatch(error.stderr,/fallback also failed/);return true;
  });
  assert.equal(await readFile(join(f.dataDir,'config.json'),'utf8'),config);
  assert.equal(await readFile(join(f.toolsRoot,'active-gateway.json'),'utf8'),active);
  const restored=await f.state();
  assert.equal(restored.task.Triggers.length,2,'fallback 恢复的任务保持双触发器形状');
  assert.equal((await f.state()).task.State,'Running');
});

test('3.16 首次安装按宿主应用版本自动选择 V2 和新版官方地址', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t, { app_version_env: '3.16.1' });
  const result = await f.run('Install');
  const config = JSON.parse(await readFile(join(f.dataDir, 'config.json'), 'utf8'));
  assert.equal(config.relay_protocol_version, 2);
  assert.equal(config.upstream_url, 'wss://zcode.z.ai/api/v1/remote/ws2');
  assert.equal(result.relay_protocol_version, 2);
  assert.equal(result.running_relay_protocol_version, 2);
  assert.equal(result.protocol_update_required, false);
});

test('3.16 外部安装按应用版本自动配置；Restart 无版本信息时保留 V2 和用户配置', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), configFile = join(f.dataDir, 'config.json');
  const installed = await f.run('Install', { zcodeAppVersion: '3.16.1.8093', upstreamUrl: 'wss://relay.fixture.test/custom', nativePlugin: true });
  assert.equal(installed.protocol_source, 'desktop_version');
  const before = JSON.parse(await readFile(configFile, 'utf8'));
  const restarted = await f.run('Restart', { nativePlugin: true });
  const after = JSON.parse(await readFile(configFile, 'utf8'));
  assert.equal(after.relay_protocol_version, 2);
  assert.deepEqual(after, before, '未指定变更时保留全部已知配置');
  assert.equal(restarted.relay_protocol_version, 2);
  assert.equal(restarted.protocol_source, 'installed_config');
  assert.equal(restarted.protocol_update_required, false);
});

test('升级 3.16 时 Status 报协议待更新，暂停远控后 Restart 迁移旧官方地址并保留备份和令牌', { skip: process.platform !== 'win32' }, async t => {
  for (const previousUpstream of ['wss://zcode.z.ai/ws', 'wss://zcode.chatglm.site/ws']) {
    const f = await fixture(t, { app_version_env: '3.15.1' }), configFile = join(f.dataDir, 'config.json');
    await f.run('Install');
    const old = JSON.parse(await readFile(configFile, 'utf8'));
    delete old.relay_protocol_version; old.upstream_url = previousUpstream;
    await writeFile(configFile, JSON.stringify(old));
    const oldBytes = await readFile(configFile, 'utf8');
    const state = await f.state(); state.app_version_env = '3.16.1'; state.desktop = true;
    await writeFile(f.stateFile, JSON.stringify(state));
    const pending = await f.run('Status');
    assert.equal(pending.code_status, 'current');
    assert.equal(pending.relay_protocol_version, 2);
    assert.equal(pending.running_relay_protocol_version, 1);
    assert.equal(pending.protocol_update_required, true);
    assert.equal(pending.upstream_update_required, true);
    assert.equal(pending.gateway_restart_required, true);
    assert.equal(await readFile(configFile, 'utf8'), oldBytes);
    await assert.rejects(f.run('Install'), /use Restart/);
    const deferredUpgrade = await f.run('Restart', { busyTimeoutSec: 1, busyRetryMs: 50 });
    assert.equal(deferredUpgrade.action, 'restart_deferred');
    assert.equal(deferredUpgrade.upgrade_deferred, 'remote_busy');
    assert.equal(await readFile(configFile, 'utf8'), oldBytes);
    assert.equal((await f.state()).shutdowns, 0);
    state.desktop = false; await writeFile(f.stateFile, JSON.stringify(state));
    const restarted = await f.run('Restart');
    const updated = JSON.parse(await readFile(configFile, 'utf8'));
    assert.equal(updated.relay_protocol_version, 2);
    assert.equal(updated.upstream_url, 'wss://zcode.z.ai/api/v1/remote/ws2');
    for (const key of ['port', 'mode', 'control_token', 'previous_user_relay']) assert.equal(updated[key], old[key]);
    assert.equal(restarted.protocol_update_required, false);
    assert.equal(restarted.upstream_update_required, false);
  }
});

test('旧版按 V1 安装；显式版本覆盖宿主变量，回退旧版时同步官方地址', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t, { app_version_env: '3.16.1' }), configFile = join(f.dataDir, 'config.json');
  const old = await f.run('Install', { zcodeAppVersion: '3.15.1' });
  assert.equal(old.relay_protocol_version, 1);
  assert.equal(old.upstream_url, 'wss://zcode.z.ai/ws');
  await f.run('Restart');
  assert.equal(JSON.parse(await readFile(configFile, 'utf8')).relay_protocol_version, 2);
  const downgraded = await f.run('Restart', { zcodeAppVersion: '3.15.1' });
  assert.equal(downgraded.relay_protocol_version, 1);
  assert.equal(downgraded.upstream_url, 'wss://zcode.z.ai/ws');
});

test('协议、版本或旧官方地址冲突，以及 3.16 local-only 缺安装目录，均在写配置与停网关前拒绝', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  for (const [options, error] of [
    [{ zcodeAppVersion: '0.16.9' }, /actual ZCode Desktop application version/],
    [{ zcodeAppVersion: 'unknown' }, /actual ZCode Desktop application version/],
    [{ zcodeAppVersion: '3.16.1', relayProtocolVersion: 1 }, /conflicts/],
    [{ zcodeAppVersion: '3.15.1', relayProtocolVersion: 2 }, /conflicts/],
    [{ zcodeAppVersion: '3.16.1', mode: 'local-only' }, /requires -ZcodeInstallDir/],
    [{ relayProtocolVersion: 2, upstreamUrl: 'wss://zcode.z.ai/ws' }, /does not match/],
    [{ relayProtocolVersion: 1, upstreamUrl: 'wss://zcode.z.ai/api/v1/remote/ws2' }, /does not match/],
  ]) {
    await assert.rejects(f.run('Install', options), error);
    await assert.rejects(stat(join(f.dataDir, 'config.json')), { code: 'ENOENT' });
    const state = await f.state();
    assert.equal(state.registrations + state.starts + state.shutdowns + state.broadcasts.length, 0);
  }
  assert.deepEqual((await f.state()).patch_calls, [], '缺安装目录时不调补丁工具');
});

test('实际 health 协议不符会报告重载，首次启动协议未生效时不写 Desktop 环境', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t, { desktop: true });
  await f.run('Install', { relayProtocolVersion: 2 });
  const state = await f.state(); state.health_protocol = 1;
  await writeFile(f.stateFile, JSON.stringify(state));
  const status = await f.run('Status');
  assert.equal(status.relay_protocol_version, 2);
  assert.equal(status.running_relay_protocol_version, 1);
  assert.equal(status.protocol_update_required, true);
  assert.equal(status.gateway_restart_required, true);
  const wrong = await fixture(t, { app_version_env: '3.16.1', health_protocol: 1 });
  await assert.rejects(wrong.run('Install'), /different instance or relay protocol/);
  assert.equal((await wrong.state()).relay, 'wss://previous.example/ws');
  assert.equal((await wrong.state()).broadcasts.length, 0);
});

test('安装部署的运行文件可直接启动真实 Node CLI，Status 读取真实健康接口确认版本与代码', { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
  const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(relay, 'listening');
  t.after(() => { for (const socket of relay.clients) socket.terminate(); relay.close(); });
  for (const [appVersion, protocol] of [['3.15.1', 1], ['3.16.1', 2]]) {
    const portProbe = createServer(); portProbe.listen(0, '127.0.0.1'); await once(portProbe, 'listening');
    const port = portProbe.address().port;
    await new Promise(resolve => portProbe.close(resolve));
    const f = await fixture(t, { app_version_env: appVersion });
    await f.run('Install', { port, upstreamUrl: `ws://127.0.0.1:${relay.address().port}/ws` });
    const deployedGateway = join(f.toolsRoot, 'deployments', deployBuildId, 'gateway.mjs');
    await assert.doesNotReject(() => readFile(deployedGateway));
    const child = spawn(process.execPath, [deployedGateway, '--config', join(f.dataDir, 'config.json')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; } });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    const lines = createInterface({ input: child.stdout });
    const [line] = await Promise.race([once(lines, 'line'), exited.then(([code]) => { throw new Error(`网关提前退出 ${code}: ${stderr}`); })]);
    lines.close();
    const { relay_url, health_url } = JSON.parse(line);
    const connected = once(relay, 'connection');
    const desktop = new WebSocket(relay_url + (protocol === 2 ? '?token=fixture-token&mid=fixture-mid' : ''));
    t.after(() => desktop.terminate());
    await once(desktop, 'open');
    const [upstream] = await connected;
    const forwarded = once(upstream, 'message');
    desktop.send(JSON.stringify({ type: 'auth_init', device_sid: 'd_setup-fixture', client_ts: protocol === 2 ? Math.floor(Date.now() / 1000) : Date.now(), ...(protocol === 1 ? { role: 'device', pass_hash: 'fixture' } : {}) }));
    assert.equal(JSON.parse((await forwarded)[0]).type, 'auth_init');
    const authenticated = once(desktop, 'message');
    upstream.send(JSON.stringify({ type: 'auth_ack', pair_status: 'waiting', server_ts: protocol === 2 ? Math.floor(Date.now() / 1000) : Date.now() }));
    await authenticated;
    const health = await (await fetch(health_url)).json();
    assert.equal(health.relay_protocol_version, protocol);
    assert.equal(health.desktop_ready, true);
    assert.equal(health.build.id, deployBuildId);
    const state = await f.state(); state.real_health = true;
    await writeFile(f.stateFile, JSON.stringify(state));
    const status = await f.run('Status');
    assert.equal(status.code_status, 'current');
    assert.equal(status.running_relay_protocol_version, protocol);
    assert.equal(status.protocol_update_required, false);
    assert.equal(status.gateway_restart_required, false);
    assert.equal(status.restart_required, false);
    assert.equal(stderr, '');
    const closed = once(desktop, 'close'); desktop.close(); await closed;
    const config = JSON.parse(await readFile(join(f.dataDir, 'config.json'), 'utf8'));
    const stopped = await fetch(health_url.replace('/health', '/shutdown'), { method: 'POST', headers: { Authorization: 'Bearer ' + config.control_token } });
    assert.equal(stopped.status, 200);
    assert.equal((await exited)[0], 0);
  }
});

test('Status 识别已连接网关加载的旧代码，并区分网关重载与 Desktop 重开', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t, { desktop: true });
  await f.run('Install');
  const current = await f.run('Status');
  assert.equal(current.code_status, 'current');
  assert.equal(current.gateway_restart_required, false);
  assert.equal(current.desktop_restart_required, false);
  assert.equal(current.restart_required, false);
  const state = await f.state();
  state.build.id = '0'.repeat(64);
  await writeFile(f.stateFile, JSON.stringify(state));
  const outdated = await f.run('Status');
  assert.equal(outdated.code_status, 'changed');
  assert.equal(outdated.gateway_restart_required, true);
  assert.equal(outdated.desktop_restart_required, false);
  assert.equal(outdated.restart_required, true);
  assert.equal(outdated.running_build.id, state.build.id);
  assert.equal(outdated.expected_build.id, deployBuildId);
});

test('Status 检查启动任务的实际脚本参数，wscript 正在运行仍不能代替参数核对', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t, { desktop: true });
  await f.run('Install');
  const state = await f.state();
  // 旧安装的任务参数形态：把启动器编码进 EncodedCommand 的旧缓存路径。
  state.task.Actions.Arguments = '//B //NoLogo "' + join(f.dataDir, 'gateway-launch.vbs') + '" ' + Buffer.from("& 'D:\\旧缓存\\run.ps1' -NodePath 'C:\\node.exe' -DataDir '" + f.dataDir.replaceAll("'", "''") + "'", 'utf16le').toString('base64');
  await writeFile(f.stateFile, JSON.stringify(state));
  const status = await f.run('Status');
  assert.equal(status.code_status, 'current');
  assert.equal(status.vbs_launcher, true);
  assert.equal(status.launcher_update_required, true);
  assert.equal(status.gateway_restart_required, true);
  assert.equal(status.desktop_restart_required, false);
  assert.equal(status.restart_required, true);
});

test('Status 不把旧 health 当作最新代码，也不把远控未连接直接等同 Desktop 必须重开', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t, { desktop: true });
  await f.run('Install');
  // 旧版本网关没有指纹：健康缺 build 时报告 unknown，不当作最新代码。
  const state = await f.state(); state.build = null;
  await writeFile(f.stateFile, JSON.stringify(state));
  const installed = await f.run('Status');
  assert.equal(installed.code_status, 'unknown');
  assert.equal(installed.gateway_restart_required, true);
  const unknown = await f.run('Status');
  assert.equal(unknown.running_build, null);
  assert.equal(unknown.code_status, 'unknown');
  assert.equal(unknown.gateway_restart_required, true);
  assert.equal(unknown.restart_required, true);
  state.build = { id: deployBuildId, version: gatewayBuild.version }; state.desktop = false;
  await writeFile(f.stateFile, JSON.stringify(state));
  const disconnected = await f.run('Status');
  assert.equal(disconnected.gateway_restart_required, false);
  assert.equal(disconnected.desktop_restart_required, false);
  assert.equal(disconnected.desktop_connection_required, true);
  assert.equal(disconnected.restart_required, true);
  state.build = { id: deployBuildId, version: gatewayBuild.version, root: 'D:\\old-cache' }; state.desktop = true;
  await writeFile(f.stateFile, JSON.stringify(state));
  const wrongRoot = await f.run('Status');
  assert.equal(wrongRoot.code_status, 'current');
  assert.equal(wrongRoot.gateway_path_matches, false);
  assert.equal(wrongRoot.gateway_restart_required, true);
});

test('原生公共初始化不复制全局技能，只清理归属匹配的旧技能', { skip: process.platform !== 'win32' }, async t => {
  const f=await fixture(t),skillFile=join(f.skillsDir,'suian-zcode-common','SKILL.md');
  await f.run('Install',{nativePlugin:true});
  await assert.rejects(stat(skillFile),{code:'ENOENT'});
  await mkdir(dirname(skillFile),{recursive:true});
  await writeFile(skillFile,'其他技能');
  await f.run('Install',{nativePlugin:true});
  assert.equal(await readFile(skillFile,'utf8'),'其他技能');
  await writeFile(skillFile,`**本机公共根**：\`${gatewayRoot}\``);
  await f.run('Install',{nativePlugin:true});
  await assert.rejects(stat(skillFile),{code:'ENOENT'});
});

test('公共安装部署缓存外运行文件与稳定任务，网关就绪后才设置 Desktop 用户环境', { skip: process.platform !== 'win32' }, async (t) => {
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
  assert.equal(state.task.Triggers.length, 2, '任务注册登录触发 + 周期看护双触发器');
  assert.equal(state.task.Triggers[0].AtLogOn, true);
  assert.equal(state.task.Triggers[1].RepetitionIntervalMinutes, 30, '看护触发器默认每 30 分钟重复');
  assert.equal(state.task.Triggers[1].RepetitionDurationDays, 3650, 'PS 5.1 以 10 年近似无限重复');
  assert.equal(state.task.Settings.ExecutionTimeLimit, 0);
  assert.equal(state.task.Actions.Execute, join(process.env.SystemRoot, 'System32', 'wscript.exe'));
  assert.equal(state.task.Actions.WorkingDirectory, f.dataDir, '任务工作目录是网关数据目录，不引用版本缓存');

  // 任务参数指向缓存外稳定 VBS；EncodedCommand 内只有稳定启动器与工具/数据目录，无源码缓存路径。
  const stableVbs = join(f.toolsRoot, 'launchers', 'gateway-launch.vbs');
  assert.ok(state.task.Actions.Arguments.includes('"' + stableVbs + '"'));
  const encoded = state.task.Actions.Arguments.match(/([A-Za-z0-9+/=]+)$/)[1];
  const launch = Buffer.from(encoded, 'base64').toString('utf16le');
  assert.ok(launch.includes(join(f.toolsRoot, 'launchers', 'run.ps1')), 'EncodedCommand 必须引用稳定启动器');
  assert.ok(!launch.includes(gatewayRoot), '任务参数不得编码源码缓存路径');
  assert.ok(!JSON.stringify(state.task).replaceAll('\\\\', '\\').includes(gatewayRoot), '任务整体不得引用版本缓存');

  // 部署目录是真实文件副本；活动网关记录独立落盘。
  const deploymentDir = join(f.toolsRoot, 'deployments', deployBuildId);
  await assert.doesNotReject(() => readFile(join(deploymentDir, 'gateway.mjs')), '部署目录必须包含网关入口');
  await assert.doesNotReject(() => readFile(join(deploymentDir, 'deployment.json')));
  await assert.doesNotReject(() => readFile(join(f.toolsRoot, 'launchers', 'run.ps1')));
  await assert.doesNotReject(() => readFile(join(f.toolsRoot, 'launchers', 'gateway-launch.vbs')));
  const active = JSON.parse(await readFile(join(f.toolsRoot, 'active-gateway.json'), 'utf8'));
  assert.equal(active.build_id, deployBuildId);
  assert.match(active.node_path, /node(\.exe)?$/i, '活动记录必须记录实际 Node 可执行文件');

  const config = JSON.parse((await readFile(join(f.dataDir, 'config.json'), 'utf8')).replace(/^\uFEFF/, ''));
  assert.equal(config.previous_user_relay, 'wss://previous.example/ws');
  assert.equal(config.gateway_root, deploymentDir, 'config 记录部署目录而非源码缓存');
  assert.equal(config.tools_root, f.toolsRoot);
  assert.equal(config.active_build_id, deployBuildId);
  assert.equal(config.keepalive_interval_min, 30, 'config 记录看护间隔供 Status 报告与重建恢复');
  assert.match(config.control_token, /^[a-f0-9]{32}$/);
  assert.ok(!JSON.stringify(result).includes(config.control_token));
  const skill = await readFile(join(f.skillsDir, 'suian-zcode-common', 'SKILL.md'), 'utf8');
  assert.ok(skill.includes(gatewayRoot));
  assert.ok(!skill.includes('<!-- suian-zcode-common:root -->'));
});

test('安装和重载写用户变量后广播，移除恢复或删除后广播，保留外部值时不广播', { skip: process.platform !== 'win32' }, async t => {
  for (const original of ['wss://previous.example/ws', null, 'external']) {
    const f = await fixture(t, { relay: original === 'external' ? null : original });
    const installed = await f.run('Install');
    assert.equal(installed.environment_broadcast, 'sent');
    assert.equal((await f.state()).broadcasts.length, 1);
    assert.equal((await f.run('Restart', { port: 17331 })).environment_broadcast, 'sent');
    let state = await f.state();
    assert.equal(state.broadcasts.length, 2);
    assert.equal(state.broadcasts[0].registry_relay, 'ws://127.0.0.1:17329/ws');
    assert.equal(state.broadcasts[1].registry_relay, 'ws://127.0.0.1:17331/ws');
    for (const broadcast of state.broadcasts) assert.deepEqual(
      { ...broadcast, registry_relay: null },
      { window: 65535, message: 26, wparam: 0, area: 'Environment', flags: 2, timeout: 1000, registry_relay: null }
    );
    assert.ok(state.broadcast_declaration.includes('SendMessageTimeoutW'));
    assert.ok(state.broadcast_declaration.includes('CharSet.Unicode'));
    if (original === 'external') { state.relay = 'wss://external.example/ws'; await writeFile(f.stateFile, JSON.stringify(state)); }
    const removed = await f.run('Remove');
    assert.equal(removed.environment_broadcast, original === 'external' ? 'not_needed' : 'sent');
    state = await f.state();
    assert.equal(state.broadcasts.length, original === 'external' ? 2 : 3);
    if (original !== 'external') assert.equal(state.broadcasts[2].registry_relay, original);
    assert.equal((await f.run('Status')).configured, false);
    assert.equal((await f.state()).broadcasts.length, state.broadcasts.length);
  }
});

test('移除清理任务失败前已经广播恢复值，错误明确报出且配置留待处理', { skip: process.platform !== 'win32' }, async t => {
  for (const original of ['wss://previous.example/ws', null]) {
    const f = await fixture(t, { relay: original });
    await f.run('Install');
    const state = await f.state(); state.unregister_fail = true;
    await writeFile(f.stateFile, JSON.stringify(state));
    await assert.rejects(f.run('Remove'), /fixture: task cleanup failed/);
    const failed = await f.state();
    assert.equal(failed.relay, original);
    assert.equal(failed.broadcasts.length, 2);
    assert.equal(failed.broadcasts[1].registry_relay, original);
    assert.equal(failed.task.State, 'Ready');
    assert.equal(JSON.parse(await readFile(join(f.dataDir, 'config.json'), 'utf8')).previous_user_relay, original);
  }
});

test('广播失败明确报错，已写入的用户变量保留且不宣称安装成功', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t, { broadcast_fail: true });
  await assert.rejects(f.run('Install'), /Environment change broadcast failed or timed out; user environment was already updated/);
  const state = await f.state();
  assert.equal(state.relay, 'ws://127.0.0.1:17329/ws');
  assert.equal(state.broadcasts.length, 1);
  assert.equal(state.task.State, 'Running');
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
  const deferredMode = await f.run('Restart', { mode: 'relay', busyTimeoutSec: 1, busyRetryMs: 50 });
  assert.equal(deferredMode.action, 'restart_deferred');
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

test('重复初始化复用唯一实例与原环境备份；同 buildId 幂等部署不重复', { skip: process.platform !== 'win32' }, async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run('Status')).configured, false);
  await f.run('Install');
  await f.run('Install');
  const state = await f.state();
  assert.equal(state.registrations, 1);
  assert.equal(state.starts, 1);
  const config = JSON.parse(await readFile(join(f.dataDir, 'config.json'), 'utf8'));
  assert.equal(config.previous_user_relay, 'wss://previous.example/ws');
  const deployments = await readdir(join(f.toolsRoot, 'deployments'));
  assert.deepEqual(deployments, [deployBuildId], '同 buildId 重复安装只保留一个部署');
  const active = JSON.parse(await readFile(join(f.toolsRoot, 'active-gateway.json'), 'utf8'));
  assert.equal(active.build_id, deployBuildId);
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
    const deferredRemove = await f.run('Remove', { busyTimeoutSec: 1, busyRetryMs: 50 });
    assert.equal(deferredRemove.action, 'remove_deferred');
    assert.equal(deferredRemove.upgrade_deferred, 'remote_busy');
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

test('启动失败或健康接口属于其他实例时明确失败，首次安装撤销注册、配置与部署且不写网关环境变量', { skip: process.platform !== 'win32' }, async (t) => {
  for (const health of ['failure', 'foreign']) {
    const f = await fixture(t, { health });
    await assert.rejects(f.run('Install'), health === 'failure' ? /fixture: 网关启动失败|rolled back|not installed/ : /different instance|rolled back|not installed/);
    const state = await f.state();
    assert.equal(state.relay, 'wss://previous.example/ws');
    assert.equal(state.broadcasts.length, 0);
    assert.equal(state.task, null, '首次安装失败必须撤销新增任务注册');
    await assert.rejects(readFile(join(f.dataDir, 'config.json')), { code: 'ENOENT' }, '首次安装失败必须删除本次配置');
    await assert.rejects(readFile(join(f.toolsRoot, 'active-gateway.json')), { code: 'ENOENT' }, '首次安装失败必须撤销活动记录');
    await assert.rejects(readFile(join(f.toolsRoot, 'deployments', deployBuildId, 'deployment.json')), { code: 'ENOENT' }, '首次安装失败必须清理本次部署');
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
  const deferredReload = await f.run('Restart', { busyTimeoutSec: 1, busyRetryMs: 50 });
  assert.equal(deferredReload.action, 'restart_deferred');
  assert.equal(deferredReload.upgrade_deferred, 'remote_busy');
  assert.equal((await f.state()).shutdowns, 0);
  assert.deepEqual(JSON.parse(await readFile(configFile, 'utf8')), old);
  state.desktop = false;
  await writeFile(f.stateFile, JSON.stringify(state));
  const result = await f.run('Restart');
  const updated = JSON.parse(await readFile(configFile, 'utf8'));
  assert.equal(result.action, 'restarted');
  assert.equal(updated.gateway_root, join(f.toolsRoot, 'deployments', deployBuildId), '迁移后 config 指向缓存外部署目录');
  for (const field of ['port', 'upstream_url', 'previous_user_relay', 'control_token'])
    assert.equal(updated[field], old[field]);
  state = await f.state();
  assert.equal(state.registrations, 1, '稳定任务参数与版本无关，重载不重新注册');
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
  const deferredPort = await f.run('Restart', { port: 17331, busyTimeoutSec: 1, busyRetryMs: 50 });
  assert.equal(deferredPort.action, 'restart_deferred');
  assert.equal(deferredPort.upgrade_deferred, 'remote_busy');
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
  const deferredLegacy = await f.run('Restart', { busyTimeoutSec: 1, busyRetryMs: 50 });
  assert.equal(deferredLegacy.action, 'restart_deferred');
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
  const deferredHeldRemove = await f.run('Remove', { busyTimeoutSec: 1, busyRetryMs: 50 });
  assert.equal(deferredHeldRemove.action, 'remove_deferred');
  const deferredHeldRestart = await f.run('Restart', { busyTimeoutSec: 1, busyRetryMs: 50 });
  assert.equal(deferredHeldRestart.action, 'restart_deferred');
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

// 构造内容不同的源码候选（复制真实源码根并修改运行文件），用于候选/活动/运行三态与切换测试。
async function variantSource(t) {
  const copyRoot = await mkdtemp(join(tmpdir(), 'zcode-gateway-variant-'));
  t.after(() => rm(copyRoot, { recursive: true, force: true }));
  await cp(gatewayRoot, copyRoot, { recursive: true, filter: path => {
    const rel = relative(gatewayRoot, path);
    return rel === '' || (!rel.startsWith('tests') && !rel.startsWith('docs') && !rel.startsWith('.scratch') && !rel.startsWith('experiments') && !/node_modules[\\/]esbuild/.test(rel) && !rel.includes('node_modules\\.bin'));
  } });
  const { readFile: rf, writeFile: wf, appendFile } = await import('node:fs/promises');
  await appendFile(join(copyRoot, 'terminal-relay.mjs'), '\n// variant probe\n');
  const buildId = await computeGatewayBuildId(copyRoot);
  const manifest = JSON.parse(await rf(join(copyRoot, 'package.json'), 'utf8'));
  assert.ok(manifest.name, '副本源码根完整');
  return { copyRoot, buildId };
}

const readActive = async toolsRoot => JSON.parse(await readFile(join(toolsRoot, 'active-gateway.json'), 'utf8'));

test('Status 区分候选、活动与运行版本；Desktop 活跃时不切换活动网关，暂停远控后原子切换', { skip: process.platform !== 'win32' }, async t => {
  const variant = await variantSource(t);
  const variantSetup = join(variant.copyRoot, 'setup.ps1');
  const f = await fixture(t);
  await f.run('Install');
  assert.notEqual(variant.buildId, deployBuildId, '副本必须是不同候选');

  // 候选（副本）不同时：Desktop 活跃 → Status 报待激活；Install 复用旧服务只报告；Restart 拒绝切换。
  let state = await f.state();
  state.desktop = true;
  await writeFile(f.stateFile, JSON.stringify(state));
  const pending = await f.run('Status', { setupScript: variantSetup });
  assert.equal(pending.code_status, 'changed', '运行实例仍是旧代码');
  assert.equal(pending.candidate_build_id, variant.buildId);
  assert.equal(pending.active_build_id, deployBuildId);
  assert.equal(pending.candidate_pending_activation, true);
  assert.equal(pending.gateway_restart_required, true);
  assert.equal((await readActive(f.toolsRoot)).build_id, deployBuildId, '待激活不改变活动记录');

  const reused = await f.run('Install', { setupScript: variantSetup });
  assert.equal(reused.ok, true);
  assert.equal(reused.candidate_pending_activation, true, 'Install 复用旧服务时明确报告待激活');
  state = await f.state();
  assert.equal(state.registrations, 1, '复用不重复注册');
  assert.equal(state.starts, 1);
  assert.equal((await readActive(f.toolsRoot)).build_id, deployBuildId);

  const deferredSwitch = await f.run('Restart', { setupScript: variantSetup, busyTimeoutSec: 1, busyRetryMs: 50 });
  assert.equal(deferredSwitch.action, 'restart_deferred');
  assert.equal((await readActive(f.toolsRoot)).build_id, deployBuildId, '放弃切换时活动记录保持不变');

  // Desktop 未知（任务运行但健康不可达）同样拒绝切换。
  state = await f.state();
  state.desktop = false;
  state.health_available = false;
  state.task.State = 'Running';
  await writeFile(f.stateFile, JSON.stringify(state));
  await assert.rejects(f.run('Restart', { setupScript: variantSetup }), /running state is unknown/);
  assert.equal((await readActive(f.toolsRoot)).build_id, deployBuildId);

  // 暂停远控并恢复健康后切换：健康报告候选 buildId 才算成功；任务参数不变，仅复用启动。
  state = await f.state();
  state.health_available = true;
  state.build = { id: variant.buildId, version: gatewayBuild.version };
  await writeFile(f.stateFile, JSON.stringify(state));
  const switched = await f.run('Restart', { setupScript: variantSetup });
  assert.equal(switched.ok, true);
  assert.equal(switched.active_build_id, variant.buildId);
  assert.equal((await readActive(f.toolsRoot)).build_id, variant.buildId, '原子切换活动记录到候选');
  state = await f.state();
  assert.equal(state.registrations, 1, '稳定任务参数与版本无关，切换不重注册');
  assert.equal(state.starts, 2);
  const deployments = await readdir(join(f.toolsRoot, 'deployments'));
  assert.ok(deployments.includes(deployBuildId) && deployments.includes(variant.buildId), '新旧部署并存，不自动清理旧部署');
  const statusAfter = await f.run('Status', { setupScript: variantSetup });
  assert.equal(statusAfter.candidate_pending_activation, false);
  assert.equal(statusAfter.code_status, 'current');
});

test('候选启动失败回退旧活动部署：恢复活动记录、配置与任务并重启，报告原错误与回退结果', { skip: process.platform !== 'win32' }, async t => {
  const variant = await variantSource(t);
  const variantSetup = join(variant.copyRoot, 'setup.ps1');
  const f = await fixture(t);
  await f.run('Install');
  const configBefore = await readFile(join(f.dataDir, 'config.json'), 'utf8');

  // 候选 B 启动后健康仍报告旧 build（候选未真正运行部署文件）→ 触发回退。
  const state = await f.state();
  state.build = { id: deployBuildId, version: gatewayBuild.version };
  await writeFile(f.stateFile, JSON.stringify(state));
  const failure = await f.run('Restart', { setupScript: variantSetup }).then(value => value, error => error);
  assert.ok(failure instanceof Error, '候选启动失败必须明确失败');
  assert.match(failure.message, /candidate|failed|different/i);
  assert.match(failure.message, /fallback|回退|restored/i, '必须报告回退结果');

  assert.equal((await readActive(f.toolsRoot)).build_id, deployBuildId, '回退恢复旧活动记录');
  assert.equal(await readFile(join(f.dataDir, 'config.json'), 'utf8'), configBefore, '回退恢复本次修改前的配置');
  const after = await f.state();
  assert.equal(after.task.State, 'Running', '回退后旧部署任务重新运行');
  assert.equal(after.registrations, 1);
  assert.equal(after.starts, 3, '候选试启动一次，回退重启旧部署一次');
  assert.equal(after.relay, 'ws://127.0.0.1:17329/ws', '网关环境在回退成功后保持已写状态');
  assert.ok((await readdir(join(f.toolsRoot, 'deployments'))).includes(variant.buildId), '候选部署保留待修复重试，不冒充已激活');
});

test('旧安装迁移：核对任务归属后切换稳定参数并删除已确认的旧启动文件，配置归属字段保留', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  await f.run('Install');
  const state = await f.state();
  // 旧安装形态：任务指向 DataDir 内 VBS，EncodedCommand 引用旧缓存 run.ps1。
  const legacyVbs = join(f.dataDir, 'gateway-launch.vbs');
  await writeFile(legacyVbs, 'Option Explicit\nSet s = CreateObject("WScript.Shell")\n');
  state.task.Actions.Arguments = '//B //NoLogo "' + legacyVbs + '" ' + Buffer.from("& 'D:\\旧缓存\\run.ps1' -NodePath 'C:\\node.exe' -DataDir '" + f.dataDir.replaceAll("'", "''") + "'", 'utf16le').toString('base64');
  state.task.Actions.WorkingDirectory = 'D:\\旧缓存';
  await writeFile(f.stateFile, JSON.stringify(state));
  const before = JSON.parse(await readFile(join(f.dataDir, 'config.json'), 'utf8'));

  const migrated = await f.run('Restart');
  assert.equal(migrated.ok, true);
  const after = await f.state();
  assert.ok(after.task.Actions.Arguments.includes('"' + join(f.toolsRoot, 'launchers', 'gateway-launch.vbs') + '"'), '任务切换到缓存外稳定启动器');
  assert.equal(after.task.Actions.WorkingDirectory, f.dataDir, '工作目录改到数据目录');
  assert.equal(after.registrations, 2, '迁移重新注册同一任务身份');
  await assert.rejects(readFile(legacyVbs), { code: 'ENOENT' }, '切换成功后删除已确认归属的旧启动文件');
  const updated = JSON.parse(await readFile(join(f.dataDir, 'config.json'), 'utf8'));
  for (const field of ['port', 'upstream_url', 'previous_user_relay', 'control_token']) assert.equal(updated[field], before[field]);
});

test('网关活动记录与 Toast 活动记录独立：安装、切换与移除网关不触碰 Toast 记录', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const toastRecord = { version: 1, build_id: 'b'.repeat(64), note: 'pkg-06 fixture' };
  await mkdir(f.toolsRoot, { recursive: true });
  await writeFile(join(f.toolsRoot, 'active-toast.json'), JSON.stringify(toastRecord));
  await f.run('Install');
  assert.deepEqual(JSON.parse(await readFile(join(f.toolsRoot, 'active-toast.json'), 'utf8')), toastRecord);
  await f.run('Restart');
  assert.deepEqual(JSON.parse(await readFile(join(f.toolsRoot, 'active-toast.json'), 'utf8')), toastRecord);
  const removed = await f.run('Remove');
  assert.deepEqual(JSON.parse(await readFile(join(f.toolsRoot, 'active-toast.json'), 'utf8')), toastRecord, '移除网关不得删除 Toast 活动记录');
  assert.equal(removed.toast_record, 'preserved');
  assert.ok((await readdir(join(f.toolsRoot, 'deployments'))).includes(deployBuildId), 'Toast 仍引用部署时不清理部署目录');
});

test('Remove 在无 Toast 记录时清理网关部署产物与活动记录', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  await f.run('Install');
  const removed = await f.run('Remove');
  assert.equal(removed.ok, true);
  await assert.rejects(readFile(join(f.toolsRoot, 'active-gateway.json')), { code: 'ENOENT' });
  await assert.rejects(stat(join(f.toolsRoot, 'launchers')), { code: 'ENOENT' });
  await assert.rejects(stat(join(f.toolsRoot, 'deployments')), { code: 'ENOENT' });
});

test('切换事务由独占句柄锁保护：持锁时第二实例明确失败不动文件，持锁进程退出后立即可重试，Status 不受影响', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const lockPath = join(f.dataDir, 'upgrade.lock');
  const heldSignal = join(f.root, 'lock-held.signal');
  const singleQuote = path => path.replace(/'/g, "''");
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `[IO.Directory]::CreateDirectory('${singleQuote(f.dataDir)}') | Out-Null; $fs=[IO.File]::Open('${singleQuote(lockPath)}','Create','ReadWrite','Read'); $b=[Text.Encoding]::UTF8.GetBytes("$PID\`n"); $fs.Write($b,0,$b.Length); $fs.Flush(); Set-Content -LiteralPath '${singleQuote(heldSignal)}' 'held'; Start-Sleep -Seconds 120; $fs.Close()`], { windowsHide: true, stdio: 'ignore' });
  t.after(() => holder.kill());
  for (let i = 0; i < 100 && !existsSync(heldSignal); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(existsSync(heldSignal), '外部持锁进程应就绪');
  await assert.rejects(f.run('Install'), error => {
    assert.match(error.stderr, /already running/);
    assert.match(error.stderr, new RegExp('pid ' + holder.pid), '报错应带持锁进程 pid');
    return true;
  });
  assert.equal((await f.state()).registrations, 0, '拿锁失败不得注册任务');
  await assert.rejects(stat(join(f.dataDir, 'config.json')), { code: 'ENOENT' }, '拿锁失败不得写配置');
  await assert.rejects(stat(join(f.toolsRoot, 'active-gateway.json')), { code: 'ENOENT' }, '拿锁失败不得写活动记录');
  const status = await f.run('Status');
  assert.equal(status.ok, true, 'Status 只读操作不受锁影响');
  holder.kill();
  await new Promise(resolve => holder.once('exit', resolve));
  const installed = await f.run('Install');
  assert.equal(installed.ok, true, '持锁进程退出后锁应自动释放');
  await assert.rejects(stat(lockPath), { code: 'ENOENT' }, '成功事务结束后清理锁文件');
});

test('锁内事务失败回退后锁已释放，后续实例可立即重试', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  await f.run('Install');
  const state = await f.state();
  state.fail_start_count = 1;
  await writeFile(f.stateFile, JSON.stringify(state));
  await assert.rejects(f.run('Restart', { port: 17331 }), /fallback: restored/);
  const retried = await f.run('Restart');
  assert.equal(retried.ok, true, '失败事务的 throw 退出进程即释放锁');
});

test('忙退避重探：远控忙两次后转空闲，V2 以空闲闪断完成升级', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  await f.run('Install', { zcodeAppVersion: '3.16.1' });
  const state = await f.state();
  state.desktop = true; state.rpc_in_flight = 0; state.busy_reads_left = 2;
  await writeFile(f.stateFile, JSON.stringify(state));
  const result = await f.run('Restart', { busyRetryMs: 50, busyTimeoutSec: 30 });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'restarted');
  const after = await f.state();
  assert.equal(after.shutdowns, 1, '忙转闲后恰好一次升级关闭');
  const active = JSON.parse(await readFile(join(f.toolsRoot, 'active-gateway.json'), 'utf8'));
  assert.equal(active.build_id, deployBuildId);
});

test('持续忙到上限放弃切换：输出 remote_busy，活动记录、配置与任务未动且不发出 shutdown', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  await f.run('Install', { zcodeAppVersion: '3.16.1' });
  const activeBefore = await readFile(join(f.toolsRoot, 'active-gateway.json'), 'utf8');
  const configBefore = await readFile(join(f.dataDir, 'config.json'), 'utf8');
  const state = await f.state();
  state.desktop = true; state.rpc_in_flight = 1;
  await writeFile(f.stateFile, JSON.stringify(state));
  const deferred = await f.run('Restart', { busyRetryMs: 50, busyTimeoutSec: 1 });
  assert.equal(deferred.ok, true);
  assert.equal(deferred.action, 'restart_deferred');
  assert.equal(deferred.upgrade_deferred, 'remote_busy');
  assert.equal(await readFile(join(f.toolsRoot, 'active-gateway.json'), 'utf8'), activeBefore);
  assert.equal(await readFile(join(f.dataDir, 'config.json'), 'utf8'), configBefore);
  const after = await f.state();
  assert.equal(after.shutdowns, 0, '放弃切换不得发出 shutdown');
  assert.equal(after.task.State, 'Running');
});

test('旧网关健康无 rpc_in_flight 字段时保守等待连接断开，不启用空闲闪断', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  await f.run('Install', { zcodeAppVersion: '3.16.1' });
  const state = await f.state();
  state.desktop = true;
  await writeFile(f.stateFile, JSON.stringify(state));
  const deferred = await f.run('Restart', { busyRetryMs: 50, busyTimeoutSec: 1 });
  assert.equal(deferred.upgrade_deferred, 'remote_busy');
  const after = await f.state();
  assert.equal(after.shutdowns, 0, '保守模式不得在连接仍在时发出关闭');
});

test('升级关闭被服务端拒绝时回到退避重探，不直接失败', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  await f.run('Install', { zcodeAppVersion: '3.16.1' });
  const state = await f.state();
  state.desktop = true; state.rpc_in_flight = 0; state.idle_shutdown_rejects = 1;
  await writeFile(f.stateFile, JSON.stringify(state));
  const result = await f.run('Restart', { busyRetryMs: 50, busyTimeoutSec: 30 });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'restarted');
  assert.equal((await f.state()).shutdowns, 1);
});

test('Remove 在远控忙时同样退避（V1 保守等待），超时放弃不动配置与任务', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  await f.run('Install');
  const configBefore = await readFile(join(f.dataDir, 'config.json'), 'utf8');
  const state = await f.state();
  state.desktop = true; state.rpc_in_flight = 1;
  await writeFile(f.stateFile, JSON.stringify(state));
  const deferred = await f.run('Remove', { busyRetryMs: 50, busyTimeoutSec: 1 });
  assert.equal(deferred.ok, true);
  assert.equal(deferred.action, 'remove_deferred');
  assert.equal(deferred.upgrade_deferred, 'remote_busy');
  assert.equal(await readFile(join(f.dataDir, 'config.json'), 'utf8'), configBefore);
  const after = await f.state();
  assert.notEqual(after.task, null, '放弃移除不得删除任务');
  assert.equal(after.shutdowns, 0);
});

test('运行中 V1 网关升级到 V2 时不启用空闲闪断：按健康自报协议保守等待', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  await f.run('Install');
  const state = await f.state();
  state.desktop = true; state.rpc_in_flight = 0; state.app_version_env = '3.16.1';
  await writeFile(f.stateFile, JSON.stringify(state));
  const deferred = await f.run('Restart', { zcodeAppVersion: '3.16.1', busyTimeoutSec: 1, busyRetryMs: 50 });
  assert.equal(deferred.upgrade_deferred, 'remote_busy');
  assert.equal((await f.state()).shutdowns, 0, '不得对运行中 V1 Desktop 发出空闲闪断关闭');
});

test('共享启动器写入在事务锁内：持锁期间其他实例拿锁失败且不覆盖 launchers 文件', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  await f.run('Install');
  const launcherPs = join(f.toolsRoot, 'launchers', 'run.ps1');
  const launcherVbs = join(f.toolsRoot, 'launchers', 'gateway-launch.vbs');
  const psBefore = await readFile(launcherPs);
  const vbsBefore = await readFile(launcherVbs);
  const variant = await variantSource(t);
  const { appendFile } = await import('node:fs/promises');
  await appendFile(join(variant.copyRoot, 'gateway-launcher.ps1'), '\n# variant launcher probe\n');
  await appendFile(join(variant.copyRoot, 'run.vbs'), "\n' variant vbs probe\n");
  const variantSetup = join(variant.copyRoot, 'setup.ps1');
  const lockPath = join(f.dataDir, 'upgrade.lock');
  const heldSignal = join(f.root, 'launchers-lock-held.signal');
  const singleQuote = path => path.replace(/'/g, "''");
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$fs=[IO.File]::Open('${singleQuote(lockPath)}','Create','ReadWrite','Read'); $b=[Text.Encoding]::UTF8.GetBytes("$PID\`n"); $fs.Write($b,0,$b.Length); $fs.Flush(); Set-Content -LiteralPath '${singleQuote(heldSignal)}' 'held'; Start-Sleep -Seconds 120; $fs.Close()`], { windowsHide: true, stdio: 'ignore' });
  t.after(() => holder.kill());
  for (let i = 0; i < 100 && !existsSync(heldSignal); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(existsSync(heldSignal), '外部持锁进程应就绪');
  await assert.rejects(f.run('Install', { setupScript: variantSetup }), /already running/);
  assert.deepEqual(await readFile(launcherPs), psBefore, '拿锁失败不得覆盖共享 PowerShell 启动器');
  assert.deepEqual(await readFile(launcherVbs), vbsBefore, '拿锁失败不得覆盖共享 VBS 启动器');
  holder.kill();
  await new Promise(resolve => holder.once('exit', resolve));
  const switched = await f.run('Install', { setupScript: variantSetup });
  assert.equal(switched.ok, true, '持锁进程退出后可正常切换，此时允许写入新启动器');
});

// ---------- LO-04：3.16 local-only setup 产品集成（Close #147） ----------

const loInstallOptions = { zcodeAppVersion: '3.16.1', mode: 'local-only', zcodeInstallDir: 'D:\\fake\\ZCode', localOnlyWorkspace: 'D:\\ws' };

test('local-only 预检在写配置与停网关前拒绝：未知包、摘要变化、身份解析失败各自明确报错并给诊断指引', { skip: process.platform !== 'win32' }, async t => {
  for (const [stub, error] of [
    ['unsupported', /not supported for local-only[\s\S]*exe 版本不符[\s\S]*debug skill/],
    ['digest', /not supported for local-only[\s\S]*摘要/],
    ['resolve_fail', /preflight failed \(unsupported_package\)[\s\S]*目标身份解析失败/],
  ]) {
    const f = await fixture(t, { patch_stub: stub });
    await assert.rejects(f.run('Install', { ...loInstallOptions, localOnlyDataRoot: f.root }), error);
    await assert.rejects(stat(join(f.dataDir, 'config.json')), { code: 'ENOENT' });
    const state = await f.state();
    assert.equal(state.registrations + state.starts + state.shutdowns + state.broadcasts.length, 0, '拒绝发生在任何写入之前');
    assert.deepEqual(state.patch_calls, [['status', '--target', 'D:\\fake\\ZCode']], '只做只读预检');
  }
});

test('受支持包放行 3.16 local-only 安装：默认端口 17331、生成外部命令、setup 自身不 apply 不杀进程', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t, { patch_stub: 'original' });
  const result = await f.run('Install', { ...loInstallOptions, localOnlyDataRoot: f.root });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'local-only');
  assert.equal(result.relay_url, 'ws://127.0.0.1:17331/ws', 'local-only 默认端口与补丁默认网关地址一致');
  const config = JSON.parse(await readFile(join(f.dataDir, 'config.json'), 'utf8'));
  assert.equal(config.mode, 'local-only');
  assert.equal(config.relay_protocol_version, 2);
  assert.equal(config.port, 17331);
  assert.equal(config.previous_user_relay, 'wss://previous.example/ws', '原环境备份保留');

  // 外部命令产物：apply 与 restore 各一个 .ps1，落在公共数据目录。
  assert.equal(result.local_only.state, 'prepared');
  assert.equal(result.local_only.install_dir, 'D:\\fake\\ZCode');
  assert.equal(result.local_only.patch_state, 'original');
  assert.equal(result.local_only.patch_version, 2);
  assert.equal(result.local_only.apply_script, join(f.dataDir, 'local-only', 'apply-local-only.ps1'));
  assert.equal(result.local_only.restore_script, join(f.dataDir, 'local-only', 'restore-local-only.ps1'));
  const applyScript = await readFile(result.local_only.apply_script, 'utf8');
  assert.ok(applyScript.includes('D:\\fake\\ZCode'), '外部命令锚定精确目标');
  assert.ok(applyScript.includes(join(f.dataDir, 'local-only', 'candidate')), '外部命令引用本次候选');
  assert.ok(applyScript.includes(join(f.root, '.zcode', 'local-only.flag')), '外部命令写标志文件');
  assert.ok(applyScript.includes('D:\\ws'), '标志首行携带工作区');
  assert.ok(applyScript.includes('status'), '外部命令重新核对身份');
  for (const banned of ['Stop-Process', 'taskkill', 'Stop-ScheduledTask']) {
    assert.ok(!applyScript.includes(banned), `外部命令不得包含 ${banned}，不强退进程`);
  }
  const restoreScript = await readFile(result.local_only.restore_script, 'utf8');
  assert.ok(restoreScript.includes('restore'));
  assert.ok(restoreScript.includes('D:\\fake\\ZCode'));

  // setup 只做 status/prepare；apply/restore 一律留给外部命令（桩对 apply/restore 直接失败）。
  const calls = (await f.state()).patch_calls.map(call => call[0]).sort();
  assert.deepEqual(calls, ['prepare', 'status']);
  // 环境变量写入与广播沿用既有纪律。
  const state = await f.state();
  assert.equal(state.relay, 'ws://127.0.0.1:17331/ws');
  assert.equal(state.broadcasts.length, 1);
  // Status 可附加报告补丁状态（只读）。
  const status = await f.run('Status', { zcodeInstallDir: 'D:\\fake\\ZCode' });
  assert.equal(status.local_only_patch.patchState, 'original');
});

test('重复 local-only 准备幂等：候选重备、外部命令重写、不重复注册任务', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t, { patch_stub: 'original' });
  const first = await f.run('Install', { ...loInstallOptions, localOnlyDataRoot: f.root });
  const second = await f.run('Install', { ...loInstallOptions, localOnlyDataRoot: f.root });
  assert.equal(second.ok, true);
  assert.equal(second.local_only.state, 'prepared');
  const state = await f.state();
  assert.equal(state.registrations, 1, '重复安装不重复注册');
  const prepares = state.patch_calls.filter(call => call[0] === 'prepare');
  assert.equal(prepares.length, 2, '重复调用重新生成候选');
  assert.ok((await readFile(first.local_only.apply_script, 'utf8')).includes('D:\\fake\\ZCode'), '外部命令保持可读');
});

test('已应用当前补丁的目标放行且不再准备候选；旧版本补丁走升级准备；prepare 失败拒绝安装', { skip: process.platform !== 'win32' }, async t => {
  const patched = await fixture(t, { patch_stub: 'patched' });
  const patchedResult = await patched.run('Install', { ...loInstallOptions, localOnlyDataRoot: patched.root });
  assert.equal(patchedResult.local_only.state, 'already_patched');
  assert.equal(patchedResult.local_only.patch_version, 2);
  assert.deepEqual((await patched.state()).patch_calls.map(call => call[0]), ['status'], '当前版本已 patched 不再 prepare');
  assert.ok((await readFile(patchedResult.local_only.apply_script, 'utf8')).includes('patched'), '外部命令覆盖已打补丁分支');

  const upgrade = await fixture(t, { patch_stub: 'upgrade' });
  const upgradeResult = await upgrade.run('Install', { ...loInstallOptions, localOnlyDataRoot: upgrade.root });
  assert.equal(upgradeResult.local_only.state, 'prepared_upgrade');
  assert.deepEqual((await upgrade.state()).patch_calls.map(call => call[0]).sort(), ['prepare', 'status']);

  const failed = await fixture(t, { patch_stub: 'prepare_fail' });
  await assert.rejects(failed.run('Install', { ...loInstallOptions, localOnlyDataRoot: failed.root }), /local-only prepare failed \(anchor_mismatch\)/);
  await assert.rejects(stat(join(failed.dataDir, 'config.json')), { code: 'ENOENT' });
  assert.equal((await failed.state()).broadcasts.length, 0, '准备失败不写任何用户环境');
});

test('v1→v2 升级场景：外部 apply 命令对已打 v1 补丁的目标调用补丁 CLI 升级，而非跳过后伪装成功', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t, { patch_stub: 'upgrade' });
  const result = await f.run('Install', { ...loInstallOptions, localOnlyDataRoot: f.root });
  assert.equal(result.local_only.state, 'prepared_upgrade');

  // 真实执行生成的外部 apply 脚本：node 解释器保持真实，只把渲染进脚本的补丁 CLI
  // 路径换成桩 CLI（记录每次调用并按 patch_stub='upgrade' 语义回执）——被测的是
  // 外部脚本"是否调用补丁 CLI"的 apply 决策，不是 CLI 本身。
  const callsFile = join(f.root, 'stub-patch-calls.log');
  const stubCli = join(f.root, 'stub-patch-cli.mjs');
  const stubReceipt = {
    status: { ok: true, supported: true, patchState: 'patched', patchInfo: { patchVersion: 1, upgradeAvailable: 2 }, package: { exeFileVersion: '3.16.2.8769', appAsarSha256: 'v1-digest' }, backup: { exists: true, sha256: 'original-digest', matchesOriginal: true } },
    apply: { ok: true, upgradedFromPatchVersion: 1, patchVersion: 2, patchedAsarSha256: 'cb54-patched-digest' },
  };
  await writeFile(stubCli, `import { appendFileSync } from 'node:fs';
const callsFile = ${JSON.stringify(callsFile)};
const argv = process.argv.slice(2);
appendFileSync(callsFile, JSON.stringify(argv) + '\\n');
const receipts = ${JSON.stringify(stubReceipt)};
const receipt = receipts[argv[0]] ?? { ok: false, code: 'internal', reason: 'stub: unexpected command ' + argv[0] };
console.log(JSON.stringify(receipt));
`);
  const generated = await readFile(result.local_only.apply_script, 'utf8');
  const harness = join(f.root, 'apply-upgrade-run.ps1');
  const injected = generated.replace(/^(\$patchCli = ')[^']*(')$/m, (m, head, tail) => head + stubCli + tail);
  assert.notEqual(injected, generated, '测试注入点命中：外部脚本内嵌的补丁 CLI 路径');
  await writeFile(harness, injected);

  const { stdout } = await nativeExec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness], { windowsHide: true });
  const receipt = JSON.parse(stdout.trim());

  // 升级决策：已打 v1 补丁（patchState=patched + upgradeAvailable）必须触达补丁 CLI 的
  // apply（工具内部 restore→re-apply），不得因"已 patched"跳过并回执 already。
  const calls = (await readFile(callsFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls.map(call => call[0]), ['status', 'apply'], 'v1 补丁目标的外部 apply 必须调用补丁 CLI 升级');
  assert.deepEqual(calls[1].slice(0, 2), ['apply', '--target'], 'apply 锚定精确目标');
  assert.ok(calls[1].includes('--candidate'), '升级 apply 携带本次准备的新候选');
  assert.ok(calls[1].includes('D:\\fake\\ZCode'));
  assert.equal(receipt.ok, true);
  assert.equal(receipt.applied, 'applied', '升级真实发生，回执不得伪装 already');
  assert.equal(receipt.activated, true);
  assert.equal(await readFile(join(f.root, '.zcode', 'local-only.flag'), 'utf8'), 'D:\\ws\r\n', '开关激活写入工作区');
});

test('完整还原外部命令在恢复应用后恢复 relay 配置，原版重试同样完成模式恢复', { skip: process.platform !== 'win32' }, async t => {
  for (const scenario of ['patched', 'original', 'gateway_failure']) {
    const patchState = scenario === 'gateway_failure' ? 'original' : scenario;
    const f = await fixture(t);
    const installed = await f.run('Install', { ...loInstallOptions, localOnlyDataRoot: f.root });
    const flagPath = join(f.root, '.zcode', 'local-only.flag');
    await mkdir(dirname(flagPath), { recursive: true });
    await writeFile(flagPath, 'D:\\ws\r\n');
    const callsFile = join(f.root, 'restore-calls.jsonl');
    const stubCli = join(f.root, 'restore-cli.mjs');
    await writeFile(stubCli, `import { appendFileSync } from 'node:fs';
const command = process.argv[2];
appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(command) + '\\n');
console.log(JSON.stringify(command === 'status' ? {ok:true,supported:true,patchState:${JSON.stringify(patchState)},package:{appAsarSha256:'original-digest'}} : {ok:true,restoredAsarSha256:'original-digest'}));
`);
    const script = (await readFile(installed.local_only.restore_script, 'utf8')).replace(/^(\$patchCli = ')[^']*(')$/m, (_, head, tail) => head + stubCli + tail);
    const harness = join(f.root, 'restore-run.ps1');
    await writeFile(harness, script);
    if (scenario === 'gateway_failure') {
      const state = await f.state();
      state.fail_start_count = 1;
      await writeFile(f.stateFile, JSON.stringify(state));
      // fixture 通过 & 调用脚本，exit 只退出该脚本作用域；此处核对真实失败回执。
      const partial = await f.run('Status', { setupScript: harness });
      assert.equal(partial.ok, false);
      assert.equal(partial.application_original, true);
      assert.equal(partial.gateway_restored, false);
      assert.match(partial.reason, /start denied/);
      assert.equal(JSON.parse(await readFile(join(f.dataDir, 'config.json'), 'utf8')).mode, 'local-only');
      continue;
    }
    const receipt = await f.run('Status', { setupScript: harness });
    assert.equal(receipt.ok, true);
    const config = JSON.parse(await readFile(join(f.dataDir, 'config.json'), 'utf8'));
    assert.equal(config.mode, 'relay', '完整还原必须恢复网关模式');
    assert.equal(config.port, 17331);
    assert.equal(config.previous_user_relay, 'wss://previous.example/ws');
    assert.equal((await f.state()).relay, 'ws://127.0.0.1:17331/ws');
    assert.equal(receipt.gateway_mode, 'relay');
    assert.equal(receipt.restoredAsarSha256, 'original-digest');
    await assert.rejects(stat(flagPath), { code: 'ENOENT' });
    const calls = (await readFile(callsFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(calls, patchState === 'patched' ? ['status', 'restore'] : ['status']);
  }
});

test('切回 relay 关闭本地开关、恢复网关模式与环境值，不重写应用包', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t, { patch_stub: 'original' });
  await f.run('Install', { ...loInstallOptions, localOnlyDataRoot: f.root });
  // 模拟用户已按指引执行外部命令：补丁已应用、开关已激活（标志文件存在）。
  const flagPath = join(f.root, '.zcode', 'local-only.flag');
  await mkdir(dirname(flagPath), { recursive: true });
  await writeFile(flagPath, 'D:\\ws\r\n');
  const callsBefore = (await f.state()).patch_calls.length;
  const switched = await f.run('Restart', { mode: 'relay', localOnlyDataRoot: f.root });
  assert.equal(switched.mode, 'relay');
  assert.equal(switched.local_only_switch, 'disabled', '切回 relay 删除模式开关');
  await assert.rejects(stat(flagPath), { code: 'ENOENT' }, '标志文件被删除');
  const config = JSON.parse(await readFile(join(f.dataDir, 'config.json'), 'utf8'));
  assert.equal(config.mode, 'relay');
  assert.equal((await f.state()).patch_calls.length, callsBefore, '切回 relay 不触碰补丁工具，不重写应用包');
  const again = await f.run('Restart', { mode: 'relay', localOnlyDataRoot: f.root });
  assert.equal(again.local_only_switch, 'already_off', '开关已关时报告 already_off');
});

test('看护间隔参数：自定义间隔写入 config 与触发器，重跑沿用已装值，越界值拒绝', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const installed = await f.run('Install', { keepaliveIntervalMin: 15 });
  assert.equal(installed.keepalive_interval_min, 15);
  let state = await f.state();
  assert.equal(state.task.Triggers[1].RepetitionIntervalMinutes, 15);
  assert.equal(JSON.parse(await readFile(join(f.dataDir, 'config.json'), 'utf8')).keepalive_interval_min, 15);
  await f.run('Restart');
  state = await f.state();
  assert.equal(state.task.Triggers[1].RepetitionIntervalMinutes, 15, '未显式传参时沿用已装间隔');
  await assert.rejects(f.run('Status', { keepaliveIntervalMin: 4 }), /KeepaliveIntervalMin/);
  await assert.rejects(f.run('Status', { keepaliveIntervalMin: 1441 }), /KeepaliveIntervalMin/);
});

test('触发器形状识别真实 CIM 形态的完整 ISO 8601 间隔（PT{N}M/PT1H/PT1H30M/P1D）并参与自愈判定', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  await f.run('Install', { keepaliveIntervalMin: 15 });
  const state = await f.state();
  const cimTriggers = interval => ([
    { CimClass: { CimClassName: 'MSFT_TaskLogonTrigger' } },
    { Repetition: { Interval: interval } },
  ]);
  // 模拟真实 Get-ScheduledTask 对象经 fixture JSON 往返后的 CIM 形态：
  // 登录触发以 CimClass.CimClassName 标识，看护触发的间隔在 Repetition.Interval（ISO 8601 duration）。
  state.task.Triggers = cimTriggers('PT15M');
  state.task.Trigger = state.task.Triggers[0];
  await writeFile(f.stateFile, JSON.stringify(state));
  const matched = await f.run('Status');
  assert.equal(matched.keepalive_trigger_ok, true, 'PT15M 与已装 15 分钟间隔匹配');
  assert.equal(matched.gateway_restart_required, false);
  state.task.Triggers[1].Repetition.Interval = 'PT20M';
  await writeFile(f.stateFile, JSON.stringify(state));
  const mismatched = await f.run('Status');
  assert.equal(mismatched.keepalive_trigger_ok, false, '间隔漂移被识别');
  assert.equal(mismatched.gateway_restart_required, true);
  // 等价写法：任务计划程序对 60/90/1440 分钟可能登记为 PT1H/PT1H30M/P1D，语义与分钟写法等价，
  // 不得误判形状不符并在 Restart 时反复重注册。
  for (const [interval, minutes] of [['PT1H', 60], ['PT1H30M', 90], ['P1D', 1440]]) {
    const eq = await fixture(t);
    await eq.run('Install', { keepaliveIntervalMin: minutes });
    const eqState = await eq.state();
    eqState.task.Triggers = cimTriggers(interval);
    eqState.task.Trigger = eqState.task.Triggers[0];
    await writeFile(eq.stateFile, JSON.stringify(eqState));
    const receipt = await eq.run('Status');
    assert.equal(receipt.keepalive_trigger_ok, true, interval + ' 与已装 ' + minutes + ' 分钟间隔匹配');
    assert.equal(receipt.gateway_restart_required, false, interval + ' 不应要求重注册');
  }
  // 非 duration 文本不是合法间隔，按无周期触发处理
  state.task.Triggers[1].Repetition.Interval = 'not-a-duration';
  await writeFile(f.stateFile, JSON.stringify(state));
  const invalid = await f.run('Status');
  assert.equal(invalid.keepalive_trigger_ok, false, '非法 duration 不被当作有效间隔');
});

test('健康网关上的 Install 同样执行触发器自愈：旧形状重注册、改间隔即时生效且不打断实例', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  await f.run('Install');
  let state = await f.state();
  assert.equal(state.task.State, 'Running');
  assert.equal(state.health_available, true, '前提：网关健康');
  // 健康状态下退回旧单触发器形状：Install 必须原地重注册，不能只写 config
  state.task.Triggers = [state.task.Triggers[0]];
  state.task.Trigger = state.task.Triggers[0];
  await writeFile(f.stateFile, JSON.stringify(state));
  const healed = await f.run('Install');
  assert.equal(healed.keepalive_trigger_ok, true, '健康 Install 后形状回执为 ok');
  assert.equal(healed.keepalive_interval_min, 30);
  assert.equal(healed.task_running, true, '运行中的任务实例未被停止');
  state = await f.state();
  assert.equal(state.task.Triggers.length, 2, '任务被重注册为双触发器');
  assert.equal(state.task.Triggers[1].RepetitionIntervalMinutes, 30);
  assert.equal(state.task.State, 'Running', '重注册只替换定义，不打断当前实例');
  assert.equal(state.starts, 1, '未重新拉起网关（保持原实例）');
  assert.equal(JSON.parse(await readFile(join(f.dataDir, 'config.json'), 'utf8')).keepalive_interval_min, 30);
  // 健康状态下改间隔：任务与 config 同步更新，回执间隔即任务实际间隔
  const reinterval = await f.run('Install', { keepaliveIntervalMin: 15 });
  assert.equal(reinterval.keepalive_interval_min, 15);
  assert.equal(reinterval.keepalive_trigger_ok, true, '新间隔同步写入触发器');
  assert.equal(reinterval.gateway_restart_required, false, '间隔一致后不要求重注册');
  state = await f.state();
  assert.equal(state.task.Triggers[1].RepetitionIntervalMinutes, 15);
  assert.equal(JSON.parse(await readFile(join(f.dataDir, 'config.json'), 'utf8')).keepalive_interval_min, 15);
  // 形状与间隔都已一致时，再次健康 Install 不做多余重注册
  const registrations = state.registrations;
  const again = await f.run('Install');
  assert.equal((await f.state()).registrations, registrations, '已一致时不重注册');
  assert.equal(again.keepalive_trigger_ok, true);
});

test('旧形状任务（仅登录触发）在重跑 setup 时自动自愈为双触发器', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  await f.run('Install');
  let state = await f.state();
  // 模拟 0.7.3 及更早安装的旧任务：只有 AtLogOn 触发器
  state.task.Triggers = [state.task.Triggers[0]];
  state.task.Trigger = state.task.Triggers[0];
  await writeFile(f.stateFile, JSON.stringify(state));
  const status = await f.run('Status');
  assert.equal(status.keepalive_trigger_ok, false, '旧形状被识别');
  assert.equal(status.launcher_update_required, true);
  assert.equal(status.gateway_restart_required, true);
  await f.run('Restart');
  state = await f.state();
  assert.equal(state.task.Triggers.length, 2, '重跑后自愈为双触发器');
  assert.equal(state.task.Triggers[1].RepetitionIntervalMinutes, 30);
  const after = await f.run('Status');
  assert.equal(after.keepalive_trigger_ok, true);
  assert.equal(after.gateway_restart_required, false);
});

test('setup 调用任务计划程序 cmdlet 的参数名必须存在于真实 cmdlet 参数集合', { skip: process.platform !== 'win32' }, async t => {
  const cmdlets = ['New-ScheduledTaskAction', 'New-ScheduledTaskTrigger', 'New-ScheduledTaskPrincipal', 'New-ScheduledTaskSettingsSet', 'Register-ScheduledTask'];
  const source = await readFile(setup, 'utf8');
  const usage = new Map(cmdlets.map(c => [c, new Set()]));
  for (const line of source.split(/\r?\n/)) {
    for (const c of cmdlets) {
      if (new RegExp('(?<![A-Za-z])' + c + '\\b').test(line)) {
        for (const token of line.match(/(?<![A-Za-z:])-(\w+)/g) ?? []) usage.get(c).add(token.slice(1));
      }
    }
  }
  const { stdout } = await nativeExec('powershell.exe', ['-NoProfile', '-Command', "$ErrorActionPreference='Stop'; $out=@{}; foreach ($c in @('" + cmdlets.join("','") + "')) { $cmd = Get-Command -Name $c -CommandType Function,Cmdlet -ErrorAction SilentlyContinue; $out[$c] = if ($cmd) { @($cmd.Parameters.Keys) } else { $null } }; $out | ConvertTo-Json -Compress"], { windowsHide: true });
  const real = JSON.parse(stdout.trim());
  for (const c of cmdlets) {
    const realParams = real[c];
    if (!realParams) { t.diagnostic(c + '：本机无真实 cmdlet，跳过该项核对'); continue; }
    const allowed = new Set(realParams.map(p => p.toLowerCase()));
    for (const used of usage.get(c)) {
      assert.ok(allowed.has(used.toLowerCase()), c + ' 的参数 -' + used + ' 不在真实 cmdlet 参数集合中（疑似拼写错误）');
    }
  }
});

test('健康网关上的 Install：旧启动链下改间隔被拒绝并引导 Restart，不写入未生效配置', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  await f.run('Install');
  const state = await f.state();
  state.task.Actions.Execute = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await writeFile(f.stateFile, JSON.stringify(state));
  const before = await readFile(join(f.dataDir, 'config.json'), 'utf8');
  await assert.rejects(f.run('Install', { keepaliveIntervalMin: 15 }), /Restart/);
  assert.equal(await readFile(join(f.dataDir, 'config.json'), 'utf8'), before, '拒绝路径不写 config，间隔保持已装值');
  assert.equal((await f.state()).registrations, 1, '健康路径不重注册旧启动链任务');
  // 引导的 Restart 带同参完成安全重载并应用新间隔
  const restarted = await f.run('Restart', { keepaliveIntervalMin: 15 });
  assert.equal(restarted.keepalive_interval_min, 15);
  assert.equal(restarted.keepalive_trigger_ok, true);
  const after = await f.state();
  assert.equal(after.task.Triggers[1].RepetitionIntervalMinutes, 15);
  assert.equal(JSON.parse(await readFile(join(f.dataDir, 'config.json'), 'utf8')).keepalive_interval_min, 15);
});

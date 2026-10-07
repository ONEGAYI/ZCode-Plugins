[CmdletBinding()]
param(
    [ValidateSet('Install', 'Status', 'Remove', 'Restart')][string]$Action = 'Status',
    [ValidateRange(1, 65535)][int]$Port = 17329,
    [ValidateRange(1, 30)][int]$HealthTimeoutSec = 5,
    [string]$UpstreamUrl = 'wss://zcode.z.ai/ws',
    [string]$DataDir = (Join-Path $env:USERPROFILE '.zcode\tools\suian-zcode-gateway'),
    [string]$SkillsDir = (Join-Path $env:USERPROFILE '.zcode\skills')
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$relayVariable = 'ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL'
$configFile = Join-Path $DataDir 'config.json'
$config = if (Test-Path -LiteralPath $configFile) { Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
$restarting = $Action -eq 'Restart'
if ($restarting -and $null -eq $config) { throw 'Shared gateway is not installed; use Install first' }
if ($null -ne $config) {
    if ($config.version -ne 1) { throw 'Unsupported gateway config version' }
    if (-not $PSBoundParameters.ContainsKey('Port')) { $Port = $config.port }
    if (-not $PSBoundParameters.ContainsKey('UpstreamUrl')) { $UpstreamUrl = $config.upstream_url }
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$taskName = 'suian-zcode-gateway-' + $identity.User.Value
$task = Get-ScheduledTask | Where-Object { $_.TaskName -eq $taskName -and $_.TaskPath -eq '\' }
$property = (Get-ItemProperty -LiteralPath 'HKCU:\Environment').PSObject.Properties[$relayVariable]
$userRelay = if ($null -ne $property) { [string]$property.Value } else { $null }
$relayUrl = "ws://127.0.0.1:$Port/ws"
$healthUrl = "http://127.0.0.1:$Port/health"
$launcherFile = Join-Path $DataDir 'gateway-launch.vbs'
$scriptHost = Join-Path $env:SystemRoot 'System32\wscript.exe'
$vbsLauncher = $null -ne $task -and @($task.Actions)[0].Execute -eq $scriptHost
$taskRunning = $null -ne $task -and $task.State -eq 'Running'

function Read-GatewayHealth {
    param([switch]$AllowUnavailable)
    for ($queryAttempt = 0; $queryAttempt -lt 2; $queryAttempt++) {
        try { return Invoke-RestMethod -Uri $healthUrl -TimeoutSec $HealthTimeoutSec -UseBasicParsing }
        catch [Net.WebException] {
            if ($AllowUnavailable -and $_.Exception.Status -eq [Net.WebExceptionStatus]::ConnectFailure) { return $null }
            if ($_.Exception.Status -ne [Net.WebExceptionStatus]::Timeout) { throw }
            if ($queryAttempt -eq 1) { throw "Gateway health check timed out twice ($HealthTimeoutSec seconds per attempt); running state is unknown" }
        }
    }
}

function Wait-GatewayExit {
    for ($stopAttempt = 0; $stopAttempt -lt 40; $stopAttempt++) {
        $exitingTask = Get-ScheduledTask | Where-Object { $_.TaskName -eq $taskName -and $_.TaskPath -eq '\' }
        $remainingHealth = Read-GatewayHealth -AllowUnavailable
        if ($null -eq $remainingHealth -and ($null -eq $exitingTask -or $exitingTask.State -ne 'Running')) { return }
        Start-Sleep -Milliseconds 250
    }
    throw 'Gateway or launcher did not exit; configuration was not changed'
}

if ($Port -lt 1 -or $Port -gt 65535) { throw 'Invalid gateway port' }
if ($Action -eq 'Status') {
    $health = $null
    if ($null -ne $config) {
        $health = Read-GatewayHealth -AllowUnavailable
        if ($null -ne $health -and ($health.service -ne 'suian-zcode-gateway' -or $health.version -ne 1 -or $health.instance_id -ne $config.instance_id -or $health.upstream_url -ne $config.upstream_url)) { throw 'Gateway health does not match the installed configuration' }
    }
    [ordered]@{
        ok=$true; action='status'; configured=($null -ne $config); relay_url=$relayUrl; health_url=$healthUrl
        user_env_matches=($null -ne $config -and $userRelay -eq $relayUrl); gateway_running=($null -ne $health)
        task_running=$taskRunning; health_status=$(if ($null -eq $config) { 'not_configured' } elseif ($null -eq $health) { 'unreachable' } else { 'reachable' })
        vbs_launcher=$vbsLauncher; launcher_update_required=($null -ne $config -and (-not $vbsLauncher -or -not $taskRunning))
        desktop_connected=($null -ne $health -and $health.desktop_connected); upstream_connected=($null -ne $health -and $health.upstream_connected)
        paired=($null -ne $health -and $health.paired); restart_required=($null -ne $config -and ($null -eq $health -or -not $health.desktop_connected -or $userRelay -ne $relayUrl -or -not $vbsLauncher -or -not $taskRunning))
    } | ConvertTo-Json -Compress
    return
}
if ($Action -eq 'Remove') {
    if ($null -eq $config) { @{ ok=$true; action='not_installed' } | ConvertTo-Json -Compress; return }
    $health = Read-GatewayHealth -AllowUnavailable
    if ($taskRunning -and $null -eq $health) { throw 'Gateway task is running but health is unavailable; running state is unknown, configuration was not changed' }
    if ($null -ne $health) {
        if ($health.service -ne 'suian-zcode-gateway' -or $health.version -ne 1 -or $health.instance_id -ne $config.instance_id -or $health.upstream_url -ne $config.upstream_url) { throw 'Gateway health does not match the installed configuration' }
        if ($health.desktop_connected) { throw 'Finish running work and fully quit ZCode before removing the shared gateway' }
        $stopped = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/shutdown" -Method Post -Headers @{ Authorization=('Bearer ' + $config.control_token) } -TimeoutSec 5 -UseBasicParsing
        if (-not $stopped.ok) { throw 'Gateway did not accept shutdown' }
        Wait-GatewayExit
    }
    $environmentAction = 'preserved_external'
    if ($userRelay -eq $relayUrl) {
        if ($null -eq $config.previous_user_relay) { Remove-ItemProperty -LiteralPath 'HKCU:\Environment' -Name $relayVariable }
        else { New-ItemProperty -LiteralPath 'HKCU:\Environment' -Name $relayVariable -Value $config.previous_user_relay -PropertyType String -Force | Out-Null }
        $environmentAction = 'restored'
    }
    if ($null -ne $task) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }
    foreach ($skillName in @('suian-zcode-common', 'suian-zcode-gateway')) {
        $installedSkill = Join-Path $SkillsDir ($skillName + '\SKILL.md')
        if (Test-Path -LiteralPath $installedSkill) {
            $installed = Get-Content -LiteralPath $installedSkill -Raw -Encoding UTF8
            if ($installed.Contains(('**本机公共根**：`' + $config.gateway_root + '`')) -or $installed.Contains(('**本机网关根**：`' + $config.gateway_root + '`'))) { Remove-Item -LiteralPath $installedSkill }
        }
    }
    Remove-Item -LiteralPath $configFile
    if (Test-Path -LiteralPath $launcherFile) { Remove-Item -LiteralPath $launcherFile }
    [ordered]@{ ok=$true; action='removed'; user_env_action=$environmentAction; restart_required=$true } | ConvertTo-Json -Compress
    return
}

$upstream = [Uri]$UpstreamUrl
if (-not $upstream.IsAbsoluteUri -or ($upstream.Scheme -ne 'wss' -and -not ($upstream.Scheme -eq 'ws' -and $upstream.Host -eq '127.0.0.1')) -or $upstream.UserInfo -or $upstream.Query -or $upstream.Fragment) {
    throw 'Upstream must be a credential-free wss URL (or loopback ws for testing)'
}
$nodePath = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$nodeVersion = & $nodePath --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 24) { throw 'Node.js 24+ is required' }
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules\ws\package.json'))) { throw 'Run npm ci in suian-zcode-common first' }
$template = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'SKILL.md') -Raw -Encoding UTF8
$marker = '<!-- suian-zcode-common:root -->'
if (-not $template.Contains($marker)) { throw 'Gateway skill root marker is missing' }
$skill = $template.Replace($marker, ('**本机公共根**：`' + $PSScriptRoot + '`'))
$sha = [Security.Cryptography.SHA256]::Create()
try { $instanceId = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($PSScriptRoot.ToLowerInvariant())))).Replace('-', '').ToLowerInvariant() }
finally { $sha.Dispose() }

# 复用在运行的实例。修改地址或安装位置时不能悄悄切断 Desktop。
$health = $null
if ($null -ne $config -or $null -ne $task) { $health = Read-GatewayHealth -AllowUnavailable }
if ($taskRunning -and $null -eq $health) { throw 'Gateway task is running but health is unavailable; running state is unknown, configuration was not changed' }
if ($null -ne $health) {
    if ($restarting) {
        if ($health.service -ne 'suian-zcode-gateway' -or $health.version -ne 1 -or $health.instance_id -ne $config.instance_id -or $health.upstream_url -ne $config.upstream_url) { throw 'Gateway health does not match the installed configuration' }
        if ($health.desktop_connected) { throw 'Finish running work and fully quit ZCode before restarting the shared gateway' }
        $stopped = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/shutdown" -Method Post -Headers @{ Authorization=('Bearer ' + $config.control_token) } -TimeoutSec 5 -UseBasicParsing
        if (-not $stopped.ok) { throw 'Gateway did not accept shutdown' }
        Wait-GatewayExit
        $health = $null
    } elseif ($health.service -ne 'suian-zcode-gateway' -or $health.version -ne 1 -or $health.instance_id -ne $instanceId -or $health.upstream_url -ne $UpstreamUrl) {
        throw 'Running gateway differs from requested configuration; finish work, quit ZCode and use Restart to load the updated code'
    }
}
$previousRelay = if ($null -ne $config) { $config.previous_user_relay } else { $userRelay }
$controlToken = if ($null -ne $config) { $config.control_token } else { [Guid]::NewGuid().ToString('N') }
$nextConfig = [ordered]@{ version=1; gateway_root=$PSScriptRoot; instance_id=$instanceId; port=$Port; upstream_url=$UpstreamUrl; previous_user_relay=$previousRelay; control_token=$controlToken }
[IO.Directory]::CreateDirectory($DataDir) | Out-Null
[IO.File]::WriteAllText($configFile, ($nextConfig | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
if ($null -eq $health) {
    # EncodedCommand 避免安装路径中的空格、中文及单引号经过多层 shell。
    $runFile = (Join-Path $PSScriptRoot 'run.ps1').Replace("'", "''")
    $safeNode = $nodePath.Replace("'", "''")
    $safeData = $DataDir.Replace("'", "''")
    $launch = "& '$runFile' -NodePath '$safeNode' -DataDir '$safeData'"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($launch))
    $launcher = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'run.vbs') -Raw -Encoding UTF8
    [IO.File]::WriteAllText($launcherFile, $launcher, [Text.Encoding]::Unicode)
    $taskAction = New-ScheduledTaskAction -Execute $scriptHost -Argument ('//B //NoLogo "' + $launcherFile + '" ' + $encoded)
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
    $principal = New-ScheduledTaskPrincipal -UserId $identity.User.Value -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval ([TimeSpan]::FromMinutes(1)) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        try { $health = Read-GatewayHealth; break }
        catch [Net.WebException] {
            if ($_.Exception.Status -ne [Net.WebExceptionStatus]::ConnectFailure -or $attempt -eq 39) { throw }
            Start-Sleep -Milliseconds 250
        }
    }
    if ($health.service -ne 'suian-zcode-gateway' -or $health.version -ne 1 -or $health.instance_id -ne $instanceId -or $health.upstream_url -ne $UpstreamUrl) { throw 'Gateway health check returned a different instance; user environment was not changed' }
    $vbsLauncher = $true
    $taskRunning = $true
}
$skillDir = Join-Path $SkillsDir 'suian-zcode-common'
[IO.Directory]::CreateDirectory($skillDir) | Out-Null
[IO.File]::WriteAllText((Join-Path $skillDir 'SKILL.md'), $skill, (New-Object Text.UTF8Encoding($false)))
$legacySkillFile = Join-Path $SkillsDir 'suian-zcode-gateway\SKILL.md'
if ($null -ne $config -and (Test-Path -LiteralPath $legacySkillFile)) {
    $legacySkill = Get-Content -LiteralPath $legacySkillFile -Raw -Encoding UTF8
    if ($legacySkill.Contains(('**本机网关根**：`' + $config.gateway_root + '`'))) { Remove-Item -LiteralPath $legacySkillFile }
}
# 仅写用户级值；当前 Desktop 主进程不会重新读取。
New-ItemProperty -LiteralPath 'HKCU:\Environment' -Name $relayVariable -Value $relayUrl -PropertyType String -Force | Out-Null
[ordered]@{ ok=$true; action=$(if ($restarting) { 'restarted' } else { 'installed' }); relay_url=$relayUrl; health_url=$healthUrl; gateway_running=$true; task_running=$taskRunning; health_status='reachable'; desktop_connected=$health.desktop_connected; paired=$health.paired; vbs_launcher=$vbsLauncher; launcher_update_required=(-not $vbsLauncher -or -not $taskRunning); restart_required=(-not $health.desktop_connected -or -not $vbsLauncher -or -not $taskRunning) } | ConvertTo-Json -Compress

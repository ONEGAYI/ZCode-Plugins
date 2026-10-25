[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ToolsRoot,
    [Parameter(Mandatory)][string]$DataDir
)
$ErrorActionPreference = 'Stop'
# 健康门探测超时（秒）与日志留存窗口（天）：设计规格固定语义，无调用方传值需求
$healthGateTimeoutSec = 2
$logRetentionDays = 7
$activeFile = Join-Path $ToolsRoot 'active-gateway.json'
if (-not (Test-Path -LiteralPath $activeFile)) { [Console]::Error.WriteLine('No active gateway record; run setup.ps1 Install first'); exit 3 }
$active = Get-Content -LiteralPath $activeFile -Raw -Encoding UTF8 | ConvertFrom-Json
$gatewayFile = Join-Path (Join-Path $ToolsRoot ('deployments\' + $active.build_id)) 'gateway.mjs'
if (-not (Test-Path -LiteralPath $gatewayFile)) { [Console]::Error.WriteLine('Active gateway deployment is missing: ' + $gatewayFile); exit 4 }
[IO.Directory]::CreateDirectory($DataDir) | Out-Null
$configFile = Join-Path $DataDir 'config.json'

# 健康门（幂等第二层）：config 端口上的网关已健康时直接退出，配合任务 MultipleInstances IgnoreNew。
# fail-open：探测的一切异常（连接拒绝、超时、config 缺失或损坏、端口 0）都放行启动，不引入新的拉起阻塞。
try {
    $gateConfig = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $gatePort = [int]$gateConfig.port
    if ($gatePort -gt 0) {
        $gate = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/health" -f $gatePort) -TimeoutSec $healthGateTimeoutSec -UseBasicParsing
        if ($gate -and $gate.service -eq 'suian-zcode-gateway') { exit 0 }
    }
} catch {
    # fail-open：探测失败不阻断拉起
}

# 启动批次日志：logs/ 下按启动时间命名成对文件（文件名即启动时间与留存判定依据）。
# 只删严格匹配 gateway-<yyyyMMdd-HHmmss>.{out,error}.log 且早于窗口下限的文件；命名不合规的一律不动。
$logDir = Join-Path $DataDir 'logs'
[IO.Directory]::CreateDirectory($logDir) | Out-Null
$startedAt = Get-Date
$stamp = $startedAt.ToString('yyyyMMdd-HHmmss')
$retentionCutoff = $startedAt.AddDays(-1 * $logRetentionDays).ToString('yyyyMMdd-HHmmss')
foreach ($oldLog in @(Get-ChildItem -LiteralPath $logDir -Filter 'gateway-*.log' -File -ErrorAction SilentlyContinue)) {
    if ($oldLog.Name -match '^gateway-(\d{8}-\d{6})\.(out|error)\.log$' -and $Matches[1] -lt $retentionCutoff) {
        Remove-Item -LiteralPath $oldLog.FullName -Force -ErrorAction SilentlyContinue
    }
}
# 旧布局迁移：根目录单文件日志的正文早被历次启动截断覆盖，新命名首次运行时删除
foreach ($legacyLog in @('gateway.out.log', 'gateway.error.log')) {
    $legacyPath = Join-Path $DataDir $legacyLog
    if (Test-Path -LiteralPath $legacyPath) { Remove-Item -LiteralPath $legacyPath -Force -ErrorAction SilentlyContinue }
}

$arguments = @(('"' + $gatewayFile + '"'), '--config', ('"' + $configFile + '"'))
$gatewayProcess = Start-Process -FilePath $active.node_path -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $logDir ('gateway-' + $stamp + '.out.log')) -RedirectStandardError (Join-Path $logDir ('gateway-' + $stamp + '.error.log'))
exit $gatewayProcess.ExitCode

[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$NodePath,
    [Parameter(Mandatory)][string]$DataDir
)
$ErrorActionPreference = 'Stop'
$arguments = @(('"' + (Join-Path $PSScriptRoot 'gateway.mjs') + '"'), '--config', ('"' + (Join-Path $DataDir 'config.json') + '"'))
$gatewayProcess = Start-Process -FilePath $NodePath -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $DataDir 'gateway.out.log') -RedirectStandardError (Join-Path $DataDir 'gateway.error.log')
exit $gatewayProcess.ExitCode

Option Explicit
If WScript.Arguments.Count <> 1 Then WScript.Quit 2
Dim shell, powershell, command, exitCode
Set shell = CreateObject("WScript.Shell")
powershell = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")
command = Chr(34) & powershell & Chr(34) & " -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " & WScript.Arguments(0)
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode

@echo off
rem Register this node as Windows scheduled tasks. Settings come from
rem node.env beside this file.
rem
rem   litnode         the node (run-node.cmd)
rem   litnode-relay   the Agent Fighter relay, when AF_ROOT is set in node.env
rem   litnode-watch   the ledger watcher, when AF_ROOT is set
rem
rem Tasks run HEADLESS as this user (S4U logon: no password, no console
rem window — nothing to close by accident), start at logon and at boot,
rem never time out. Each wrapper loops, so a crash is back in 5 s. Run from
rem an ADMIN prompt. Logs: litnode.log, litnode-relay.log, af-watch.log.
cd /d "%~dp0"
if not exist node.env (echo node.env is missing - copy node.env.example to node.env first & pause & exit /b 1)
for /f "usebackq eol=# tokens=1,* delims==" %%k in ("node.env") do if not "%%k"=="" set "%%k=%%l"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$dir = '%~dp0'.TrimEnd('\');" ^
  "$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -Hidden -MultipleInstances IgnoreNew;" ^
  "$triggers = @((New-ScheduledTaskTrigger -AtLogOn), (New-ScheduledTaskTrigger -AtStartup));" ^
  "$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType S4U -RunLevel Highest;" ^
  "function Reg($name, $cmd) {" ^
  "  $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c \"' + $dir + '\' + $cmd + '\"') -WorkingDirectory $dir;" ^
  "  Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue;" ^
  "  Register-ScheduledTask -TaskName $name -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Force | Out-Null;" ^
  "  Start-ScheduledTask -TaskName $name; Start-Sleep -Seconds 2; Write-Host ('task ' + $name + ': ' + (Get-ScheduledTask -TaskName $name).State) }" ^
  "Reg 'litnode' 'run-node.cmd';" ^
  "if ('%AF_ROOT%' -ne '') { Reg 'litnode-relay' 'run-af-relay.cmd'; Reg 'litnode-watch' 'run-af-watch.cmd' } else { Write-Host 'AF_ROOT not set in node.env: relay and watcher tasks skipped' }"
if errorlevel 1 (echo. & echo  FAILED - run this from an administrator prompt. & pause & exit /b 1)
echo.
echo  The tasks run headless: there is no window. Use the logs and the cabinet.
echo  logs:    %~dp0litnode.log  litnode-relay.log  af-watch.log
echo  health:  http://localhost:7801/health     cabinet: http://localhost:7801/
echo  status:  schtasks /Query /TN litnode      (also litnode-relay, litnode-watch)
echo  stop:    schtasks /End /TN litnode        start: schtasks /Run /TN litnode
echo  remove:  schtasks /Delete /TN litnode /F
pause

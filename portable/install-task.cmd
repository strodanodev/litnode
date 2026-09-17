@echo off
rem Register this node as Windows scheduled tasks: starts at logon, restarts
rem if it dies, never times out. Settings come from node.env beside this file.
rem
rem   litnode         the node (run-node.cmd)
rem   litnode-relay   the Agent Fighter relay, when AF_ROOT is set in node.env
rem   litnode-watch   the ledger watcher, when AF_ROOT is set
rem
rem Run from an ADMIN prompt for the node (it runs elevated so its firewall
rem rule applies); the relay and watcher register for the current user.
cd /d "%~dp0"
if not exist node.env (echo node.env is missing - copy node.env.example to node.env first & pause & exit /b 1)
for /f "usebackq eol=# tokens=1,* delims==" %%k in ("node.env") do if not "%%k"=="" set "%%k=%%l"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$dir = '%~dp0'.TrimEnd('\');" ^
  "$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries;" ^
  "$trigger = New-ScheduledTaskTrigger -AtLogOn;" ^
  "function Reg($name, $cmd, $highest) {" ^
  "  $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c \"' + $dir + '\' + $cmd + '\"') -WorkingDirectory $dir;" ^
  "  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue;" ^
  "  if ($highest) { Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -Force | Out-Null }" ^
  "  else { Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null }" ^
  "  Start-ScheduledTask -TaskName $name; Start-Sleep -Seconds 2; Write-Host ('task ' + $name + ': ' + (Get-ScheduledTask -TaskName $name).State) }" ^
  "Reg 'litnode' 'run-node.cmd' $true;" ^
  "if ('%AF_ROOT%' -ne '') { Reg 'litnode-relay' 'run-af-relay.cmd' $false; Reg 'litnode-watch' 'run-af-watch.cmd' $false } else { Write-Host 'AF_ROOT not set in node.env: relay and watcher tasks skipped' }"
if errorlevel 1 (echo. & echo  FAILED - run this from an administrator prompt. & pause & exit /b 1)
echo.
echo  logs:    %~dp0litnode.log  litnode-relay.log  af-watch.log
echo  health:  http://localhost:7801/health
echo  status:  schtasks /Query /TN litnode      (also litnode-relay, litnode-watch)
echo  stop:    schtasks /End /TN litnode        remove: schtasks /Delete /TN litnode /F
pause

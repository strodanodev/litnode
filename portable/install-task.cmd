@echo off
rem Register this node as a Windows scheduled task: starts at logon, restarts
rem if it dies, never times out. Run from an ADMIN prompt. Settings come from
rem node.env beside this file.
cd /d "%~dp0"
if not exist node.env (echo node.env is missing - copy node.env.example to node.env first & pause & exit /b 1)
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$dir = '%~dp0'.TrimEnd('\');" ^
  "$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c \"' + $dir + '\run-node.cmd\"') -WorkingDirectory $dir;" ^
  "$trigger = New-ScheduledTaskTrigger -AtLogOn;" ^
  "$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries;" ^
  "Unregister-ScheduledTask -TaskName 'litnode' -Confirm:$false -ErrorAction SilentlyContinue;" ^
  "Register-ScheduledTask -TaskName 'litnode' -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -Force | Out-Null;" ^
  "Start-ScheduledTask -TaskName 'litnode';" ^
  "Start-Sleep -Seconds 3;" ^
  "$t = Get-ScheduledTask -TaskName 'litnode';" ^
  "Write-Host ('task litnode: ' + $t.State)"
if errorlevel 1 (echo. & echo  FAILED - run this from an administrator prompt. & pause & exit /b 1)
echo.
echo  log:     %~dp0litnode.log
echo  health:  http://localhost:7801/health
echo  status:  schtasks /Query /TN litnode
echo  stop:    schtasks /End /TN litnode        remove: schtasks /Delete /TN litnode /F
pause

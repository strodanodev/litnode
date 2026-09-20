@echo off
rem Stop the node for good: end the scheduled task's wrapper so it does not
rem relaunch, then end the node process by its recorded PID. Start again with
rem `schtasks /Run /TN litnode` (or start-node.cmd interactively). Run from an
rem ADMIN prompt when the task was installed.
cd /d "%~dp0"
if exist node.env for /f "usebackq eol=# tokens=1,* delims==" %%k in ("node.env") do if not "%%k"=="" set "%%k=%%l"
if "%DATA_DIR%"=="" set DATA_DIR=.\data\%OPERATOR%
schtasks /End /TN litnode >nul 2>nul && echo task litnode ended (wrapper) || echo task litnode not running or not registered
set PIDFILE=%DATA_DIR%\node.pid
if exist "%PIDFILE%" (
  for /f "usebackq" %%p in ("%PIDFILE%") do taskkill /PID %%p /F >nul 2>nul && echo node %%p ended || echo node %%p not running
  del "%PIDFILE%" >nul 2>nul
) else echo no %PIDFILE%: node not running on this build
pause

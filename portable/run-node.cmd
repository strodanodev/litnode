@echo off
rem Wrapper the scheduled task runs: no pause, plain one-line-per-event
rem output (no dashboard: there is no terminal), appended to litnode.log.
rem Loops: whatever ends the node — a crash, an update's restart — it is
rem back in 5 s. Task Scheduler's own "restart on failure" only covers a
rem failure to LAUNCH, so the wrapper does not rely on it.
cd /d "%~dp0"
set LITNODE_NOPAUSE=1
set LITNODE_PLAIN=1
:again
call start-node.cmd >> "%~dp0litnode.log" 2>&1
set "CODE=%errorlevel%"
rem 73: this node already runs under another launcher; 74: the port is taken.
rem Retrying every 5 s only fills the log: wait a minute, then take over if
rem the other one has gone.
set WAIT=5
if "%CODE%"=="73" set WAIT=60
if "%CODE%"=="74" set WAIT=60
echo [%date% %time%] node exited (%CODE%); restarting in %WAIT% s >> "%~dp0litnode.log"
timeout /t %WAIT% /nobreak >nul
goto again

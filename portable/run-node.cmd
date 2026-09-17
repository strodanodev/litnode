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
echo [%date% %time%] node exited (%errorlevel%); restarting in 5 s >> "%~dp0litnode.log"
timeout /t 5 /nobreak >nul
goto again

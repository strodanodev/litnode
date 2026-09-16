@echo off
rem Wrapper the scheduled task runs: no pause, log to litnode.log beside it.
cd /d "%~dp0"
set LITNODE_NOPAUSE=1
call start-node.cmd >> "%~dp0litnode.log" 2>&1

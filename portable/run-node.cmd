@echo off
rem Wrapper the scheduled task runs: no pause, plain one-line-per-event
rem output (no dashboard: there is no terminal), appended to litnode.log.
cd /d "%~dp0"
set LITNODE_NOPAUSE=1
set LITNODE_PLAIN=1
call start-node.cmd >> "%~dp0litnode.log" 2>&1

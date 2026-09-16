@echo off
rem Update this node from the latest signed release (github.com/strodanodev/litnode).
rem Verifies the release key's signature and the zip's sha256; replaces code,
rem keeps data\, node.env and the log. If the node is running under
rem start-node.cmd it relaunches itself; a scheduled task restarts on its own.
cd /d "%~dp0"
if exist "runtime\node.exe" (set "NODE=runtime\node.exe") else (set "NODE=node")
%NODE% tools\update.mjs %*
if "%errorlevel%"=="75" (
  if exist "runtime.new\node.exe" ( rmdir /s /q runtime 2>nul & move /y runtime.new runtime >nul )
  echo  updated. Restart the node ^(or it restarts itself if it was running^).
)
pause

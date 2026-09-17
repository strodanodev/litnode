@echo off
rem Settle Agent Fighter ledgers on this node as they land in the studio
rem database (tools/af-watch.mjs). Needs AF_ROOT in node.env (the checkout
rem with characters/ and .env). Logs beside this file; a scheduled task
rem restarts it if it dies.
cd /d "%~dp0"
for /f "usebackq eol=# tokens=1,* delims==" %%k in ("node.env") do if not "%%k"=="" set "%%k=%%l"
if "%AF_ROOT%"=="" (echo AF_ROOT is not set in node.env & exit /b 1)
if "%PORT%"=="" set PORT=7801
if exist "runtime\node.exe" (set "NODE=runtime\node.exe") else (set "NODE=node")
%NODE% tools\af-watch.mjs http://127.0.0.1:%PORT% >> "%~dp0af-watch.log" 2>&1

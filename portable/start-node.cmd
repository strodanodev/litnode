@echo off
setlocal EnableDelayedExpansion
rem litnode launcher (Windows). Uses runtime\node.exe when the zip ships one,
rem otherwise Node.js 20+ from PATH. Reads node.env (KEY=VALUE lines) beside
rem this file when present, so an operator machine starts without prompts;
rem otherwise asks two questions.
rem
rem First run: start this interactively (double-click) BEFORE install-task.cmd.
rem Windows shows its own "allow this app through the firewall" prompt the
rem first time an interactive program listens; a scheduled task never gets
rem that prompt. Or run allow-firewall.cmd once. Only nodes that peers must
rem reach (a seed, a LAN host, a relay) need either.
cd /d "%~dp0"
chcp 65001 >nul

if exist "runtime\node.exe" (set "NODE=runtime\node.exe") else (
  where node >nul 2>nul || (echo Node.js 20+ is required: winget install OpenJS.NodeJS.LTS  ^(or use the -win-x64 zip, which carries its own runtime^) & pause & exit /b 1)
  set "NODE=node"
)

if exist node.env (
  for /f "usebackq eol=# tokens=1,* delims==" %%k in ("node.env") do (
    if not "%%k"=="" set "%%k=%%l"
  )
)

if "%OPERATOR%"=="" set /p OPERATOR=Operator name (e.g. rog-ally):
if "%SEEDS%"=="" if not exist node.env set /p SEEDS=Seed node URL (e.g. http://192.168.1.8:7801, blank for none):
if "%PORT%"=="" set PORT=7801

rem Listen on every interface and advertise the LAN address so peers can reach us.
if "%HOST%"=="" set HOST=0.0.0.0
if "%PUBLIC_ADDR%"=="" (
  for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
    if not defined LANIP set LANIP=%%a
  )
  set LANIP=!LANIP: =!
  set PUBLIC_ADDR=http://!LANIP!:%PORT%
)

if "%RULESETS%"=="" set RULESETS=./rulesets/agent-fighter.v1.js,./rulesets/pickle-brawl.v1.js
if "%ROLES%"=="" set ROLES=mesh,host,witness,settler
if "%DATA_DIR%"=="" set DATA_DIR=./data/%OPERATOR%
if "%REGION%"=="" set REGION=lan

echo.
echo  litnode  operator=%OPERATOR%  addr=%PUBLIC_ADDR%  seeds=%SEEDS%  roles=%ROLES%
echo  dashboard: http://localhost:%PORT%/    keys: q quit  g gossip  l log  p pause
echo  If peers must reach this machine and /health says reachable: false, run allow-firewall.cmd once.
echo.
:run
%NODE% node\cli.mjs
if "%errorlevel%"=="75" (
  rem The node updated itself (or update.cmd ran) and asked to be relaunched.
  if exist "runtime.new\node.exe" (
    rmdir /s /q runtime 2>nul
    move /y runtime.new runtime >nul
    set "NODE=runtime\node.exe"
  )
  echo  restarting on the new build...
  goto run
)
if not "%LITNODE_NOPAUSE%"=="1" pause

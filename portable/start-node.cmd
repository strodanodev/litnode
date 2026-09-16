@echo off
setlocal EnableDelayedExpansion
rem litnode portable launcher (Windows). Needs Node.js 20+ on PATH.
rem Reads node.env (KEY=VALUE lines) beside this file when present, so an
rem operator machine starts without prompts; otherwise asks two questions.
cd /d "%~dp0"

where node >nul 2>nul || (echo Node.js 20+ is required. Install: winget install OpenJS.NodeJS.LTS & pause & exit /b 1)

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
echo  If peers cannot reach this machine, allow TCP %PORT% once (admin):
echo    netsh advfirewall firewall add rule name="litnode %PORT%" dir=in action=allow protocol=TCP localport=%PORT%
echo.
node node\cli.mjs
if not "%LITNODE_NOPAUSE%"=="1" pause

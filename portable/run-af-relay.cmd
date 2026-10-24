@echo off
rem The Agent Fighter relay (match server) on this machine, for the node's
rem RELAY_PORT tunnel to front. Reads AF_ROOT and RELAY_PORT from node.env,
rem loads the AF checkout's .env (SUPABASE_URL, SUPABASE_SERVICE_KEY, ...) into
rem the environment, runs `npm run server` there, and logs beside this file.
rem Loops so a crash is back in 5 s; replaces an orphaned earlier instance
rem (a closed terminal) instead of failing on the port.
rem
rem Nothing else in node.env reaches the relay: those are the NODE's settings.
rem Loading all of them once pinned the relay's AIR guard to the arcade's
rem AIR_PARTNER_ID and 401'd every agentfighter.wtf sign-in (23 Oct 2026); a
rem title's process takes an allowlist of the node's environment, as gauntlet
rem servers do (node/gauntlet.js INHERITED_ENV). The relay's own values live in
rem AF_ROOT\.env.
cd /d "%~dp0"
for /f "usebackq eol=# tokens=1,* delims==" %%k in ("node.env") do (
  if /i "%%k"=="AF_ROOT" set "AF_ROOT=%%l"
  if /i "%%k"=="RELAY_PORT" set "RELAY_PORT=%%l"
)
if "%AF_ROOT%"=="" (echo AF_ROOT is not set in node.env & exit /b 1)
if not exist "%AF_ROOT%\.env" (echo %AF_ROOT%\.env not found & exit /b 1)
for /f "usebackq eol=# tokens=1,* delims==" %%k in ("%AF_ROOT%\.env") do if not "%%k"=="" set "%%k=%%l"
if "%RELAY_PORT%"=="" set RELAY_PORT=8477
set PORT=%RELAY_PORT%
set LOG=%~dp0litnode-relay.log
:again
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"
cd /d "%AF_ROOT%"
echo [%date% %time%] relay starting on :%PORT% >> "%LOG%"
call npm run server >> "%LOG%" 2>&1
echo [%date% %time%] relay exited (%errorlevel%); restarting in 5 s >> "%LOG%"
timeout /t 5 /nobreak >nul
goto again

@echo off
rem The Agent Fighter relay (match server) on this machine, for the node's
rem RELAY_PORT tunnel to front. Reads AF_ROOT from node.env, loads the AF
rem checkout's .env (SUPABASE_URL, SUPABASE_SERVICE_KEY, ...) into the
rem environment, runs `npm run server` there, and logs beside this file.
rem Loops so a crash is back in 5 s; replaces an orphaned earlier instance
rem (a closed terminal) instead of failing on the port.
cd /d "%~dp0"
for /f "usebackq eol=# tokens=1,* delims==" %%k in ("node.env") do if not "%%k"=="" set "%%k=%%l"
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

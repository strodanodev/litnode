@echo off
rem Restart the node that the scheduled task runs, on the current code — how
rem an update or a changed node.env takes effect. First it asks the node to
rem exit (POST /restart on localhost: no admin needed, and it reaches a node
rem that was started elevated). A node too old to answer is ended by the PID
rem it recorded in data\<operator>\node.pid, which needs an ADMIN prompt when
rem the task was installed. Either way the task's wrapper brings it back.
cd /d "%~dp0"
if exist node.env for /f "usebackq eol=# tokens=1,* delims==" %%k in ("node.env") do if not "%%k"=="" set "%%k=%%l"
if "%PORT%"=="" set PORT=7801
powershell -NoProfile -Command "try { Invoke-RestMethod -Method Post -Uri http://127.0.0.1:%PORT%/restart -TimeoutSec 5 | Out-Null; exit 0 } catch { exit 1 }"
if not errorlevel 1 (echo node on :%PORT% is restarting; the task wrapper brings it back within a minute & pause & exit /b 0)
if "%DATA_DIR%"=="" set DATA_DIR=.\data\%OPERATOR%
set PIDFILE=%DATA_DIR%\node.pid
if not exist "%PIDFILE%" (echo the node on :%PORT% did not answer and there is no %PIDFILE% - is it running? & pause & exit /b 1)
set /p NODEPID=<"%PIDFILE%"
taskkill /PID %NODEPID% /F >nul 2>nul && (echo node %NODEPID% ended; the task wrapper restarts it in 5 s) || (echo could not end PID %NODEPID% - run from an administrator prompt & pause & exit /b 1)
pause

@echo off
rem Restart the node that the scheduled task runs. Ends the node PROCESS (the
rem PID it recorded in data\<operator>\node.pid); the task's wrapper loop
rem brings it back in 5 s on the current code — which is how an update or a
rem changed node.env takes effect. If the task was installed (RunLevel
rem Highest), run this from an ADMIN prompt.
cd /d "%~dp0"
if exist node.env for /f "usebackq eol=# tokens=1,* delims==" %%k in ("node.env") do if not "%%k"=="" set "%%k=%%l"
if "%DATA_DIR%"=="" set DATA_DIR=.\data\%OPERATOR%
set PIDFILE=%DATA_DIR%\node.pid
if not exist "%PIDFILE%" (echo no %PIDFILE% - is the node running on this build? & pause & exit /b 1)
set /p NODEPID=<"%PIDFILE%"
taskkill /PID %NODEPID% /F >nul 2>nul && (echo node %NODEPID% ended; the task wrapper restarts it in 5 s) || (echo could not end PID %NODEPID% - run from an administrator prompt & pause & exit /b 1)
pause

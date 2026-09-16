@echo off
rem Allow peers to reach this node (inbound). One UAC click; run once.
rem
rem Who needs this: a seed, a LAN host, or a relay — a node other machines
rem must connect TO. A volunteer/witness that only reaches outward does not:
rem gossip replies carry everything it needs. A public node behind a tunnel
rem (cloudflared) dials out too, and needs no rule either.
rem
rem What it adds: a PROGRAM rule for this folder's runtime, not a port rule,
rem so it follows the node whatever port it listens on and covers nothing
rem else. Private and domain profiles only; public networks stay closed.
setlocal
cd /d "%~dp0"
if exist "runtime\node.exe" (set "EXE=%~dp0runtime\node.exe") else (for /f "delims=" %%p in ('where node 2^>nul') do if not defined EXE set "EXE=%%p")
if not defined EXE (echo No node.exe found: expected runtime\node.exe beside this file, or Node.js on PATH. & pause & exit /b 1)

net session >nul 2>&1
if errorlevel 1 (
  echo Asking for administrator rights to add a firewall rule for:
  echo   %EXE%
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs -ArgumentList '/elevated'"
  exit /b 0
)

netsh advfirewall firewall delete rule name="litnode" >nul 2>&1
netsh advfirewall firewall add rule name="litnode" dir=in action=allow program="%EXE%" enable=yes profile=private,domain description="litnode mesh node: peers may connect inbound" >nul
if errorlevel 1 (echo FAILED to add the rule. & pause & exit /b 1)
echo.
echo  Firewall rule "litnode" added for %EXE% (private + domain networks).
echo  Remove later with:  netsh advfirewall firewall delete rule name="litnode"
echo.
if "%1"=="/elevated" pause

@echo off
rem Retired: Agent Fighter's relay no longer reports to the mesh, so there is
rem no ledger watcher (tools/af-watch.mjs is gone). This stub replaces the old
rem looping wrapper so a leftover litnode-watch task stops instead of retrying
rem a missing script every 5 s. It tries to delete its own task; when that
rem needs admin, run install-task.cmd again from an admin prompt to remove it.
schtasks /Delete /TN litnode-watch /F >nul 2>&1
exit /b 0

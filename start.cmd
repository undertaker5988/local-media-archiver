@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required.
  pause
  exit /b 1
)
echo Starting Media Archive Workbench at http://127.0.0.1:4318
set OPEN_BROWSER=1
node src\server.mjs

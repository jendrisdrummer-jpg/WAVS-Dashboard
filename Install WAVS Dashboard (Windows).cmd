@echo off
rem Double-click me (once) to make the WAVS Dashboard start by itself whenever you sign in to Windows.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js isn't installed. Get the LTS version from https://nodejs.org and run this again. & start https://nodejs.org & pause & exit /b 1)
call npm install --no-audit --no-fund || (pause & exit /b 1)
node scripts\service.mjs install && start http://localhost:8080
pause

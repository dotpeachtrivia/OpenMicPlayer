@echo off
cd /d "%~dp0"
where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed yet.
  echo Get the LTS installer from https://nodejs.org , install it, then run this file again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo First run: downloading the app's components. This needs internet and takes a minute or two.
  call npm install
)
call npm start

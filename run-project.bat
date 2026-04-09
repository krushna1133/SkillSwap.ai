@echo off
setlocal
cd /d "%~dp0"

where bash >nul 2>nul
if %errorlevel% neq 0 (
  echo Git Bash is not available in PATH.
  echo Install Git for Windows, then run this file again.
  pause
  exit /b 1
)

bash "%~dp0run-project.sh"

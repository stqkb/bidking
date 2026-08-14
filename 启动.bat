@echo off
setlocal
cd /d "%~dp0"

rem ===== find python =====
set "PY="
where python >nul 2>nul
if not errorlevel 1 set "PY=python"
if not defined PY if exist "C:\Users\Q3243\AppData\Local\Programs\Python\Python311\python.exe" set "PY=C:\Users\Q3243\AppData\Local\Programs\Python\Python311\python.exe"
if not defined PY if exist "C:\Users\Q3243\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" set "PY=C:\Users\Q3243\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if not defined PY (
  echo [ERROR] Python 3.11+ not found. Please install Python or edit this file.
  pause
  exit /b 1
)

echo ============================================
echo  BidKing Assistant - Auction Valuation
echo  Starting ... browser will open automatically.
echo  URL: http://127.0.0.1:8000
echo  Close this window to stop the app.
echo ============================================

"%PY%" backend\run.py
pause

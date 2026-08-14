@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Checking image gallery similarity distribution...
echo First run takes about 1-2 minutes, please wait...
"C:\Users\Q3243\AppData\Local\Programs\Python\Python311\python.exe" "%~dp0visual_check.py"
echo.
pause

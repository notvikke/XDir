@echo off
setlocal
cd /d "%~dp0"

set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
if not exist "%PYTHON_EXE%" (
  echo Python 3.13 runtime not found at "%PYTHON_EXE%"
  exit /b 1
)

"%PYTHON_EXE%" -m PyInstaller --noconfirm --clean XDir.spec
if errorlevel 1 exit /b %errorlevel%

echo.
echo Release build complete:
echo   %CD%\dist\XDir\XDir.exe

@echo off
setlocal
cd /d "%~dp0"

set "DIST_DIR=%CD%\dist"
set "APP_DIR=%DIST_DIR%\XDir"
set "ZIP_PATH=%DIST_DIR%\XDir-0.1.1-windows.zip"

set "PYTHON_CMD="
if defined PYTHON_EXE if exist "%PYTHON_EXE%" set "PYTHON_CMD=%PYTHON_EXE%"
if not defined PYTHON_CMD if exist "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" set "PYTHON_CMD=%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
if not defined PYTHON_CMD if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set "PYTHON_CMD=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not defined PYTHON_CMD if exist "%LOCALAPPDATA%\Programs\Python\Python311\python.exe" set "PYTHON_CMD=%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
if not defined PYTHON_CMD (
  where py >nul 2>nul && set "PYTHON_CMD=py -3"
)
if not defined PYTHON_CMD (
  where python >nul 2>nul && set "PYTHON_CMD=python"
)

if not defined PYTHON_CMD (
  echo Python was not found. Set PYTHON_EXE or install Python 3.11+ to build a release.
  exit /b 1
)

if exist "%CD%\build\XDir" rmdir /s /q "%CD%\build\XDir"
if exist "%APP_DIR%" rmdir /s /q "%APP_DIR%"
if exist "%ZIP_PATH%" del /f /q "%ZIP_PATH%"

call %PYTHON_CMD% -m PyInstaller --noconfirm --clean XDir.spec
if errorlevel 1 exit /b %errorlevel%

if exist "%APP_DIR%\cache" rmdir /s /q "%APP_DIR%\cache"
if exist "%APP_DIR%\backend\library.db" del /f /q "%APP_DIR%\backend\library.db"
if exist "%APP_DIR%\backend\settings.json" del /f /q "%APP_DIR%\backend\settings.json"

powershell -NoProfile -Command "Compress-Archive -Path '%APP_DIR%\*' -DestinationPath '%ZIP_PATH%' -Force"
if errorlevel 1 exit /b %errorlevel%

echo.
echo Release build complete:
echo   %APP_DIR%\XDir.exe
echo   %ZIP_PATH%

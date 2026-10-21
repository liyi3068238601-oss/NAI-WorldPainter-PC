@echo off
setlocal
set "UIUX_DESKTOP=%~dp0desktop"
if not exist "%UIUX_DESKTOP%\node_modules\electron\dist\electron.exe" (
  echo Missing Electron dependency. Install dependencies in desktop first.
  if not "%~1"=="--smoke" pause
  exit /b 1
)
set "NODE_OPTIONS="
set "ELECTRON_RUN_AS_NODE=1"
"%UIUX_DESKTOP%\node_modules\electron\dist\electron.exe" "%UIUX_DESKTOP%\scripts\start-isolated-uiux.cjs" %*
set "UIUX_EXIT=%ERRORLEVEL%"
if not "%UIUX_EXIT%"=="0" if not "%~1"=="--smoke" pause
exit /b %UIUX_EXIT%

@echo off
setlocal
cd /d "%~dp0"
echo Building TEST03 safe-spawn level...
node node_modules\tsx\dist\cli.mjs src\beamng-v4\build-test03-cli.ts
if errorlevel 1 (
  echo.
  echo FAILED: test03 build did not complete.
  exit /b 1
)
echo.
echo SUCCESS: test03.zip generated and installed.
endlocal

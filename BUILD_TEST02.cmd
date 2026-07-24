@echo off
setlocal
cd /d "%~dp0"
echo Building TEST02 Y-frame corrected level...
node node_modules\tsx\dist\cli.mjs src\beamng-v4\build-test02-cli.ts
if errorlevel 1 (
  echo.
  echo FAILED: TEST02 build did not complete.
  exit /b 1
)
echo.
echo SUCCESS: test02.zip generated and installed.
endlocal

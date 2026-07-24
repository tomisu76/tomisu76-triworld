@echo off
setlocal
cd /d "%~dp0"
echo Building TEST04 terrain-only collision isolation level...
node node_modules\tsx\dist\cli.mjs src\beamng-v4\build-test04-cli.ts
if errorlevel 1 (
  echo.
  echo FAILED: TEST04 build did not complete.
  exit /b 1
)
echo.
echo SUCCESS: test04.zip generated and installed.
endlocal

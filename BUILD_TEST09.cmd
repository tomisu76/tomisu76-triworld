@echo off
setlocal
cd /d "%~dp0"
echo Building TEST09 controlled 180-degree runtime-frame level...
node node_modules\tsx\dist\cli.mjs src\beamng-v4\build-test09-cli.ts
if errorlevel 1 (
  echo.
  echo FAILED: TEST09 build did not complete.
  exit /b 1
)
echo.
echo SUCCESS: test09.zip generated and installed.
endlocal

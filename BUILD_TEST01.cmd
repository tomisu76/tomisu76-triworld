@echo off
setlocal
cd /d "%~dp0"
echo Building isolated BeamNG level test01...
node node_modules\tsx\dist\cli.mjs src\beamng-v4\build-test01-cli.ts
if errorlevel 1 (
  echo.
  echo FAILED: test01 build did not complete.
  exit /b 1
)
echo.
echo SUCCESS: test01.zip generated and installed.
endlocal

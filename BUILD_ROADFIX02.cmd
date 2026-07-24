@echo off
setlocal
cd /d "%~dp0"

echo Building ROADFIX02 orthophoto-aligned terrain-projected road level...
node node_modules\tsx\dist\cli.mjs src\beamng-v4\build-roadfix02-cli.ts
if errorlevel 1 (
  echo.
  echo FAILED: ROADFIX02 build did not complete.
  exit /b 1
)

echo.
echo SUCCESS: roadfix02.zip generated and installed.
endlocal

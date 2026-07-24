@echo off
setlocal
cd /d "%~dp0"
echo Building isolated Gate 4 runtime-frame corrected level...
node node_modules\tsx\dist\cli.mjs src\beamng-v4\build-gate4-framefixed1-cli.ts
if errorlevel 1 (
  echo.
  echo FAILED: frame-fixed Gate 4 build did not complete.
  exit /b 1
)
echo.
echo SUCCESS: triworld_v4_gate4_framefixed1.zip generated and installed.
endlocal

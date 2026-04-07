@echo off
title D&D Scribe Bot — Test Suite
echo.
echo ======================================
echo   D^&D Scribe Bot - Running Tests
echo ======================================
echo.

cd /d "%~dp0"
node tests/run-all.js

echo.
if %ERRORLEVEL% NEQ 0 (
    echo [FAIL] Some tests failed. See output above.
) else (
    echo [PASS] All tests passed!
)
echo.
pause

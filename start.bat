@echo off
echo ========================================
echo Antigravity2API Start Script
echo ========================================
echo.

echo [1/2] Installing dependencies...
call npm install
if errorlevel 1 (
    echo Failed to install dependencies
    pause
    exit /b 1
)

echo.
echo [2/2] Starting service...
call npm start

if errorlevel 1 (
    echo.
    echo Service stopped with error
    pause
)

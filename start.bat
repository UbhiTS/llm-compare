@echo off
cd /d "%~dp0"
echo Installing dependencies (first run may take a minute)...
call npm install --no-audit --no-fund
echo.
echo Starting LLM Agent Arena on http://localhost:8080 ...
call npm start

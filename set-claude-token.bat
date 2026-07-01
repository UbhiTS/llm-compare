@echo off
cd /d "%~dp0"
echo Getting a Google Cloud access token for Claude...
for /f "usebackq delims=" %%i in (`gcloud auth print-access-token`) do set TOKEN=%%i
if "%TOKEN%"=="" ( echo Could not get a token. Is gcloud installed and authenticated? & pause & exit /b 1 )
powershell -NoProfile -Command "(Get-Content .env) -replace '^CLAUDE_BEARER_TOKEN=.*', 'CLAUDE_BEARER_TOKEN=%TOKEN%' | Set-Content .env"
echo Done. Token written to .env (valid ~1 hour).
pause

@echo off
title D&D Scribe Bot - First Time Setup
color 0E
echo.
echo   ==========================================
echo     D^&D Scribe Bot - First Time Setup
echo   ==========================================
echo.
echo   This wizard will help you set up everything
echo   you need to run the D^&D Scribe Bot.
echo.

cd /d "%~dp0"

:: ── Step 1: Check Node.js ────────────────────────────────────
echo [Step 1/6] Checking Node.js...
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo   Node.js is NOT installed!
    echo   Please install Node.js 18+ from: https://nodejs.org
    echo   After installing, close this window and run setup again.
    echo.
    start https://nodejs.org
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo   Found Node.js %%v
echo.

:: ── Step 2: Check ffmpeg ─────────────────────────────────────
echo [Step 2/6] Checking ffmpeg...
where ffmpeg >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo   ffmpeg is NOT installed!
    echo   ffmpeg is required for audio recording.
    echo.
    echo   Install options:
    echo     1. Run: winget install ffmpeg
    echo     2. Or download from: https://ffmpeg.org/download.html
    echo.
    echo   See SETUP.md Section 8 for detailed instructions.
    echo.
    set /p "CONTINUE=Continue anyway? (y/n): "
    if /i not "%CONTINUE%"=="y" (
        exit /b 1
    )
) else (
    echo   ffmpeg found!
)
echo.

:: ── Step 3: Install dependencies ─────────────────────────────
echo [Step 3/6] Installing Node.js dependencies...
echo   This may take 1-2 minutes...
echo.
call npm install
if %errorlevel% neq 0 (
    echo.
    echo   [WARNING] Some packages may have failed.
    echo   Trying with fallback options...
    call npm install --ignore-optional
    call npm install libsodium-wrappers
)
echo.
echo   Dependencies installed!
echo.

:: ── Step 4: Create .env file ─────────────────────────────────
echo [Step 4/6] Setting up configuration...
if exist ".env" (
    echo   .env file already exists - skipping.
) else (
    copy .env.example .env >nul
    echo   Created .env from template.
)
echo.

:: ── Step 5: Guide API key setup ──────────────────────────────
echo [Step 5/6] API Key Setup
echo.
echo   You need at least these two keys to use the bot:
echo.
echo   1. DISCORD BOT TOKEN
echo      - Go to: https://discord.com/developers/applications
echo      - Create a New Application ^> Bot ^> Copy Token
echo      - See SETUP.md Sections 2-4 for full instructions
echo.
echo   2. ANTHROPIC API KEY (for story generation)
echo      - Go to: https://console.anthropic.com
echo      - Create an API key (starts with sk-ant-)
echo      - See SETUP.md Section 5
echo.
echo   Optional (for speaker identification):
echo   3. AssemblyAI key: https://assemblyai.com
echo   4. Deepgram key: https://deepgram.com
echo.
echo   Opening .env file for you to add your keys...
echo.
start notepad ".env"
echo   Add your keys to the .env file, save, and close Notepad.
echo.
pause

:: ── Step 6: Create directories ───────────────────────────────
echo.
echo [Step 6/6] Creating directories...
if not exist "recordings" mkdir recordings
if not exist "transcripts" mkdir transcripts
if not exist "stories" mkdir stories
if not exist "lore" mkdir lore
if not exist "logs" mkdir logs
echo   All directories ready!

:: ── Done ─────────────────────────────────────────────────────
echo.
echo   ==========================================
echo     Setup Complete!
echo   ==========================================
echo.
echo   Next steps:
echo     1. Make sure your .env has valid API keys
echo     2. Double-click start.bat to launch the dashboard
echo     3. The dashboard opens at http://localhost:3000
echo     4. Use the dashboard to start the bot and manage sessions
echo.
echo   For detailed instructions, read SETUP.md
echo.
pause

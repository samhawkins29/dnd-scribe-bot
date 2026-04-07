# D&D Scribe Bot — Setup Guide

A Discord bot that records your D&D sessions, transcribes them, and transforms them into narrative prose chapters in the style of George R.R. Martin or Brandon Sanderson.

---

## Quick Relaunch

Everything is already installed and configured. To get the bot running again:

1. Open **Command Prompt** (or Windows Terminal).
2. Navigate to the project folder:
   ```
   cd C:\Users\samha\Desktop\dnd-scribe-bot
   ```
3. Start the bot:
   ```
   node bot.js
   ```
   Or double-click `start.bat`.
4. **Keep the terminal window open** while the bot is running. Closing it kills the bot.
5. In Discord, join a voice channel, then type `!record` in any text channel to start recording.
6. When the session is over, type `!stop`. The bot will save the audio, transcribe it via AssemblyAI, and generate a story chapter automatically. The story is posted directly to your Discord recap channel (any channel with "recap" in the name, configurable via `RECAP_CHANNEL_NAME` in `.env`).
7. To re-read the latest story, type `!recap` or use `/recap` in any text channel.

To process a recording manually (if the auto-pipeline didn't run):
```
node run-pipeline.js --latest --style martin
```

---

## Current Status

**Bot:** Edward Grimes#9793 (Client ID: 1489376430587510805)

**Working:**
- Discord bot comes online and responds to `!record` / `!stop` / `!recap` / `/record` / `/stop` / `/recap`
- Generated stories are automatically posted to the Discord recap channel as rich embeds
- Voice recording captures all users in the channel with silence-padded timing
- Audio mixing via ffmpeg (v4.4.2 installed)
- AssemblyAI cloud transcription with speaker diarization
- Claude story generation via Anthropic API
- Campaign context loaded (Caves of Chaos — Thrain Ironwatch, Countess Caith)

**Not working:**
- Local Whisper transcription — Windows Application Control (WDAC/Smart App Control) blocks PyTorch `.pyd` files from loading. Use AssemblyAI instead (set `TRANSCRIPTION_SERVICE=assemblyai` in `.env`, which is already configured).

**Environment:**
- Node.js v24.14.0
- ffmpeg v4.4.2
- npm packages installed
- `.env` configured with Discord token, Anthropic API key, and AssemblyAI API key

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Create a Discord Bot](#2-create-a-discord-bot)
3. [Get Your Bot Token](#3-get-your-bot-token)
4. [Invite the Bot to Your Server](#4-invite-the-bot-to-your-server)
5. [Get an Anthropic API Key](#5-get-an-anthropic-api-key)
6. [Get Transcription API Keys (Optional)](#6-get-transcription-api-keys-optional)
7. [Install Whisper Locally (Optional)](#7-install-whisper-locally-optional)
8. [Install ffmpeg on Windows](#8-install-ffmpeg-on-windows)
9. [Install Dependencies](#9-install-dependencies)
10. [Configure Your Settings](#10-configure-your-settings)
11. [Run the Bot](#11-run-the-bot)
12. [Using the Bot in Discord](#12-using-the-bot-in-discord)
13. [Running the Pipeline Manually](#13-running-the-pipeline-manually)
14. [Running as a Windows Service](#14-running-as-a-windows-service)
15. [Setting Up a Dispatch Scheduled Task](#15-setting-up-a-dispatch-scheduled-task)
16. [Troubleshooting](#16-troubleshooting)

---

## 1. Prerequisites

You need the following installed on your system:

**Required:**
- **Node.js 18+** — Download from [nodejs.org](https://nodejs.org/). LTS version recommended. Verify with `node --version`.
- **npm** — Comes with Node.js. Verify with `npm --version`.
- **ffmpeg** — Required for audio mixing. See [Section 8](#8-install-ffmpeg-on-windows) for Windows installation.

**Optional (depending on your transcription choice):**
- **Python 3.8+** — Only needed if using local Whisper. Download from [python.org](https://www.python.org/downloads/).

---

## 2. Create a Discord Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications).
2. Click **"New Application"** in the top right.
3. Name it something like "D&D Scribe Bot" and click **Create**.
4. You'll land on the **General Information** page. Note the **Application ID** — this is your `DISCORD_CLIENT_ID`.
5. In the left sidebar, click **"Bot"**.
6. Click **"Add Bot"** and confirm.
7. Under the bot settings:
   - Optionally set a profile picture (a quill, a book, whatever fits your campaign).
   - Under **Privileged Gateway Intents**, enable:
     - **Message Content Intent** (required for `!record` and `!stop` prefix commands)
     - **Server Members Intent** (optional but helpful)
   - Click **Save Changes**.

---

## 3. Get Your Bot Token

1. Still on the **Bot** page in the Developer Portal.
2. Click **"Reset Token"** (or **"Copy"** if the token is still visible).
3. **Copy the token immediately** — you won't be able to see it again without resetting.
4. **Never share this token.** Anyone with it can control your bot.
5. Save it somewhere safe for now; you'll put it in your `.env` file in step 10.

---

## 4. Invite the Bot to Your Server

1. In the Developer Portal, go to **OAuth2 > URL Generator** in the left sidebar.
2. Under **Scopes**, check:
   - `bot`
   - `applications.commands`
3. Under **Bot Permissions**, check:
   - Send Messages
   - Embed Links
   - Connect (voice)
   - Speak (voice)
   - Use Voice Activity
4. Copy the generated URL at the bottom.
5. Paste it into your browser.
6. Select the Discord server you want to add the bot to.
7. Click **Authorize** and complete the CAPTCHA.
8. The bot should now appear in your server's member list (offline until you start it).

If you want to restrict slash commands to a single server for faster registration, note the **Server ID**: right-click the server icon in Discord, click "Copy Server ID" (you may need to enable Developer Mode in Discord settings under Advanced).

---

## 5. Get an Anthropic API Key

The story generator uses Claude via the Anthropic API.

1. Go to [console.anthropic.com](https://console.anthropic.com/).
2. Create an account or sign in.
3. Navigate to **API Keys** in the sidebar.
4. Click **"Create Key"** and give it a name like "DnD Scribe Bot".
5. Copy the key (starts with `sk-ant-`).
6. You'll need to add credits to your account. Story generation typically uses the Claude Sonnet model and costs roughly $0.01-0.05 per chapter depending on transcript length.

---

## 6. Get Transcription API Keys (Optional)

If you want speaker diarization (identifying which player said what), use one of the cloud services. Otherwise, skip to Section 7 for free local transcription.

**AssemblyAI:**
1. Go to [assemblyai.com](https://www.assemblyai.com/) and create an account.
2. Your API key is on the dashboard immediately after signing up.
3. Free tier includes several hours of transcription.

**Deepgram:**
1. Go to [deepgram.com](https://deepgram.com/) and create an account.
2. Navigate to **API Keys** in the console.
3. Create a new key.
4. Free tier includes $200 in credits (a lot of transcription).

---

## 7. Install Whisper Locally (Optional)

Whisper is OpenAI's free, open-source speech-to-text model. It runs locally (no API key needed) but doesn't support speaker diarization.

**Python Whisper (easier):**
```bash
pip install openai-whisper
```

This installs the `whisper` command. To test: `whisper --help`

Model sizes (downloaded automatically on first use):
- `tiny` — Fastest, least accurate (~1GB VRAM)
- `base` — Good balance (~1GB VRAM)
- `small` — Better accuracy (~2GB VRAM)
- `medium` — High accuracy (~5GB VRAM)
- `large` — Best accuracy (~10GB VRAM)

**Whisper.cpp (faster, C++ implementation):**
1. Download the latest release from [github.com/ggerganov/whisper.cpp/releases](https://github.com/ggerganov/whisper.cpp/releases).
2. Download a model file (e.g., `ggml-base.en.bin`) from the same releases page.
3. Set `WHISPER_BINARY` to the path of the whisper.cpp executable.
4. Set `WHISPER_CPP_MODEL` to the path of the `.bin` model file.

---

## 8. Install ffmpeg on Windows

ffmpeg is required for mixing audio streams.

**Option A — winget (simplest):**
```powershell
winget install ffmpeg
```

**Option B — Chocolatey:**
```powershell
choco install ffmpeg
```

**Option C — Manual:**
1. Go to [ffmpeg.org/download.html](https://ffmpeg.org/download.html).
2. Under "Windows", click the **Windows builds by BtbN** link.
3. Download `ffmpeg-master-latest-win64-gpl.zip`.
4. Extract the zip.
5. Copy the `bin` folder contents (`ffmpeg.exe`, `ffprobe.exe`, `ffplay.exe`) to a permanent location like `C:\ffmpeg\bin\`.
6. Add that folder to your system PATH:
   - Search "Environment Variables" in Start.
   - Under System Variables, find `Path`, click Edit.
   - Add a new entry: `C:\ffmpeg\bin`
   - Click OK.
7. Open a **new** terminal and verify: `ffmpeg -version`

---

## 9. Install Dependencies

Open a terminal in the project directory and run:

```bash
cd C:\Users\samha\Desktop\dnd-scribe-bot
npm install
```

If you encounter issues with `sodium-native` on Windows, try:
```bash
npm install --ignore-optional
npm install libsodium-wrappers
```

The voice encryption library needs either `sodium-native` or `libsodium-wrappers`. The second is a pure JS fallback that always works.

---

## 10. Configure Your Settings

1. Copy the example environment file:
   ```bash
   copy .env.example .env
   ```

2. Open `.env` in a text editor and fill in your values:
   - `DISCORD_BOT_TOKEN` — from step 3
   - `DISCORD_CLIENT_ID` — from step 2
   - `ANTHROPIC_API_KEY` — from step 5
   - `TRANSCRIPTION_SERVICE` — choose `whisper-local`, `assemblyai`, or `deepgram`
   - The matching API key if using a cloud transcription service
   - `DEFAULT_STYLE` — `martin` or `sanderson`
   - `RECAP_CHANNEL_NAME` — name of the Discord channel to post stories to (default: `recap`, case-insensitive partial match)

3. Edit `lore/campaign-context.json` with your campaign's details:
   - Player character names, races, classes, and backstories
   - Key NPCs
   - Active plot threads
   - Important locations and items

   The more detail you provide here, the richer the generated stories will be.

---

## 11. Run the Bot

```bash
node bot.js
```

You should see:
```
[INFO ] Logged in as D&D Scribe Bot#1234
[INFO ] Slash commands registered
```

The bot is now online and listening in your Discord server.

---

## 12. Using the Bot in Discord

**Start recording:**
1. Join a voice channel with your D&D group.
2. In any text channel, type `!record` or use the `/record` slash command.
3. The bot joins your voice channel and starts recording all audio.
4. A confirmation embed appears: "Recording started in #voice-channel".

**Stop recording:**
1. When the session is over, type `!stop` or use `/stop`.
2. The bot processes the audio, mixes all streams, and saves the file.
3. You'll see: "Recording saved! 2h 15m captured."
4. The audio file is saved to `./recordings/session-YYYY-MM-DD.ogg`.
5. The bot automatically transcribes, generates a story, and posts it to your recap channel as rich embeds with a summary header (chapter number, date, duration, style, characters present).
6. If the story is long, it's split into multiple embeds (Part 1/3, Part 2/3, etc.).

**Re-read the latest story:**
Type `!recap` or `/recap` in any text channel to re-post the most recent chapter.

---

## 13. Running the Pipeline Manually

The pipeline chains transcription and story generation in one command.

**Process the latest recording with default style:**
```bash
node run-pipeline.js --latest
```

**Process a specific recording with a specific style:**
```bash
node run-pipeline.js ./recordings/session-2026-04-01.ogg --style sanderson
```

**Run individual steps:**
```bash
# Just transcribe
node transcribe.js --latest

# Just generate story from latest transcript
node generate-story.js --latest --style martin
```

**Using npm scripts:**
```bash
npm run pipeline              # latest recording, default style
npm run pipeline:martin       # latest, GRRM style
npm run pipeline:sanderson    # latest, Sanderson style
```

Output files:
- Transcript: `./transcripts/session-YYYY-MM-DD.txt`
- Story chapter: `./stories/chapter-01-YYYY-MM-DD.md`
- Campaign log: `./stories/campaign-log.md` (appended)

---

## 14. Running as a Windows Service

To keep the bot running when you close the terminal or restart your PC:

**Option A — pm2 (recommended):**
```bash
npm install -g pm2
pm2 start bot.js --name dnd-scribe
pm2 save
pm2 startup
```

This creates a Windows service that auto-starts the bot on login.

Useful pm2 commands:
```bash
pm2 status          # check if running
pm2 logs dnd-scribe # view live logs
pm2 restart dnd-scribe
pm2 stop dnd-scribe
```

**Option B — NSSM (Non-Sucking Service Manager):**
1. Download NSSM from [nssm.cc](https://nssm.cc/).
2. Run:
   ```powershell
   nssm install DnDScribeBot "C:\Program Files\nodejs\node.exe" "C:\Users\samha\Desktop\dnd-scribe-bot\bot.js"
   nssm set DnDScribeBot AppDirectory "C:\Users\samha\Desktop\dnd-scribe-bot"
   nssm start DnDScribeBot
   ```

**Option C — Task Scheduler:**
1. Open Task Scheduler (search in Start).
2. Click "Create Basic Task".
3. Name: "D&D Scribe Bot", Trigger: "When the computer starts".
4. Action: Start a program.
   - Program: `node`
   - Arguments: `bot.js`
   - Start in: `C:\Users\samha\Desktop\dnd-scribe-bot`
5. Check "Open the Properties dialog" before finishing.
6. In Properties, check "Run whether user is logged on or not".

---

## 15. Setting Up a Dispatch Scheduled Task

You can use Claude Dispatch to automatically process recordings after each session.

The `dispatch-task.js` script is designed to be called externally. It:
1. Finds the latest recording
2. Transcribes it
3. Generates a story chapter
4. Outputs structured JSON results

**Manual dispatch run:**
```bash
node dispatch-task.js --style martin
```

**Environment-based configuration (for Dispatch):**
```bash
SCRIBE_STYLE=sanderson SCRIBE_SERVICE=deepgram node dispatch-task.js
```

To set up a scheduled task in your system that runs the pipeline every Sunday at midnight (after your Saturday D&D session):

```bash
# Using pm2 cron
pm2 start dispatch-task.js --name dnd-process --cron "0 0 * * 0" --no-autorestart
```

Or use Windows Task Scheduler with the same approach as Section 14, Option C, but set the trigger to "Weekly" on your session's day.

---

## 16. Troubleshooting

**Bot won't log in:**
- Double-check your `DISCORD_BOT_TOKEN` in `.env`. Regenerate it if needed.
- Make sure you haven't accidentally added quotes around the token in `.env`.
- Verify your internet connection.

**Bot joins voice but records silence:**
- Make sure ffmpeg is installed and on your PATH: `ffmpeg -version`
- Check that the bot has "Connect" and "Speak" permissions in the voice channel.
- Ensure users are not server-muted.
- On some systems, you need to run Discord as administrator.

**AssemblyAI returns a 400 or upload error:**
- Check that your `ASSEMBLYAI_API_KEY` in `.env` is correct (no quotes, no trailing spaces).
- Make sure the recording file is not 0 bytes: check the `recordings/` folder.
- The audio must be in a container format (OGG, WAV, MP3). Raw PCM won't work — set `AUDIO_FORMAT=ogg` in `.env`.
- If the error persists, check the log output — the error message now includes the AssemblyAI response body for debugging.

**Recording audio is shorter than the actual session:**
- This was a known bug (now fixed). The bot inserts silence padding to preserve wall-clock timing. If you still get short recordings, check that all players are unmuted and that the bot has proper voice permissions.

**Whisper local doesn't work (Windows):**
- On this system, Windows Application Control (WDAC / Smart App Control) blocks the PyTorch `.pyd` files that Whisper depends on. This cannot be fixed without disabling Smart App Control (which is a one-way setting).
- **Use AssemblyAI instead.** Set `TRANSCRIPTION_SERVICE=assemblyai` in your `.env` file. It provides better results anyway (speaker diarization included).

**"Cannot find module 'sodium-native'":**
```bash
npm install sodium-native
# Or if that fails:
npm install libsodium-wrappers
```

**"Cannot find module '@discordjs/opus'":**
```bash
npm install @discordjs/opus
# If it fails to build, try the alternative:
npm install opusscript
```

**Whisper is very slow:**
- Use a smaller model: set `WHISPER_MODEL=tiny` or `base`.
- If you have a GPU, make sure CUDA is installed and Whisper detects it.
- Consider using whisper.cpp instead — it's significantly faster on CPU.
- Or switch to Deepgram/AssemblyAI for cloud-based transcription.

**Transcription has no speaker labels:**
- Local Whisper doesn't support diarization. Switch to `assemblyai` or `deepgram` in your `.env`.

**Claude API returns errors:**
- Check your `ANTHROPIC_API_KEY` is correct and has credits.
- If you get rate-limited, wait a minute and try again.
- For very long sessions, the transcript may exceed the context window. Try splitting the recording.

**"ffmpeg exited with code 1":**
- Check that the recording file isn't empty (0 bytes).
- Make sure the recording directory has write permissions.
- Try running ffmpeg manually on the temp PCM files to see the error.

**Slash commands don't appear:**
- They can take up to an hour for global commands. Set `DISCORD_GUILD_ID` for instant server-specific registration.
- Make sure you invited the bot with the `applications.commands` scope.

**Audio file is too large:**
- Switch to OGG format (`AUDIO_FORMAT=ogg` in `.env`) — it's much smaller than PCM.
- Long sessions (4+ hours) at PCM quality can be several GB.

**Terminal closes and bot stops:**
- The bot only runs while the terminal is open. For persistent operation, use pm2 (see Section 14) or keep the Command Prompt window open during your session.

---

## Auto-Restart with PM2 (Recommended for Long Sessions)

If the bot crashes during a recording (e.g. from a rare unhandled error), PM2 will automatically restart it so you don't lose future sessions. This is highly recommended for 3-4 hour D&D sessions.

**Install PM2 globally:**
```
npm install -g pm2
```

**Start the bot under PM2:**
```
cd C:\Users\samha\Desktop\dnd-scribe-bot
pm2 start bot.js --name dnd-scribe
```

**Useful PM2 commands:**
```
pm2 status              # Check if the bot is running
pm2 logs dnd-scribe     # View live logs
pm2 restart dnd-scribe  # Restart the bot
pm2 stop dnd-scribe     # Stop the bot
```

> **Note:** Even with the stream error handlers in `bot.js`, PM2 adds a second layer of safety. If the process does exit for any reason, PM2 restarts it within seconds.

---

## Project Structure

```
dnd-scribe-bot/
├── bot.js                  # Discord bot with voice recording
├── transcribe.js           # Multi-backend transcription pipeline
├── generate-story.js       # Claude-powered story generator
├── run-pipeline.js         # Full automation pipeline
├── dispatch-task.js        # External scheduler integration
├── config.js               # Configuration management
├── logger.js               # Structured logging
├── package.json            # Dependencies
├── .env.example            # Environment template
├── .gitignore
├── SETUP.md                # This file
├── recordings/             # Audio files from sessions
├── transcripts/            # Generated transcripts
├── stories/                # Generated chapters and campaign log
│   └── campaign-log.md     # Running session summary log
└── lore/
    └── campaign-context.json  # Your campaign world details
```

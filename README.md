# D&D Scribe Bot

A Discord bot that **records a D&D session's voice channel, transcribes it with
speaker attribution, and generates an accurate narrative recap of what happened** —
plus a local web dashboard for managing recordings, recaps, and campaign details.
It joins your voice channel, captures every player on a separate audio stream, turns
the audio into a speaker-labelled transcript, and runs a self-checking AI pipeline
that produces a faithful, readable session summary and posts it back to a recap
channel.

## Why it exists

A typical D&D session runs three to four hours, and somebody always ends up half-
listening so they can scribble notes for "last time on…". The goal of this project is
to make those notes unnecessary: press record at the start, stop at the end, and get
back a recap that tells the story of the session **as it actually happened** —
correct characters, correct events, nothing invented — so everyone can just play.

---

## Getting it running

### Prerequisites

- **Node.js ≥ 18** (`engines.node` in `package.json`).
- **ffmpeg** available on `PATH` (or set `FFMPEG_PATH`). The recorder shells out to
  ffmpeg to mix each player's audio into one file.
- **A Discord application + bot token** with the **Server Members** and **Message
  Content** privileged intents enabled, and the bot invited to your server.
- **An Anthropic API key** — recap generation, transcript enrichment, and fact-
  checking all call Claude.
- **A transcription provider** (see below). Diarized, speaker-labelled transcripts —
  which the recap depends on — require a **paid cloud transcriber**.

### Install

```bash
npm install
cp .env.example .env      # then edit .env with your keys
```

### Required configuration

Everything is read from `.env` (see `.env.example` and `config.js`). The keys you
must set:

| Variable | What it's for |
|---|---|
| `DISCORD_BOT_TOKEN` | Your bot's login token. |
| `DISCORD_CLIENT_ID` | Application/client ID, used to register slash commands. |
| `ANTHROPIC_API_KEY` | Claude — used for enrichment, recap writing, and fact-checking. |
| `TRANSCRIPTION_SERVICE` | `whisper-local` \| `assemblyai` \| `deepgram` (see note). |
| `ASSEMBLYAI_API_KEY` / `DEEPGRAM_API_KEY` | Key for whichever cloud transcriber you choose. |

> **About transcription — this matters.** The shipped default is
> `whisper-local`, which is free but **does not diarize** (every line is labelled a
> generic `Speaker:`). The recap pipeline's accuracy comes from knowing *who said
> what*, so for real use you want a **paid diarizing transcriber** — **AssemblyAI**
> or **Deepgram** (Nova-2), both configured with speaker labels on. Set
> `TRANSCRIPTION_SERVICE=assemblyai` (or `deepgram`) and the matching API key.
> Note: this is **not** OpenAI Whisper-by-default for production; Whisper is only the
> zero-cost local fallback.

Useful optional settings: `DISCORD_GUILD_ID` (register slash commands to one server
for instant availability), `RECAP_CHANNEL_NAME` (defaults to `recap`),
`STORY_MAX_USD` (per-recap spend ceiling), and the dashboard's `DASHBOARD_TOKEN` /
`DASHBOARD_HOST` (see *Dashboard* below).

### Run commands — read this carefully

There are **two separate processes**, and `npm start` is **not** the bot:

| Command | What it starts |
|---|---|
| **`node bot.js`** | **The Discord bot** — connects to Discord, joins voice, records, and runs the pipeline. This is the main program. |
| `npm run bot` | Alias for `node bot.js`. |
| `npm start` *(= `node dashboard/server.js`)* | **The web dashboard only**, at `http://localhost:3000`. It does **not** connect to Discord by itself. |
| `npm run dashboard` | Alias for the dashboard. |

So: **to run the bot, use `node bot.js`** (Windows users can also use
`start-dnd-bot.bat`). Run the dashboard separately if you want the web UI — from
there you can start/stop the bot as a child process.

Useful manual entry points (no bot required):

```bash
node transcribe.js --latest            # transcribe the latest recording
node generate-story.js --latest        # generate a recap from the latest transcript
node generate-story.js ./transcripts/session-2026-05-31.txt
node run-pipeline.js --latest          # transcribe + enrich + generate in one go
```

---

## What it does

```
   Discord voice ──▶ record ──▶ transcribe ──▶ enrich ──▶ recap pipeline ──▶ post
   (per-user audio)  (mix +     (speaker-     (names,     (chunked,            (recap
                      backup)    labelled)     scenes)      scored, graded)      channel)
```

In a session you drive it with chat commands (prefix `!` or the equivalent `/` slash
command):

| Command | Effect |
|---|---|
| `!record` / `/record` | Join your voice channel and start recording. |
| `!record-one-shot` | Record a standalone one-shot (separate context, doesn't touch the campaign log). |
| `!stop` / `/stop` | Stop, save + back up the audio, then run the pipeline and post the recap. |
| `!regenerate` | Re-run the whole pipeline on the most recent recording (falls back to `backups/`). |
| `!recap` | Re-post the latest recap chapter to the current channel. |
| `!switchchar <name>` | Note that you've switched characters mid-session (updates the speaker map). |
| `!speakers DisplayName=CharacterName …` | Map Discord users to character names for transcript labelling. |
| `!addnpc Name \| Role \| Desc \| Relationship` / `!listnpcs` | Manage recurring NPCs in the campaign context. |
| `!help` | List commands. |

On `!stop` the bot posts a recording-consent notice at record-start, saves a backup
copy of the audio **before** processing, and runs the pipeline fire-and-forget so the
bot stays responsive. If anything fails, the raw recording is never deleted and the
bot tells you exactly how to retry.

---

## How it works

### Recording & diarization

Each participant is subscribed on their **own PCM stream**, silence-padded to real
wall-clock timing (Discord only sends audio during speech, so gaps are filled so a
3-hour session doesn't collapse to 30 minutes). On stop, ffmpeg mixes the per-user
streams into one `ogg`/`pcm` file, and a `…-speakers.json` sidecar records exactly
**when each user was speaking**.

That speaking timeline is the key to accurate attribution. Rather than trusting the
cloud transcriber's own "Speaker A/B/C" guesses (one mislabel there used to collapse
the whole session onto the DM), the transcriber's text utterances are re-assigned
**independently** to the user whose recorded speaking segment best overlaps each one
(`assignUtterancesToUsers` in `transcribe.js`). The speaker-map then renders those
user IDs as character names, producing lines like
`[00:12:34] Sam (Thrain Ironwatch): …`.

Between transcription and recap, three non-fatal Sonnet enrichment passes run:
character-introduction detection (auto-updates the campaign context), phonetic
name correction, and scene-marker insertion.

### The recap pipeline (the heart of the project)

The current engine is a **chunked map-reduce with a scored, self-correcting loop**
(`modules/chunked-pipeline.js`, driven by `generate-story.js`). It replaced an older
path that resent the whole transcript and was capped at 8K output tokens — which
truncated multi-hour sessions to a fraction of themselves. The pipeline:

1. **Scene chunker** — splits the transcript into ~scene-sized chunks with a little
   overlap for continuity.
2. **Extraction (once)** — Sonnet distils each chunk into structured beats (events,
   who-did-what *by character*, rolls/decisions, memorable lines, NPCs, locations),
   threading a running session state forward. Done once and reused across every write
   attempt; failed chunks are retried.
3. **Scored write → fact-check loop** (up to `maxAttempts`):
   - **Write** — Sonnet writes a clear, **style-free** recap. By default it sees the
     **full speaker-labelled transcript** as the authoritative source (sessions over
     ~40K tokens fall back to a beats-only digest); the extracted beats are demoted
     to a **coverage checklist** for ordering and completeness.
   - **Fact-check / grade** — **Opus** grades the recap against the **raw transcript
     plus the character roster** via a *forced* structured tool call, so the result
     always parses. It returns weighted sub-scores (coverage, attribution, event
     fidelity, no-fabrication, ordering, back-third coverage, NPC accuracy),
     aggregated to a 0–100 score deterministically in code, plus a concrete list of
     errors. A deterministic **gear/ability cross-check** in code catches signature
     mix-ups the grader might miss.
   - **Patch-on-best** — attempt 1 writes from scratch; every later attempt **anchors
     on the current best recap** and makes only its *still-open* corrections
     (critique → revise), keeping everything else verbatim and carrying forward a
     frozen "keep these fixed" list. This stopped the score from oscillating.
   - **Stop** when the recap clears the high bar (**90** by default) with **zero
     serious errors and no post-condition failures**, or on a plateau, the attempt
     cap, or the cost ceiling — keeping the best attempt either way.

   **Hard post-condition gates** (must start with an H1 title, no "Chapter N"
   numbering, must end with a `## Session Summary`, must not be cut off, must be near
   the target length) are rejects that block a pass and feed the fix loop.

### Roster & NPC grounding

The fact-check's ground truth is built from `lore/campaign-context.json`
(`playerCharacters` + `flavorBank.characters`). For each session the pipeline figures
out **who actually took part** from the speaker labels and splits the roster into:

- **Present PCs** — the only protagonists.
- **Absent PCs** — fenced off; flagged as a stray character if they appear.
- **Unknown / unmapped speakers** (e.g. a `Speaker E` with no character mapping) —
  surfaced explicitly so the writer attributes their lines generically ("one of the
  party") and **never guesses a name**.
- **Detected NPCs** — recurring cast actually mentioned this session (active
  companions kept as supporting cast, former-PCs kept as background).
- **Signature ability/gear ownership** — a deterministic map (e.g. a shield → the
  character who carries one) given to both writer and grader to prevent cross-
  attribution.

### Config knobs

All read from `.env` / `config.js` (`story.*`):

| Setting | Default | Effect |
|---|---|---|
| `STORY_PIPELINE` | `chunked` | Recap engine; `legacy` reverts to the old resend path (escape hatch). |
| `STORY_TARGET_WORDS` | `3000` | Recap length target (≈0.8×–1.25× band). |
| `STORY_PASS_SCORE` | `90` | Accuracy bar the recap must clear to stop early. |
| `STORY_MAX_ATTEMPTS` | `10` | Max write→grade iterations before keeping the best. |
| `STORY_EXTRACT_MODEL` | `claude-sonnet-4-6` | Beat extraction. |
| `STORY_WRITER_MODEL` | `claude-sonnet-4-6` | Writes the recap. |
| `STORY_FACTCHECK_MODEL` | `claude-opus-4-8` | The Opus grader. |
| `STORY_USE_FABLE` | `false` | Write with Fable 5 instead of the writer model. |
| `STORY_CREATIVITY` | `transcript-only` | How much atmospheric embellishment is allowed. |
| `STORY_MAX_USD` | `10` (`5` in `.env.example`) | Hard $ ceiling per recap; the loop stops early and keeps the best attempt if hit. |

`DEFAULT_STYLE` (`martin`/`sanderson`) is now **cosmetic only** — a Discord embed
label. The recap itself is deliberately style-free: fidelity over flourish.

### Cost controls

Beats are extracted **once**; only the write + Opus grade repeat per attempt. A
`CostGuard` tracks real token usage across every call in a run and short-circuits the
loop before the next attempt would exceed `STORY_MAX_USD`, always keeping the best
recap so far. A whole-run wall-clock cap and per-call timeouts mean a hung pipeline
can never block the bot, and large outputs are streamed and retried with more headroom
so a recap never ships truncated. A representative full loop on a 3.5-hour session
costs roughly **$4–8**.

### Per-guild state & the dashboard

State is namespaced per Discord server: each guild gets its own campaign context,
speaker map, campaign log, chapter numbering, and verification history under
`lore/guilds/<id>/` and `stories/guilds/<id>/`. Set `PRIMARY_GUILD_ID` to keep an
existing single-campaign install in the original flat layout.

The **dashboard** (`npm start` → `http://localhost:3000`) is an Express + Socket.IO
control panel: start/stop the bot, browse recordings, (re)run the pipeline, read and
regenerate recaps, edit campaign context, and test API keys. It binds to **loopback
only** by default; to expose it off-host you must set `DASHBOARD_TOKEN` (shared-secret
auth on every request and socket) and `DASHBOARD_HOST`. It logs a loud warning if left
unauthenticated.

---

## Current state

The rebuilt recap pipeline is **working well**. On a real 3.5-hour campaign session it
lands a best score of **~90/100** (a tight 87–92 band across runs) and ran near-
flawlessly — correct present/absent characters, unmapped speakers handled generically,
recurring NPCs named correctly, and the signature gear/ability ownership enforced. The
old behaviour by comparison plateaued at 88 and oscillated wildly; the patch-on-best
loop fixed that.

**Known limitations:**

- **Unattributable speakers.** Lines from unmapped speakers (e.g. a `Speaker E` the
  speaker-map can't tie to a character) are intentionally narrated generically rather
  than guessed. Keep `lore/campaign-context.json` and your `!speakers` map accurate to
  minimise these.
- **Chaotic combat attribution.** The residual point-losses are a handful of genuine
  attribution slips in fast, overlapping scenes (players voicing each other's
  characters; the DM himself misattributing an action). The biggest single lever is a
  **stronger writer model** — set `STORY_WRITER_MODEL=claude-opus-4-8` (or
  `STORY_USE_FABLE=true`) for higher-stakes recaps.
- **Whisper-local has no diarization** — use a paid cloud transcriber for real recaps.
- **Very long transcripts** still fall back to a beats-only digest above ~40K tokens
  rather than the full transcript, and the main generation SDK calls aren't yet routed
  through the streaming/retry client the classifier uses (they are cost-guarded). See
  `REVIEW_AND_IMPROVEMENTS.md` for the full deferred list.
- **Branch status.** The chunked scored-loop recap engine currently lives on the
  `poc/regen-story-v2` branch and is **not yet merged to `master`**.

**Roadmap:** merge the recap pipeline to `master`; route remaining story-generation
calls through the streaming/retry client; chunk *generation* (not just extraction) for
very long sessions; and surface low-confidence diarization labels for easier
`!speakers` correction.

---

## Repo map

| Path | Purpose |
|---|---|
| `bot.js` | Discord bot entry point. |
| `dashboard/server.js` | Web control panel (Express + Socket.IO). |
| `modules/recorder.js` | Voice capture, silence padding, audio mixing, speaker timeline. |
| `transcribe.js` | Audio → speaker-labelled transcript (Whisper / AssemblyAI / Deepgram). |
| `modules/pipeline.js` | Orchestrates transcribe → enrich → generate → post. |
| `generate-story.js` | Story-generation entry; wires config into the recap engine. |
| `modules/chunked-pipeline.js` | The chunked, scored, fact-checked recap engine. |
| `config.js` / `.env.example` | All configuration. |
| `lore/campaign-context.json` | Campaign roster, NPCs, locations, flavor bank (recap ground truth). |
| `STORY_RECAP_GUIDE.md` | Deep dive on the recap pipeline and verified results. |
| `PRIVACY.md` | Audio/transcript data handling and consent posture. |

## Privacy

Voice recording is sensitive: the bot posts a visible "now recording" notice when it
joins, cloud transcription uploads raw audio off-host, and transcripts are sent to
Anthropic for recap generation. Retention and consent guidance live in `PRIVACY.md`;
`DELETE_AUDIO_AFTER_PROCESSING=true` purges the raw recording after a successful run
(the backup is kept; the failure path never deletes audio).

## License

MIT.

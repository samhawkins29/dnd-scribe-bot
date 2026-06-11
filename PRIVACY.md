# Privacy & Data Handling

The D&D Scribe Bot records players' real voices and produces transcripts that
include their Discord display names. This document describes what data is
collected, where it goes, how long it is kept, and how to configure that.

> **You are responsible for obtaining consent.** Recording voice requires
> participant awareness, and many jurisdictions require explicit consent. The
> bot now posts a visible **"🔴 Now recording"** notice to the channel when a
> session starts (see `postRecordingNotice` in `modules/discord-utils.js`), but
> a posted notice is not a substitute for the consent your group/region requires.

## What is collected

| Data | Where it lives | Contains |
|---|---|---|
| Raw audio (per-user, then mixed) | `recordings/` | Players' voices |
| Immediate backup of the mix | `backups/` | Players' voices |
| Speaker timing metadata | `recordings/*-speakers.json` | Discord user IDs, display names, speaking timestamps |
| Transcript | `transcripts/` | Speech text + character/display names |
| Generated recap | `stories/` | Narrative derived from the transcript |
| Campaign state | `lore/` (per-guild under `lore/guilds/<id>/`) | Character/NPC names, notes |

## Where data is sent off-host

- **Transcription.** Depending on `TRANSCRIPTION_SERVICE`:
  - `whisper-local` — audio never leaves the host.
  - `assemblyai` / `deepgram` — the **raw audio is uploaded** to that cloud
    provider for transcription. Their retention/processing terms then apply.
- **Story generation.** The **transcript text** (including display/character
  names) is sent to the Anthropic API to write the recap.

If off-host processing is unacceptable for your group, use `whisper-local` and a
local model, and remember the transcript still goes to Anthropic unless you also
self-host generation.

## Retention

By default nothing under `recordings/`, `transcripts/`, or `stories/` is deleted
automatically; only `backups/` is swept after 30 days (`modules/recovery.js`).
Two opt-in controls (see `config.privacy`, `.env`):

- `DELETE_AUDIO_AFTER_PROCESSING=true` — delete the raw recording from
  `recordings/` after a **fully successful** pipeline run. The `backups/` copy is
  kept (and still 30-day swept), so retry is still possible for a month. The
  failure path **never** deletes audio.
- `AUDIO_RETENTION_DAYS=N` — intended retention window for raw recordings; a
  maintenance/cron task can use this to purge `recordings/` older than `N` days.

## Encryption at rest

Audio and transcripts are stored **unencrypted** on the bot host. This is a known
limitation. Recommended mitigations until at-rest encryption is built in:

- Run the bot on a host with **full-disk encryption** (BitLocker / FileVault /
  LUKS) — this is the simplest effective control and covers all of the
  directories above.
- Restrict filesystem permissions on `recordings/`, `backups/`, `transcripts/`,
  and `lore/` to the bot's user only.
- Keep `DELETE_AUDIO_AFTER_PROCESSING=true` so raw voice audio does not
  accumulate indefinitely.

## Secrets

API keys live in `.env` (gitignored). The dashboard masks keys in
`/api/settings` and, as of the dashboard-security change, requires a token and
binds to loopback by default (see `DASHBOARD_TOKEN` / `DASHBOARD_HOST`).

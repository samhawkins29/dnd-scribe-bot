# D&D Scribe Bot — Back-Check & Improvement Review

*Analysis prepared 2026-06-10. Scope: architecture, reliability, story quality, security, scaling. No code was changed except the creation of this file.*

---

## Remediation status (updated 2026-06-11)

A pass through the highest-priority items below. Each was its own commit.

### Fixed

1. **Classifier truncation (§2.1, P0 #1).** `classifier.js` now chunks the
   transcript into line-aligned pieces (no single response must cover the whole
   session), routes through the streaming `anthropic-client.js` (retry + 15-min
   timeout), uses a 32K output budget (`config.anthropic.transcriptMaxTokens`),
   and per-chunk shrink-guards back to the original text so content is never
   dropped. Honors `config.anthropic.model` instead of a hardcoded id.
2. **Cost controls (§2.1, §4, P0 #3).** New `modules/cost.js` (`CostGuard` +
   token/$ estimate, per-model price table). Both story paths log an up-front
   estimate, track real usage from API `usage`, and short-circuit the
   verification loop once the next attempt would exceed `config.cost.storyMaxUsd`
   ($5 default). Default attempts trimmed 4→3 / 10→4.
3. **Transcription poll timeout (§2.1, P0 #2).** The AssemblyAI `while(true)`
   poll now has a wall-clock deadline (`ASSEMBLYAI_POLL_TIMEOUT_MS`, 45 min) and
   throws on exceed, so a stuck cloud job releases the per-guild lock instead of
   hanging forever.
4. **Per-guild data isolation (§5, P1 #6).** New `modules/workspace.js`
   (`resolveWorkspace(guildId)`) namespaces campaign-context, oneshot-context,
   speaker-map, campaign-log, sessions.json, chapter numbering, and
   verification-history under `lore/guilds/<id>/` and `stories/guilds/<id>/`.
   The "primary"/legacy guild keeps the flat layout (`PRIMARY_GUILD_ID`), so
   existing single-campaign data is untouched. Threaded through pipeline →
   transcribe (speaker map), enrichment (character-detector + corrector),
   generate-story, and the `!speakers`/`!addnpc`/`switchchar` writes.
5. **Dashboard security (§2.6, P1 #7).** Optional shared-token auth
   (`DASHBOARD_TOKEN`) on every request + socket; loopback-only bind by default
   (`DASHBOARD_HOST`) with a loud warning when unauthenticated. `/api/stories/
   :filename` is `basename`-sanitized and `.md`-restricted (path traversal).
   `PUT /api/campaign` validates the body shape before writing.
6. **Diarization from the per-user streams (§2.2, P2 #10).** New
   `assignUtterancesToUsers()` attributes **each utterance independently** to the
   user whose recorded speaking segment overlaps it (the per-user-stream ground
   truth), discarding the cloud "Speaker X" labels and the global timeline-warp.
   A single mislabel can no longer collapse the session onto the DM. Wired into
   `transcribe()` and `remapFromCache()`; cloud-label voting remains the fallback
   for disk transcripts with no timing. Unit-tested incl. the collapse scenario.
7. **Privacy (§2.6, §4, P-Risk).** A prominent "🔴 Now recording" notice is
   posted on session start. New `PRIVACY.md` documents collection, off-host
   flows (cloud transcription uploads raw audio; transcripts go to Anthropic),
   retention, and at-rest-encryption guidance. Opt-in
   `DELETE_AUDIO_AFTER_PROCESSING` purges raw audio after a successful run
   (backup kept; failure path never deletes).
8. **The 4 failing tests (§2.5, P0 #5).** `playerName`→`player` schema drift
   reconciled; POSIX-`/tmp` assumptions switched to `os.tmpdir()`; an outdated
   source-scan updated. **Suite: 223/223 passing** (was 215/219; +4 new
   diarization tests).

### Deferred (documented, not yet done)

- **Route the main story-gen SDK call through `anthropic-client.js` (P0 #4).**
  The classifier was migrated; `generate-story.js:745` (and the verifier/flavor/
  NPC calls) still use the non-streaming SDK. They are now cost-guarded but lack
  the streaming/retry/timeout. *Next: wrap them the same way the classifier was.*
- **Transcript chunking for *generation* (P2 #11).** Long sessions still go to
  the generator as one prompt; the dollar ceiling bounds spend, but very long
  transcripts can still exceed context. The orphaned chunked-story scripts remain
  unwired.
- **Diarization confidence surfacing (P1 #9).** Attribution is now ground-truth;
  surfacing *low-confidence* labels (small overlap margins) for `!speakers`
  review is not yet done.
- **Voice reconnect re-subscription & mid-capture crash recovery (§2.1).** Not
  addressed — a Discord UDP rebuild can still silently stop capture, and a crash
  during capture still orphans `_tmp_*.pcm`.
- **Script sprawl / shared verification loop (P1 #8).** The two near-identical
  verification loops and the many root-level `recover-*`/`regenerate`/`post-story`
  scripts are not yet consolidated.
- **Dashboard review workflow (P2 #12), story knobs / flavor-bank hygiene (P3),
  and at-rest encryption.** Encryption is documented in `PRIVACY.md` (full-disk
  + permissions) rather than built in.

---

The bot is genuinely impressive for a personal-scale tool: it captures Discord voice, pads silence to preserve wall-clock timing, transcribes via three pluggable backends, runs a multi-pass LLM enrichment + verification loop, and posts styled recaps — with a real reliability layer (backups, failed-job log, processing lock, startup health check). The fundamentals are sound. The gaps below are about turning a working personal tool into a *polished, trustworthy* one, especially around cost, long sessions, multi-campaign isolation, and data privacy.

---

## 1. Architecture & Code Health

### 1.1 Structure (what's where)

| Layer | Files | Notes |
|---|---|---|
| Entry / lifecycle | `bot.js` | Clean. Intents, graceful shutdown, global `uncaughtException`/`unhandledRejection` keep-alive. |
| Voice capture | `modules/recorder.js` (610) | Per-user Opus→PCM streams, `SilencePadTransform`, ffmpeg `amix`, speaker-segment tracking. |
| Commands | `modules/commands.js` (630) | Prefix + slash handlers. |
| Pipeline orchestration | `modules/pipeline.js` (777) | transcribe → enrich → generate → post, with Discord progress embeds. |
| Transcription | `transcribe.js` (1083) | whisper-local / AssemblyAI / Deepgram; diarization→user matching. |
| Story generation | `generate-story.js` (1616) | Prompts, verification loop, flavor bank, NPC detection. |
| Enrichment passes | `classifier.js`, `modules/transcript-corrector.js`, `modules/scene-detector.js`, `modules/character-detector.js` | |
| LLM client | `modules/anthropic-client.js` | Streaming + retry + timeout REST wrapper. |
| Reliability | `modules/recovery.js` (392) | safePath, backups, failed-jobs, processing lock, health check. |
| Dashboard | `dashboard/server.js` (412) | Express + Socket.IO control panel. |

This module split is good — `recorder`, `recovery`, `discord-utils`, and `anthropic-client` are cohesive and well-commented. The comments in `recorder.js` and `transcribe.js` explaining *why* (silence padding, timeline warp) are excellent institutional memory.

### 1.2 Async handling

- **Voice stream piping** (`recorder.js:200`) attaches `error` handlers to every stage (opus, decoder, silencePad, fileStream) so a corrupted packet is skipped, not fatal. Good.
- **Graceful flush on stop** (`recorder.js:451-470`): ends the decoder and waits for `fileStream 'finish'` with a 10 s safety timeout before destroying streams — correctly avoids truncating buffered audio. This is a subtle thing done right.
- **Fire-and-forget pipeline** (`commands.js:138-144`) keeps the event loop responsive; the processing lock (`recovery.js:228`) prevents overlap. Good.

### 1.3 The biggest structural issue: two divergent Anthropic integrations

There are **two** ways the codebase talks to Claude, and the split is backwards:

1. `modules/anthropic-client.js` — bespoke REST client with **streaming, retry/backoff, and a 15-min AbortController timeout** (`anthropic-client.js:34,107-167`). Its header comment explains it was written specifically because long non-streaming requests get killed as idle sockets ("fetch failed").
2. The official `@anthropic-ai/sdk`, called **non-streaming** in `generate-story.js` (`:745`), `classifier.js` (`:66`), and the verification/flavor/NPC calls.

The calls that need streaming most — the full-transcript story generation and the line classifier — are the ones still on the non-streaming SDK path. They lack the retry and timeout that `anthropic-client.js` exists to provide. This is the same failure class as commit `40f6d4b` ("fetch failed") but only half-fixed.

### 1.4 Tech-debt hotspots

- **`generate-story.js` is 1616 lines** with `generateStory` and `generateOneShotStory` sharing ~220 nearly-identical lines (prompt build + verification loop + save). The verification loop should be one shared `verifyAndRegenerate()`.
- **Root-directory script sprawl.** Many overlapping one-off entry points: `chunked-story.js` + `generate-chunked-story.js` (orphaned — referenced only by each other, not the pipeline), `generate-from-transcript.js`, `combine-session.js`, `recover-audio.js`, `recover-transcript.js`, `recover-session.js`, `regenerate.js`, `post-story.js`, `verify-story.js`, `dispatch-task.js`. Plus an empty `node` file. This makes "how do I reprocess X?" genuinely confusing and multiplies maintenance.
- **Hardcoded model id** `claude-sonnet-4-20250514` appears in `config.js:22`, `anthropic-client.js:29`, and `classifier.js:67`. `classifier.js` ignores `config.anthropic.model` entirely.
- **Duplicated `!speakers` parsing** (~60 lines) across prefix and slash handlers (`commands.js:209-307` and `538-622`).
- **Scattered magic `max_tokens`**: 8192 / 4096 / 2048 / 1024 / 32768 hardcoded across files instead of being config-driven per task.

---

## 2. Gaps

### 2.1 Reliability

**Long-session transcript truncation in the classifier (latent data-loss bug).**
`classifier.js:66-70` echoes the *entire transcript back* tagged, but caps output at `config.anthropic.maxTokens` (8192). A multi-hour session transcript is far larger than 8192 output tokens, so the response is silently truncated. The validation only checks the *tag rate of whatever came back* (`classifier.js:88-97`) — a truncated-but-well-tagged first half passes the 0.5 threshold and is returned, **dropping the entire back half of the session** before story generation. Contrast `transcript-corrector.js:105`, which correctly budgets `32768` for the same echo-the-transcript pattern. This is the single highest-severity correctness gap.

**No overall timeout on transcription polling.**
`transcribe.js:652` polls AssemblyAI in `while (true)` with a 5 s sleep and no iteration/wall-clock cap. A job stuck in a non-terminal state hangs the pipeline indefinitely (the processing lock then blocks all future recordings for that guild until restart).

**Voice reconnect doesn't re-subscribe.**
On `Disconnected`, `recorder.js:339-361` waits to re-enter `Signalling`/`Connecting` and logs "recovering," but if Discord rebuilds the UDP session the existing `receiver.subscribe` streams can go silent. There's no re-subscription of users after a recovery, so a mid-session blip can yield a recording that quietly stops capturing audio while the session still shows "active."

**In-memory-only session state.**
`sessions` and `processing` are plain `Map`s (`recorder.js:29`, `recovery.js:218`). If the process dies mid-recording, the per-user `_tmp_*.pcm` files are orphaned (never mixed, never backed up — backups only happen *after* a successful mix at `recorder.js:522`). Recovery covers post-mix failures well, but not a crash during capture.

**No cost controls anywhere (see also §4).** The verification loop runs up to **4 attempts (campaign) / 10 attempts (one-shot)** (`config.js:97-98`), each resending the full transcript and generating up to 8192 tokens, plus verifier calls — all unbounded by token budget or dollar cap.

**Rate limits** are only partly handled: `anthropic-client.js` retries 429/529/5xx with backoff, but the SDK-path calls (story gen, classifier) and the transcription backends have no 429 handling.

### 2.2 Speaker diarization / who-said-what

This is the most fragile part of the product, and the code knows it — `transcribe.js:238-273` and `recorder.js:80-90` carry long comments about diarization "collapsing onto the DM." The current approach:
- Discord per-user speaking segments (ground truth for *who*, `recorder.js:403-414`) are matched against cloud-diarized labels by **time overlap**, with a **best-effort linear "timeline warp"** (`transcribe.js:263-267`) to compensate for the silence-cap compression.

This is a clever workaround, but it's a heuristic stacked on a heuristic (silence padding → warp → overlap vote). It will keep producing occasional mislabels, and there's no confidence signal surfaced to the user when a match is weak. The root cause is mixing all users into one file *then* re-separating; the per-user PCM streams already exist (`recorder.js:202`) and are perfect ground-truth diarization that gets thrown away at mix time.

### 2.3 Story quality & player personalization

- **Personalization is solid at the character level**: `campaign-context.json` PCs (name/race/class/backstory/bonds/personality), recurring NPCs, plot threads, locations, items, and an auto-growing "flavor bank" all feed the prompt (`generate-story.js` `buildMessages`). `speaker-map.json` resolves Discord users → character names in the transcript.
- **Gaps**: only two styles (`martin`/`sanderson`), both as giant hardcoded prompt blocks. No per-player "spotlight"/screen-time weighting, no tone controls (grimdark vs comedic), no length target. The flavor-bank merge only replaces an entry "if the new description is longer" — it accumulates and can keep stale/contradictory lore.
- **Verification is LLM-as-judge against the same model** (`generate-story.js:1217`, no separate judge model). "Best of N by self-reported `accuracy_score`" can plateau, and the score is subjective — it's a reasonable guardrail but shouldn't be read as ground truth (it's surfaced to players as "Accuracy: N/100" in the recap footer, `pipeline.js:439-442`, which over-claims precision).

### 2.4 Dashboard / UX

- The dashboard is **fire-and-control only**: it `fork`s `bot.js` and `spawn`s `run-pipeline.js`, streaming logs over Socket.IO. There's no live recording level meter, no per-session cost display, no diarization-confidence review/relabel UI (exactly where a human is most useful).
- Status is **optimistic/guessed**: `server.js:105-110` flips `botOnline = true` after 3 s regardless of real state; `recording` is never actually updated from the bot (the bot process and dashboard don't share state), so the panel's recording indicator is effectively dead.
- `PUT /api/campaign` (`server.js:293`) writes `req.body` verbatim as the campaign context with **no schema validation** — a malformed save corrupts the file every downstream pass depends on.

### 2.5 Test coverage

219 tests is great breadth, but **4 currently fail** (`node tests/run-all.js`: 215/219):
- `transcribe rejects ... including path` and `story saved as markdown` and the concurrent-log test assume **POSIX paths/`/tmp`** — they break on the Windows host the bot actually runs on.
- `each player character has playerName` expects a `playerName` field, but the schema uses `player` (`character-detector.js:208`) — a real **schema drift** the tests caught.

More importantly, coverage is concentrated on JSON-schema/file-discovery/config validation. The **highest-risk logic is barely tested**: `matchSpeakersToUsers` timeline-warp math, `SilencePadTransform` gap insertion, the verification/regeneration loop, and `splitForEmbeds` boundaries. These are pure functions (already exported) — they're the cheapest, highest-value tests to add.

### 2.6 Security

- **Dashboard has zero authentication.** Every route (`/api/bot/start|stop`, `/api/recordings/process`, `/api/campaign` PUT, `/api/settings`) is open to anything that can reach the port. Even bound to localhost this is a risk on a shared/RDP host or behind any reverse proxy, and the process-control + cost-spending endpoints are the worst to leave open.
- **Possible path traversal**: `GET /api/stories/:filename` → `path.join(config.paths.stories, req.params.filename)` (`server.js:236-239`) with no `basename`/whitelist check. Worth hardening even on localhost.
- **Audio-data privacy** (see §4): recordings and backups are stored unencrypted indefinitely (only backups get a 30-day cleanup, `recovery.js:102`); raw audio is uploaded to AssemblyAI/Deepgram and transcripts to Anthropic, with no consent flow, retention policy, or redaction.
- **Token handling is reasonable**: `.env` is gitignored, the health check rejects placeholder keys (`recovery.js:303-309`), and `/api/settings` masks keys (`server.js:314-318`). But `server.js:78` forks the bot with the full `process.env` (fine functionally, just noting secrets propagate to every child).
- **Global keep-alive swallows everything**: `bot.js:106-119` logs and continues on *any* uncaught exception. Good for surviving a session, but it can mask corruption (e.g., a half-broken stream) and keep "recording" something useless.

---

## 3. Improvements (prioritized: impact vs effort)

### P0 — High impact, low/medium effort

1. **Fix classifier truncation.** Raise `classifier.js` `max_tokens` to ~32768 (match the corrector) **and** add a length-sanity fallback like `transcript-corrector.js:120` (if output shrank >30%, keep the original untagged transcript). *Why: silent loss of half a long session is the worst possible failure for a recap tool.* (≈10 lines.)
2. **Add a transcription poll timeout.** Cap the AssemblyAI loop at a wall-clock budget (e.g. 30–45 min) and throw on exceed so `recordFailedJob` fires and the lock releases (`transcribe.js:652`). *Why: a stuck job currently bricks the guild until restart.*
3. **Add a cost ceiling + estimate.** Before story generation, estimate input tokens from transcript length, log an estimated $ cost, and enforce a configurable `STORY_MAX_USD`/max-attempts-by-cost cap that short-circuits the verification loop. *Why: the 10-attempt one-shot loop on a 3-hour transcript is real, unbounded money (§4).*
4. **Route the long SDK calls through `anthropic-client.js`** (or give them streaming + the 15-min timeout + retry). Target `generate-story.js:745` and `classifier.js:66`. *Why: closes the other half of the "fetch failed" bug and unifies retry behavior.*
5. **Fix the 4 failing tests + the `player`/`playerName` schema drift.** Make path assertions OS-agnostic (`path.sep`), and reconcile the field name. *Why: a red suite erodes trust in the 215 that pass.*

### P1 — High impact, medium effort

6. **Per-guild data isolation** (see §5). Namespace `speaker-map.json`, `campaign-context.json`, `campaign-log.md`, `sessions.json`, and chapter numbering by guild id. *Why: this is the one change that unblocks "polished tool other people can use."*
7. **Authenticate the dashboard** (single shared token / basic-auth env var) and `basename()`-sanitize the stories route. Low effort, removes a whole risk class.
8. **De-duplicate the story path.** Extract the shared verification/regeneration loop; collapse the orphaned `chunked-story.js`/`generate-chunked-story.js` and the various `recover-*`/`regenerate`/`post-story` scripts into one documented CLI (`scribe <transcribe|generate|recover> ...`). *Why: removes the "which script do I run?" confusion and ~hundreds of duplicate lines.*
9. **Surface diarization confidence.** When `matchSpeakersToUsers` produces a weak/ambiguous winner (small margin between top candidates — the data is already logged at `transcribe.js:314-323`), flag those labels as uncertain in the transcript and prompt the user to confirm via `!speakers`. *Why: turns silent mislabels into a quick human fix.*

### P2 — High impact, higher effort (the real product unlocks)

10. **Diarize from the per-user streams instead of re-separating a mixed file.** The per-user PCM files (`recorder.js:202`) are ground-truth "who spoke when." Keep them and transcribe per-user (or at least use them to *assign* cloud utterances), eliminating the warp/overlap heuristic entirely. *Why: removes the most fragile system in the product.*
11. **Transcript chunking for very long sessions** so prompts can't exceed the context window — wire up the existing (orphaned) chunked path into `generateStory` with a clean stitch. *Why: 3.5h sessions are a stated target and currently go in as one prompt with only a size *log*, not a guard (`generate-story.js:718-722`).*
12. **Dashboard review workflow**: live status that reflects real bot/recording state (have the bot report status back), a cost-per-session panel, and a relabel-speakers UI. *Why: the dashboard's best use is human-in-the-loop review, which it doesn't do yet.*

### P3 — Polish

13. Player-facing story knobs (length target, tone, per-player spotlight weighting).
14. Flavor-bank hygiene (dedupe/expire instead of append-if-longer).
15. Move all `max_tokens` and the model id into config; refresh the model default.

---

## 4. Risks

**Cost runaway (highest financial risk).** There is no token estimation, no $ cap, and no chunking. The verification loop alone is up to 4× (campaign) / **10× (one-shot)** full-transcript generations (`config.js:97-98`), each re-sending the whole transcript and the verifier re-sending transcript+story (`generate-story.js:1217-1224`). On a 3-hour session a single one-shot run could be many dollars, and nothing stops it. Transcription cost (AssemblyAI/Deepgram per-minute) is likewise uncapped per session.

**Audio-data privacy.** The bot records players' real voices and produces transcripts with real display names, then ships raw audio to AssemblyAI/Deepgram and text to Anthropic. There's no consent step, no encryption at rest, and retention is effectively forever (`recordings/` is never cleaned; only `backups/` has a 30-day sweep, `recovery.js:102`). For a tool other people use, a documented retention/consent policy and at least optional auto-deletion of raw audio after successful processing are important.

**Discord API / ToS.** Recording voice requires participant awareness; the bot posts a command dictionary on join (`recorder.js:419`) but never announces it is *recording*. Discord's policies and many jurisdictions expect explicit notice/consent for voice capture. An automatic "🔴 Now recording — everyone in channel is being captured" message (and a visible recording presence) reduces both ToS and legal exposure. The global `uncaughtException` keep-alive (`bot.js:106`) is also a mild ToS-adjacent risk if it keeps the bot "live" in a broken state.

**Scaling to multiple servers.** The recording layer is per-guild and would work for concurrent guilds, but **all campaign state is global, single-file**: `lore/speaker-map.json`, `lore/campaign-context.json`, `stories/campaign-log.md`, `stories/sessions.json`, chapter numbering, and the verification history. Two servers running simultaneously would clobber each other's context and interleave each other's chapters. The dashboard also forks exactly one bot. Today this is a single-campaign tool wearing multi-guild plumbing.

---

## 5. Sharpest Next Moves

If you do only a handful of things, do these — each is high-leverage and most are small:

1. **Fix the classifier truncation** (`classifier.js` — raise `max_tokens` to ~32K + shrink-guard fallback). It silently drops the back half of long sessions today; it's a ~10-line fix to the product's core promise.
2. **Add a cost cap + estimate before generation**, and reconsider the 10-attempt one-shot default. This is the difference between "fun tool" and "surprise $40 invoice."
3. **Bound the transcription poll loop** so a stuck cloud job can't brick a guild's recording lock.
4. **Per-guild data isolation** for `campaign-context.json` / `speaker-map.json` / `campaign-log.md` / chapter numbering. This is the one architectural change that unlocks "more than one server/campaign."
5. **Authenticate the dashboard** and sanitize the stories file route — minutes of work, removes an open process-control + cost-spending surface.
6. **Fix the 4 failing tests** (OS-path assumptions + `player`/`playerName` drift) and add unit tests for `matchSpeakersToUsers` and `SilencePadTransform` — the riskiest, least-tested, already-exported logic.

Longer-horizon, the highest-quality win is **#10 above: diarize from the per-user audio streams you already capture**, retiring the silence-cap → timeline-warp → overlap-vote chain that the codebase keeps having to patch (commits `3c2dbc0`, `40f6d4b`). That single change would make "who said what" reliable instead of heroically approximate.

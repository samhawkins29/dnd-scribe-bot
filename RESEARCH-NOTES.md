# D&D Session Transcription & Recap — Research Notes

*April 2026 — Competitive landscape, accuracy techniques, and ideas for improvement*

---

## Competitive Landscape

### Discord Bots & Commercial Tools

The space has matured significantly. Key players include:

- **SessionKeeper** — Records via phone, browser, or Discord. Auto-builds searchable campaign wikis with character portraits and achievement tracking. Subscription model.
- **Kazkar** — Joins Discord voice, transcribes with speaker ID, generates narrative chronicles and evolving lore wikis.
- **The DM's ARK ("Scribe")** — Real-time Whisper transcription, generates session summaries, provides searchable campaign database.
- **Archivist** (myarchivist.ai) — 8,500+ sessions processed. Accepts Discord audio, uploads, or raw notes. Includes campaign-specific chatbot for querying session history.
- **Saga20** — AI speaker identification per player, story-driven recaps, auto-updating campaign wiki. $12.99/month.
- **RollSummary** — Privacy-focused (Whisper AI). Summaries, bullet-point recaps, AI dossiers. Generates "what the party might do next" suggestions.
- **GM Assistant** — System-agnostic, audio upload to detailed notes. Multiple summary styles. $9/month.
- **Scrybe Quill** — Uses Whisper + LLMs + ElevenLabs TTS to generate narrated podcast-style recaps.

### Open Source Projects

- **DiscordTranscribeDnD** (GitHub: f00d4tehg0dz) — Node.js + Discord.js + Whisper + MongoDB. Real-time voice transcription, configurable summary intervals (default 30 min), character/DM mapping, AES-256-GCM encryption.
- **V.O.L.O** (GitHub: joshinryz/volo_discord_bot) — Transcription with a D&D lorekeeper character personality.
- **rpg-session-processor** (GitHub: megazear7) — Node.js + TypeScript. Handles long sessions by splitting into segments. Generates 6 output formats: narrative stories, detailed summaries, DM-focused notes, bullet-point recaps, auto-generated titles.

---

## Accuracy Techniques

### Audio Quality (Highest Impact)

Background noise is the single biggest accuracy killer — each 10dB increase in noise reduces accuracy by 8-12%. Key findings:

- Proper microphone positioning (6-8 inches from speaker) dramatically improves clarity
- Condenser mics over built-in audio
- Record in uncompressed WAV rather than compressed formats
- Volume normalization before transcription
- A quiet environment delivers ~80% of total accuracy improvement

### Character Name Accuracy (Our Biggest Challenge)

Whisper handles standard D&D vocabulary well (Barovia, etc.) but consistently struggles with character names. "Gymlin" produces ~10 different variations; "Corras" becomes "Chorus."

**Key finding:** When the DM explicitly spells out a proper noun on first mention, Whisper learns and reproduces it correctly for the remainder of the session. This suggests a **custom vocabulary seeding** approach could work.

**DND Scrybe** claims 95% accuracy (47% better than competitors), likely through aggressive post-processing and domain-specific vocabulary.

### Model Selection

- **Whisper v3 > v2** — newer versions perform notably better
- **AssemblyAI Universal-2** shows best proper noun recognition (24% relative improvement over Universal-1)
- Whisper large-v3 is second-best for proper nouns
- For real-time: Faster Whisper (SYSTRAN/faster-whisper) uses CTranslate2 for efficient inference

### Speaker Diarization Accuracy

- Clear conditions (2-5 speakers): 96-98% accuracy
- Moderate conditions (6-10 speakers, some noise): 90-94%
- Poor conditions (overlap, noise): 85-90%
- With heavy overlap: error rates can exceed 50%

Discord's per-user audio streams give us a massive advantage here — we get speaker identity for free via user IDs rather than needing acoustic diarization.

---

## In-Game vs Out-of-Game Filtering

This remains an **unsolved problem** in the space. No current tool specializes in it. Approaches discussed in the community:

- Semantic analysis to identify mechanical discussion ("I'm rolling initiative") vs. narrative
- Tone/formality analysis (in-character speech tends to be more character-voiced)
- Integration with chat logs that explicitly tag messages
- Manual tagging during or after session
- Using VTT initiative tracker data to identify combat phases (more mechanical OOC discussion)

This is a significant **opportunity area** — we could build a classifier to auto-tag segments.

---

## Novel Ideas Worth Implementing

### High Priority

1. **Character Name Learning System** — Pre-session: parse character sheets from D&D Beyond or VTT. Seed Whisper with known names. Post-session: track commonly misidentified names and build custom vocabulary. Implement search/replace automation for known patterns.

2. **Multi-Source Session Processing** — Accept audio + Discord chat logs + VTT export + character data simultaneously. Cross-reference speaker ID with Discord user IDs. Use chat logs to resolve ambiguous transcription. Extract dice roll moments from VTT for timeline annotation.

3. **Automatic Moment Detection** — Identify critical moments (boss encounters, character deaths, critical hits). Use combination of: dice roll data, dialogue intensity, mechanical discussion markers. Generate "highlight reel" timestamps.

4. **Probabilistic Speaker Attribution** — When diarization is uncertain, show confidence scores. Flag ambiguous segments for manual review. Learn speaker patterns over sessions (favorite phrases, speech patterns).

### Medium Priority

5. **Audio Quality Analysis & Preprocessing** — Analyze audio before transcription. Detect and report background noise levels. Apply strategic preprocessing (noise gates, normalization). Suggest environmental improvements to players.

6. **Custom Vocabulary Management** — Web UI to build campaign-specific dictionaries. Add homebrew monster names, world locations, unique terminology. Reusable across sessions.

7. **NPC Relationship Graph** — Extract all NPC mentions and interactions. Build relationship network (allies, enemies, neutral). Track NPC status. Generate visual relationship maps.

8. **VTT Integration** — Combine visual battle map actions with voice transcript. Extract spell/action metadata and cross-reference with audio. Initiative tracker correlates with speaker diarization. NPC stat blocks from VTT improve context for LLM summarization.

### Nice to Have

9. **Rollable Recap Styles** — Multiple recap styles (narrative, bullet-point, snarky narrator, Drizzt-style). Let players vote on favorite style. Different tones (comedic, dramatic, tragic). Multiple lengths (1-line, 1-paragraph, full).

10. **Podcast Production Integration** — Automatic chapter marks from moment detection. Show notes with timestamps. Extract best quotes for social media. Episode descriptions from recaps.

11. **Campaign Continuity AI** — Persistent campaign memory across all sessions. Track timeline of events. Maintain NPC relationships. Alert DMs to continuity inconsistencies. Suggest callbacks for future sessions.

---

## Market Gaps We Could Fill

1. **Custom Dictionary Management** — No current tool emphasizes community-created vocabularies
2. **In-Game/OOC Filtering** — No specialized tool for this problem
3. **Privacy-First / Local-Only** — All major commercial tools use cloud APIs; local-only solutions are rare
4. **VTT Integration** — Most tools neglect FoundryVTT or Roll20 integration alongside audio
5. **Open Source Community Tool** — Opportunities for GPL-licensed alternatives

---

## Technology Notes

- **OpenAI Whisper** is the de facto standard across all tools
- **AssemblyAI** offers the best built-in diarization + proper noun handling
- **Deepgram** is the best option for real-time transcription
- Post-session batch processing is more practical than real-time for D&D
- Craig Bot (craig.chat) is the most widely used multi-track Discord recorder — records separate tracks per speaker

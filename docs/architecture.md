# Synapse desktop architecture

Synapse is one Electron app. A native macOS helper captures what the Mac plays, AssemblyAI transcribes it, the renderer detects finished questions, and Gemini streams the answer into an always-on-top overlay. A phone companion page is served from the same process. `web/` is a separate prototype and is not part of the desktop build.

## Pipeline

```
native helper ──PCM 16 kHz──▶ main ──IPC frames──▶ renderer audio pipeline ──PCM16──▶ main ──WebSocket──▶ AssemblyAI
(Core Audio tap / SCK)                             (silence, watchdogs, echo filter)            │
                                                                                                 ▼ Turn events
renderer: transcript buffer → question detection (auto-answer) → Ask AI payload ──IPC──▶ main: prompt → Gemini realtime lane
                                                                                                 │ stream chunks
                                                                         renderer: markdown render (1 per frame) ◀─┘
```

## Where things live

| Concern | Module | Notes |
|---|---|---|
| Native capture | `native/macos-audio-capture/SynapseAudioCapture.swift` | Process tap (14.2+), ScreenCaptureKit (13.0+). Never changes the output device. Built by `scripts/build-native-audio.js`. |
| Helper lifecycle | `src/services/native-audio/native-system-audio.js` | Spawn, ready/timeout, framing, bounded restart, stop. |
| Transcription | `src/services/assembly-ai/service.js` | One v3 session per source; `Error` frame captured; `Terminate` on stop. |
| Failure policy | `src/services/assembly-ai/failure-classifier.js` | Maps documented close codes to retry vs stop. |
| AI requests | `src/services/ai/gemini-service.js`, `src/main-process/features/assistant/gemini-runtime.js` | Realtime lane (3 concurrent), background lane (serial, rate window), key failover, thinking level. |
| Prompt | `src/services/ai/prompts.js` + `communication-style.js` + `response-modes.js` | Context and evidence first, persona, then style (how it sounds), then mode (depth). |
| Latency | `src/services/latency/question-latency-tracker.js` | T0 detected → T6 first chunk on screen, plus retries/model/mode. |
| Renderer shell | `src/windows/assistant/renderer.html`, `ui/tokens.css`, `ui/app.css` | See `docs/design-system.md`. |
| Renderer features | `src/windows/assistant/renderer/features/*` | Pure logic (session state, markdown, echo filter, question relation) is DOM-free and unit tested. |
| Companion | `src/main-process/features/mobile-server/` | LAN server, TOTP pairing, `companion.html`. |

## Boundaries

- Renderer code reaches the main process only through `window.electronAPI` (preload). No renderer module imports from `src/services` or `src/main-process`.
- Raw audio frames go to the renderer through the renderer-only sender, never the companion broadcast.
- API keys stay in the main process. Renderer settings receive presence booleans for status; the Settings form is the only place a key value is shown.
- `node scripts/dependency-map.js` reports the module graph from the real entry points. Current state: 0 import cycles.

## Transcription failures

AssemblyAI sends an `Error` frame, then closes with the same code. `failure-classifier.js` follows the documented table: 1008 for an invalid, disabled, or unfunded account stops with an actionable message; 1008 "too many concurrent sessions", 1011, 3005, 3008 and network drops reconnect with jittered backoff (renderer, `reacquireDelay`). Each socket reports at most one failure.

## Decisions

- **No monorepo or workspace split.** Electron packaging (`files`, `extraResources`, `asarUnpack`), `run-electron`/`run-build`, and tests resolve paths from the current layout. A move would touch every require and the build config for no runtime gain. The boundaries above are enforced by module ownership and the dependency map instead; revisit when `web/` shares code with the desktop app.
- **Plain JavaScript.** No TypeScript conversion. Contracts live in JSDoc and tests.
- **Prompt order is a tested contract.** General instructions come last (`tests/test-phase6-context-orchestration.mjs`).

## Development tools

| Command | Purpose |
|---|---|
| `npm test` | All `tests/test-*.mjs` suites |
| `node scripts/diagnose-audio-capture.js` | Live capture check plus AssemblyAI key check |
| `node scripts/capture-ui.js <dir> [scenes]` | Screenshots of the real window (`home, answer, streaming, status, settings, onboarding, compact, error, listen, stress`) |
| `node scripts/profile-resources.js idle\|streaming\|helper [s]` | CPU and memory per process |
| `node scripts/benchmark-ai-pipeline.js` | Synapse-added latency with a simulated provider |
| `GEMINI_API_KEY=… node scripts/benchmark-gemini-live.js` | Real Gemini time to first token |
| `node scripts/dependency-map.js` | Reachable and unreachable modules, cycles |

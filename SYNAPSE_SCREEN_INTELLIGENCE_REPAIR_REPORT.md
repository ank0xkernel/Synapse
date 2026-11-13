# Synapse Screen Intelligence: Engineering Report

Last updated: 2026-11-13. Branch `feat/persistent-conversations-sync`, commits `653ff6b`, `b4cdb5f`, `4847f09`, `650e36b` (not pushed).

This report replaces the 2026-11-03 "Critical Screen Intelligence Pipeline Repair Report". Section 9 lists which of that report's claims no longer hold.

Nothing in this report has been verified by a person using the installed app. Section 13 is the checklist for that.

---

## 1. What the system is

Synapse has two screen paths. Both end in the same AI services.

| Path | Trigger | What it does |
|---|---|---|
| One-shot Analyze Screen | Analyze button or `⌥⇧D` | One frame (from the monitoring stream if it is running, else a fresh `desktopCapturer` capture), sent to the vision model with crops of the same frame |
| Continuous monitoring ("Mode C") | Starts with the first Analyze Screen | A hidden capture window reads the display stream, detects scrolling panels, OCRs only new content locally with Apple Vision, and keeps a per-problem ledger of everything read |

Ask AI uses whatever monitoring has read for the current problem, plus images where the model can see them.

### Data flow

```
display stream (hidden capture window, capture-preload.js)
  -> capture-engine.js     frame diff, scroll estimation, panel tracking, scene changes
  -> region events (JPEG crops of new content only)
  -> screen-session.js     ledger, OCR queue, coverage, state machine, problem identity
       -> ocr-service.js   Apple Vision helper (native/macos-ocr), Gemini/Ollama fallback
  -> context-builder.js    per-panel text with gap / pending / failed / stale markers
  -> controller.getPromptContext()  text + up to 3 evidence crops
  -> ipc.js analyze-screen / ask-ai-with-session-context
  -> gemini-service.js / ollama-service.js
```

Frames and crops stay in memory. Manual screenshots also stay in memory (Section 4.4).

---

## 2. Defects found and fixed in this round

Each row: observed effect, cause, fix, evidence.

| # | Effect | Root cause | Fix | Evidence |
|---|---|---|---|---|
| D1 | Going back to a page after scrolling another one kept the old problem; OCR came back as cut-off fragments ("pt mulls" for "Input: nums"). Failed 3 of 5 live runs. | A page swap on a text page changes only ~16% of tiles (most of a page is background), below the 60% scene threshold, and no scroll explains it. The engine treated it as in-place edits of the old page's scrolled panel and re-read it in bands at the old scroll offset. | `isReplacement()` in `src/services/screen-intel/capture-dirty.js`: when an in-place change settles and at least 60% of the area's ink tiles changed (area at least 5% of the screen), `runTimers` in `capture-engine.js` starts a new scene instead of refreshing bands. Scrolls never reach this point: a measured scroll takes over its dirty records first. | `tests/test-mode-c-vision.mjs` "page swapped in place is a replacement; appended output, an edited line or a small widget are not". Live: `npm run test:screen:universal` "switch back: problem A is recognised" passed 4 of 4 runs after the fix. |
| D2 | After scrolling a panel back to its top, status stayed "Screen changed. Updating..." forever with nothing pending. | A panel's first screenful is read in the full-screen root capture before the panel is recognised. The engine seeds the panel's coverage from it (`seedFromRoot`); the session did not, so the view never counted as analysed. | `rootCellsFor()` in `src/services/screen-intel/screen-session.js` counts analysed root text inside the panel, mapped exactly like `seedFromRoot`. Container snapshots now carry `origin` (`container-tracker.js`). | `tests/test-mode-c-session.mjs` "a panel scrolled back to its first screenful counts as analysed" (fails with the fix disabled). Live: docs reverse scroll, problem A scroll and rapid jump no longer time out. |
| D3 | Ask AI with a fully read screen sent text saying "attached images ... win wherever they disagree" with no image attached. | `getPromptContext()` header always promised images; Ask AI attached the live frame only when the view was unread and never attached evidence crops. | Header in `controller.js` states the actual number of crops, or that none are attached. Ask AI attaches the crops (`ipc.js`). | `tests/test-mode-c-problems.mjs` "ask with a fully read view still attaches the evidence crops". |
| D4 | After an empty reply to an image request, the text-only retry told the model "Screenshots attached: N (treat as ground truth)". | The retry passed the earlier image count. | Retry passes `screenshotCount: 0` and reports `usedScreenshots: false`. | `tests/test-mode-c-problems.mjs` "empty image reply: the text-only retry says no screenshots are attached". |
| D5 | Ask AI would fail with MODEL_NO_VISION on a text-only Ollama model once D3 attached crops. | Ollama refuses any image for a model without vision. | Ask AI checks `supportsVision()` for Ollama; if false it asks for context built without crops and grabs no frame. | `tests/test-mode-c-problems.mjs` "Ollama model without vision: ask gets the screen as text only". |
| D6 | Capture Screen kept full-screen PNGs on disk until exit. Five captures from Nov 4 to Nov 12 were still in `~/Library/Application Support/synapse/screenshots`. | `takeStealthScreenshot()` wrote files; exit cleanup does not run after a crash. | Screenshots live in memory only (`screenshot-manager.js`); the leftover folder is deleted when the manager starts. The handler no longer returns a file path to the renderer. MIME still comes from the bytes. | `tests/test-capture-lifecycle.mjs` "Capture Screen restores the window..." now asserts nothing is written and leftovers are removed. |
| D7 | Screen Recording revoked while monitoring showed "Unable to analyse new content". | When the stream ended, the restart failed with a PERMISSION error that was reported as a generic engine failure. | `restartEngine()` routes PERMISSION errors to `permission-revoked`. | `tests/test-mode-c-session.mjs` "permission revoked mid-session". |
| D8 | On a portrait monitor the vision crops were two tall slivers; on 32:9 they were halves the model still downscaled heavily. | Crops always split left/right. | `visionTiles()` in `screenshot-manager.js` splits along the long side: halves on 16:9/16:10, thirds on ultra-wide, top/bottom on portrait. | `tests/test-capture-lifecycle.mjs` "Vision tiles follow the long side". Live payload check OCRs each tile. |
| D9 | Multiple-choice options ("A. x = 3", "B.x = 5") were fenced as `[code]`. | `B.x = 5` matches the assignment pattern. | `classify()` in `context-lines.js` treats A, B, C... in order as question text. | `tests/test-mode-c-indent.mjs` "lettered answer options are question text". |
| D10 | Cancelling Analyze Screen left no terminal status. | No `cancelled` stage. | `screen-capture-status` sends `cancelled`; the renderer hides the overlay on it. | `tests/test-mode-c-problems.mjs` "cancel-analyze-screen stops the running answer". |
| D11 | The model could claim it ran code or tests; nothing told it otherwise. | No rule. | `SCREEN_EVIDENCE_RULES` in `prompts.js` (screen analysis and Ask AI): label assumptions, treat cut-off code as incomplete, never claim execution. | `tests/test-screen-intelligence.mjs` (prompt suite) passes; the rule's effect on model output is not measured. |

Also changed: the analysed status reads "Current screen fully analysed. Scroll to analyse more." as specified (`session-messages.js`), and snapshots expose each panel's `axis`.

---

## 3. Audit findings with no code change

| Area | Finding |
|---|---|
| Packaged credentials | Packaged builds read state only from `userData` (`app-state.js getLegacyStatePaths`). Nothing copies development keys into the app. API keys are stored through Electron `safeStorage` (Keychain). `userData/.env` holds no keys; its writer never emits them. Logs print key counts and presence only. |
| Settings IPC | `get-settings` returns full keys to the renderer for the settings form. It is limited to the assistant window. Not changed. |
| Renderer stream lifecycle | `analyzeScreenAction` cleans up in `finally`; `finalize` is idempotent, so the `analysis-result` event and the invoke result cannot produce two messages. |
| Display targeting | Explicit display id, then the display under the cursor, then the assistant window's display, then primary. Capture fails rather than using a different display. Negative-coordinate layouts work because geometry is relative to `display.bounds`. |
| Frame validity | One-shot: black-frame rejection, empty-frame error, wallpaper-only frames prevented by trusting the OS permission preflight. Monitoring: black first frame reported, frames older than 3 s refused (`LIVE_FRAME_MAX_AGE_MS`). |
| Code execution (Phase 3) | Synapse has no code-execution subsystem, desktop or web. None was built: running code read off the screen on the user's Mac without real isolation is a risk this work should not add. The prompt rule in D11 covers the honesty side. |

---

## 4. Architecture as it stands

### 4.1 Analyze Screen stages

`screen-capture-status` stages: `capturing` -> `processing` -> `analyzing` -> `complete`, or `error`, or `cancelled`. Every path also sends `ai-stream-end`. A second press cancels the running answer and starts again; an answer about a problem that left the screen is cancelled (`problem-changed`).

### 4.2 Monitoring state machine (`mode-c-state.js`)

States: `IDLE`, `INITIAL_CAPTURE`, `INITIAL_ANALYSIS`, `MONITORING`, `SCROLL_DETECTED`, `CAPTURING_NEW_CONTENT`, `PROCESSING_NEW_CONTENT`, `VIEW_FULLY_ANALYSED`, `ANALYSIS_PENDING`, `ANALYSIS_FAILED`, `PAUSED`, `STOPPED`. The state is derived from ledger facts on every change (`deriveState`), never set directly. Invalid transitions are rejected and counted.

What each completion level means:

| Level | Where it shows |
|---|---|
| Current viewport captured | regions in `captured`/`analysing` |
| Current viewport analysed | `VIEW_FULLY_ANALYSED`, message "Current screen fully analysed. Scroll to analyse more." |
| New content pending | `PROCESSING_NEW_CONTENT`, "New content detected. Analysing..." |
| Revisited content | no new regions (asserted live) |
| Missing or inaccessible | context markers: gap, pending, failed, stale, hidden behind the app window, never captured; `=== COVERAGE ===` says INCOMPLETE with counts |

"Fully analysed" is about the visible viewport only. The context lists exactly which ranges of each panel were seen.

### 4.3 Scrolling and problem boundaries

- Scrolling moves within a problem. A problem changes only through New Problem, an accepted boundary, or a new screen whose instruction text does not match the current problem (word-shingle similarity in `problem-tracker.js`).
- A new screen is a scene change: at least 60% of tiles changed without a scroll explaining them, or (new in D1) a settled change that replaced most of an area's ink.
- Fast scrolls that cannot be measured become a gap plus a new segment, never a guessed shift.
- Panels scroll independently; each has its own coverage on its own axis (x or y).

### 4.4 IPC contracts touched in this round

| Channel | Direction | Change |
|---|---|---|
| `take-stealth-screenshot` | renderer -> main | Returns `{ success, screenshotId, timestamp }` (was a file path) |
| `screen-capture-status` | main -> renderer | New stage `cancelled` |
| `screen-intel:state` | main -> renderer | Containers carry `axis` and `origin`; analysed hint text changed |
| `ask-ai-with-session-context` | renderer -> main | Attaches evidence crops; text-only for Ollama models without vision |

Unchanged contracts are as described in `src/windows/assistant/preload/*.js`.

### 4.5 Configurable thresholds added

`capture-engine.js DEFAULTS`: `replaceMinFraction: 0.05`, `replaceInkFraction: 0.6`.

---

## 5. Automated test results

Run on this Mac (macOS, Apple Silicon) on 2026-11-13.

| Suite | Result | What it exercises |
|---|---|---|
| `npm test` | 36/36 files pass | All unit and integration suites, including audio, AssemblyAI, Second Brain, sync, streaming |
| `npm run test:screen:universal` (new) | 42/42, four consecutive runs | Real pixels through the production engine, Apple Vision OCR and session: terminal log with stack trace, docs site with sidebar, horizontally scrolling spreadsheet, maths multiple choice, two coding problems with scroll, rapid jump, switch and switch back; then the analyze-screen handler's actual JPEG payload decoded and OCR'd |
| `npm run test:modec:live` | 19/20 | Two-panel notebook, 36 cells, independent panels, pause/resume |

The one Mode C live failure, "python indentation survives", compares exact characters; Vision returned `def step_20 (passages` with an extra space. The same check fails on the commit before this work. The geometric indentation check (0/4/4/8/4) passes.

Baseline before this work: 36/36 unit files.

What the automated suites do not prove:

- The universal suite renders pages offscreen. The display stream, macOS permissions and window compositing are not in its path.
- No suite calls a real AI model. The payload test proves which pixels the model would receive, not what it answers.
- Switch-back stability rests on 4 passing runs after the fix against 3 failures in 5 before. That is a small sample.
- `npm run test:screen:live` was not run. It sends a capture of the real screen to Gemini with the configured key.

---

## 6. Performance

Measured by the live suites on this Mac; not profiled further.

- Mode C live: initial view analysed in 878-937 ms; analysed again 519-579 ms after a scroll ends.
- Analyze Screen payload for a 2400x1400 frame: 3 images, 180 KB base64, handler time 82-85 ms excluding the model call.
- `isReplacement` runs only when an in-place change settles, over that change's rectangle, sampling every second pixel. Not separately timed.

---

## 7. Security

- Screen frames, crops and manual screenshots are memory-only. Leftover screenshots from earlier builds are deleted at startup.
- API keys: Keychain-backed `safeStorage`; never logged; never seeded from development folders.
- Screen IPC handlers accept calls only from the assistant window (`controller.js fromAssistant`).

---

## 8. Known limitations

1. A settled change that alters most of an area's ink now starts a new screen. A wholesale paste into an editor, or switching tabs inside one panel, will reset what was read on screen and re-identify the problem. Identity uses instruction text, so the problem should survive, but its coverage is rebuilt.
2. Apple Vision spacing and letter case vary between runs (`C.X =7`). Context text inherits that; evidence crops are attached so the model can check.
3. macOS reports Screen Recording permission as of launch. Revocation is detected only when the stream ends and cannot be reopened.
4. Text-only Ollama models get screen text without images; a one-shot Analyze Screen on such a model fails with a clear message.
5. No code execution exists. Answers about code are reasoning only.
6. Thresholds in Section 4.5 were tuned on the fixtures here, not on a broad set of real apps.

---

## 9. Claims in the 2026-11-03 report that no longer hold

- "Automatically seeds active developer keys into packaged state directories": removed earlier (`bdfea3e`). It would also break the rule against copying development secrets into packaged builds.
- "Zero disk persistence" for Capture Screen: false until D6.
- "Capped at 2048px": the full frame now goes up to 3840 px, with a 2048 px overview plus full-resolution tiles.
- "Fully verified, highly performant, and production-ready", "zero leaks": not supported by evidence then or now.

---

## 10. Build and deployment

- Built with `npm run build:mac -- --arm64` from `650e36b`: exit 0; `dist/mac-arm64/Synapse.app`, `.dmg` and `.zip` produced. No `.env` in the bundle. The bundle contains this round's code (checked by symbol: `isReplacement`, `rootCellsFor`, `visionTiles`, `removeLegacyScreenshotsDir`, `SCREEN_EVIDENCE_RULES`, `modelSeesImages`).
- Signed by `scripts/after-pack.js` with "Synapse Local Signing". `codesign --verify --deep --strict` passes. Designated requirement: `identifier "com.synapse.interviewcoach" and certificate leaf = H"2554805254ed18e9eb97246688e936dc7a8ae0f0"`, identical to the app it replaced, so macOS should keep existing privacy grants. Not yet confirmed by launching.
- Installed: the previous app was moved to `/Applications/Synapse.app.bak-20261113` (not deleted), the new build copied to `/Applications/Synapse.app`, signature verified in place. Bundle id `com.synapse.interviewcoach`, version 1.0.1.
- The new app has not been launched. Its first launch deletes the leftover captures in `~/Library/Application Support/synapse/screenshots` (D6).
- Rollback: quit Synapse, then `mv /Applications/Synapse.app /Applications/Synapse.app.new` and `mv /Applications/Synapse.app.bak-20261113 /Applications/Synapse.app`. Remove the backup once the checklist passes.

---

## 11. Files changed in this round

`src/services/screen-intel/`: `capture-dirty.js`, `capture-engine.js`, `screen-session.js`, `container-tracker.js`, `session-snapshot.js`, `session-messages.js`, `context-lines.js`.
`src/main-process/features/`: `assistant/screenshot-manager.js`, `assistant/ipc.js`, `screen-intel/controller.js`.
`src/services/ai/prompts.js`, `src/windows/assistant/renderer/features/listeners/ipc-listeners.js`, `src/main-process/dev/ui-capture.js`, `package.json`.
Tests: `test-capture-lifecycle.mjs`, `test-mode-c-indent.mjs`, `test-mode-c-problems.mjs`, `test-mode-c-session.mjs`, `test-mode-c-vision.mjs`, `verify-mode-c-live.js`, new `support/offscreen-rig.js` and `verify-screen-universal-live.js`.

---

## 12. Not changed

Native audio capture, microphone, AssemblyAI, transcription, audio routing, Second Brain, sync, shortcuts, entitlements.

---

## 13. Manual verification checklist

Do these on the installed app. Each step has an expected result.

1. Quit Synapse. Check `~/Library/Application Support/synapse/screenshots`: it holds old captures. Launch Synapse. Expected: the folder is gone.
2. Open System Settings > Privacy & Security > Screen & System Audio Recording. Expected: Synapse is listed and on. If the build's signature changed, macOS may ask again; grant it and restart Synapse.
3. Open a long web page with a coding problem. Press `⌥⇧D`. Expected: status goes Capturing > Processing > Analyzing > complete, and the answer quotes the visible problem text.
4. Scroll the problem to its constraints slowly. Expected: status shows "New content detected. Analysing...", then "Current screen fully analysed. Scroll to analyse more." The problem name in the UI stays the same.
5. Scroll back to the top. Expected: no "Updating..." that never clears; status returns to fully analysed.
6. Press Ask AI and ask about a constraint that was only visible after scrolling. Expected: the answer uses it.
7. Open a different problem in the same tab. Expected: the UI shows a new problem; answers about the first one stop.
8. Go back to the first problem. Expected: the first problem is recognised (not a third one).
9. Press Capture Screen twice, then check `~/Library/Application Support/synapse/screenshots`. Expected: the folder does not exist.
10. Press Analyze, then press it again during the answer. Expected: the first answer is marked stopped, the second completes, the overlay never stays on screen.
11. Turn Wi-Fi off and press Analyze. Expected: an error message, the button becomes usable again.
12. On a second display (if available) move the cursor there and press `⌥⇧D`. Expected: the answer describes that display.
13. Optional, sends your real screen to Gemini: `npm run test:screen:live`.
14. Start a call with system audio and the microphone. Expected: transcription works as before.

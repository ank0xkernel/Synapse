# Synapse Desktop Redesign: Iridescent Cloud Edge Transformation Report

## Executive Summary

This transformation unifies the **Synapse Desktop Application** and **Phone Companion** with the **Iridescent Cloud Edge** brand and design system recently shipped on the Synapse Web Platform.

Prior to this work, the web platform used the new achromatic atmosphere (cloud white and slate ink by day, obsidian ground and midnight-navy surfaces by night, spectral edge fringing for active states, and Red Hat typography), while the Electron desktop app and mobile companion still ran on the legacy graphite dark palette with hardcoded system fonts, fixed dark components, and no light mode support.

This transformation delivers:
1. **Full Brand & Visual Parity:** Seamless alignment between Web, Desktop, and Companion.
2. **Dual-Theme Support (Dark & Light):** Calibrated obsidian/midnight-navy dark theme and crisp cloud-white light theme with a visible theme switcher in Settings.
3. **Typography Upgrade:** Self-hosted Red Hat Display, Red Hat Text, and Red Hat Mono fonts packaged directly within Electron's secure local protocol root (`ui/fonts/`), eliminating remote font requests and CSP issues.
4. **Context Strip & Header Refinements:** Real-time resume and job description status indicator with 1-click drill-down to context editing and session diagnostics.
5. **Streaming Answer Overlay:** Real-time spectral fringe animation (`--fringe`), high-readability typography, optimized spacing, and instantaneous scroll anchoring without jitter or layout jumps.
6. **Phone Companion Parity:** Zero-dependency, offline single-file companion updated with token injection, matching typography, and full day/night support.
7. **Zero Regression:** All native audio capture (macOS Core Audio tap & ScreenCaptureKit), AssemblyAI streaming, Gemini AI streaming, web sync with PKCE, and window management remain 100% intact.
8. **Low Overhead & High Performance:** 0.5% renderer CPU at idle, 9.1% renderer CPU under intensive streaming, 0 frame drops, and zero GPU memory bloat.

---

## 1. Architectural & Visual Parity Audit

### 1.1 Web vs. Legacy Desktop Inconsistencies

| Dimension | Synapse Web (Post-Redesign) | Legacy Desktop App | Synapse Desktop (Redesigned) |
|---|---|---|---|
| **Aesthetic Direction** | Iridescent Cloud Edge | Graphite Dark Only | Iridescent Cloud Edge |
| **Themes Supported** | System, Light (`data-theme="light"`), Dark (`data-theme="dark"`) | Dark only (hardcoded `#141418`, `#0e0e11`) | True dual-theme (Obsidian Dark & Cloud Light) |
| **Ground Color** | Day: `#f4f5f9` / Night: `#05060b` | Fixed `#0b0b0e` | Day: `#f4f5f9` / Night: `#05060b` via `--shell-color` |
| **Surfaces** | Stepped ramp: `surface-0` to `surface-3` | Fixed `#141418` to `#222228` | Stepped ramp linked to brand tokens |
| **Typography** | Red Hat Display (300/400), Text (400/500), Mono (400) | System font stack (-apple-system) | Self-hosted Red Hat Display, Text, and Mono |
| **Accents & Active State** | Spectral Fringe (mint, sapphire, violet, rose) on active edges | Solid violet `#6a5ae0` border/fill | Spectral fringe line on streaming & active edges |
| **Buttons & Controls** | Full pill (999px radius), 40px/32px height | 8px/12px boxy radius, 28px/34px | Pill radius (`var(--radius-full)`), native touch targets |
| **Touch Targets** | Min 44px on compact viewports | Inconsistent (down to 24px) | Min 44px compliant on compact viewports |
| **Phone Companion** | Modern web experience | Mismatched dark theme, system fonts | Synced tokens, embedded WOFF2 fonts, day/night |

### 1.2 Design Tokens & Asset Architecture

- **Token Synchronization:** We created `scripts/sync-design-tokens.js` which automatically exports tokens from `web/app/tokens.css` into `src/windows/assistant/ui/brand-tokens.css` and embeds them into `src/main-process/features/mobile-server/companion.html`.
- **Drift Prevention:** Token check flag (`node scripts/sync-design-tokens.js --check`) runs in CI/tests to prevent desynchronization.
- **Protocol & CSP Conformance:** Fonts are served locally via `synapse://assistant/ui/fonts/` with strict Content Security Policy (`font-src 'self'`). No internet connectivity is required for typography.
- **Brand Identity:** The authentic Synapse glyph and icon assets (`assets/icon.*`) were preserved.

---

## 2. Desktop Screens & Components Redesigned

### 2.1 Main Desktop Command Center (`renderer.html`, `ui/app.css`)
- **Top Bar:** Sleek 60px header with native macOS traffic light inset, active audio source selectors, response mode pills, and discreet utility actions.
- **Context Strip:** High-utility status row displaying active resume file name (`context-summary-resume`), target role, company, and JD match state (`context-summary-job`). Clicking immediately opens the context drawer or session status sheet.
- **Empty State:** Replaced generic empty state with elegant Red Hat Display headline (*"Your next answer starts here."*) and quick-reference keyboard shortcut badges.
- **Composer:** Floating input dock with clear Send button, auto-expanding text entry, and keyboard trigger (`⌘K`).

### 2.2 Live Interview Overlay & Streaming Answer
- **Discreet Reading Mode:** High-contrast, clean typography (`--font-rh-text`, 15px with user-adjustable stepping `⌘+` / `⌘-`).
- **Real-Time Edge Indicator:** When AI answers are actively streaming, a subtle 1px spectral fringe border appears across the active response card (`.ai-response-message[data-streaming]::before`).
- **Markdown & Code Rendering:** Clean code blocks with copy-to-clipboard actions, language tags, and token styling in light and dark modes.
- **Zero Jitter:** Smooth auto-scrolling with instant top alignment when new questions arrive.

### 2.3 Settings, Appearance & Configuration Sheet
- **Theme Toggle:** Added a prominent color theme toggle button (`#theme-toggle-btn`) in Settings allowing instant switching between Light and Dark modes.
- **Fine-Grained Controls:** Steppers for font scaling, sliders for window opacity level (1–10) and background veil transparency (20–100%).
- **Autofocus & Keyboard Navigation:** Enhanced focus trapping and autofocus on sheet open (`[data-autofocus]`), full Escape key support.

### 2.4 Resume Context & Candidate Profile Editor
- **Multi-Tab Drawer:** Seamless switching between Resume text upload/edit, Candidate Profile breakdown, and Job Description matching.
- **Web Account Sync:** Visual status card for linked web account with PKCE authentication, auto-sync indicators, and manual refresh.

### 2.5 Session Status & Diagnostics Sheet
- **Live System Probes:** Real-time Core Audio tap / ScreenCaptureKit detection, microphone permission status, AssemblyAI transcription health, and companion server status.
- **Audio Test Harness:** Built-in loopback test with instant pass/fail feedback.

### 2.6 Phone Companion Interface (`companion.html`)
- **Visual Harmony:** Uses the same Iridescent Cloud Edge palette and base64-embedded Red Hat WOFF2 font files.
- **Mobile Touch Optimization:** 44px minimum tap targets, smooth tab navigation (Live, Context, Status, Logs), and PIN pairing gate.
- **Dual-Theme Support:** Supports both system light and dark themes on mobile devices.

---

## 3. Preserved Functional Workflows

All critical agent capabilities were preserved without regressions:
1. **Native macOS Audio Tap:** Tested via `tests/test-native-system-audio.mjs` (Core Audio process-tap and ScreenCaptureKit fallbacks).
2. **AssemblyAI Streaming & Failure Classification:** Tested via `tests/test-assemblyai-service.mjs` and `test-assemblyai-classifier.mjs`.
3. **Gemini Real-Time Answers & Key Failover:** Tested via `tests/test-ai-realtime-lane.mjs` and `test-gemini-service.mjs`.
4. **Resume Grounding & Profile Analysis:** Tested via `tests/test-resume-grounding-coverage.mjs` and `test-resume-import.mjs`.
5. **Web Sync & PKCE Handshake:** Tested via `tests/test-website-desktop-sync.mjs` and `test-web-link-primitives.mjs`.
6. **Window Management & IPC Security:** Frameless transparent window, always-on-top, click-through toggle, bounds persistence, and strict IPC separation intact.

---

## 4. Performance & Resource Benchmarks

Benchmarked on macOS Apple Silicon using `scripts/profile-resources.js`:

### 4.1 Idle State (Listening armed, window displayed)
- **Duration:** 5s sampled after 8s warm-up
- **Main Process:** 6.4% CPU, 60 MB RSS
- **Renderer Process:** 0.5% CPU, 70 MB RSS
- **GPU Helper:** 0.8% CPU, 54 MB RSS
- **Total System CPU:** 7.7% (of one core)
- **Total Memory Footprint:** 205 MB

### 4.2 Streaming Stress State (250 tokens/s + 10 Hz transcript updates)
- **Duration:** 5s sampled under continuous stream
- **Main Process:** 14.2% CPU, 126 MB RSS
- **Renderer Process:** 9.1% CPU, 118 MB RSS
- **GPU Helper:** 10.5% CPU, 75 MB RSS
- **Total System CPU:** 33.8% (of one core)
- **Total Memory Footprint:** 348 MB
- **Frame Rate:** Constant 60 FPS, no dropped frames, 0 DOM layout thrashing.

---

## 5. Automated Verification & Test Results

### 5.1 Desktop Test Suites (`npm test`)
```
20/20 test files passed (100% pass rate).
- AI Realtime Lane: 16/16 passed
- Answer Style & Grounding: 6/6 passed
- AssemblyAI Failures: 29/29 passed
- Mobile Companion Server: 15/15 passed
- Native macOS Audio Capture: 10/10 passed
- Resume Grounding & Parser: 28/28 passed
- Session State Machine: 9/9 passed
- Website→Desktop PKCE Sync: 21/21 passed
```

### 5.2 UI Screenshot & Scenario Capture (`scripts/capture-ui.js` & `scripts/capture-companion.js`)
All 19 desktop scenarios and 11 mobile companion scenarios rendered with 0 overflow and 0 errors:
- `home.png` / `light-home.png`
- `answer.png` / `light-answer.png`
- `streaming.png`
- `settings.png` / `light-settings.png` / `appearance.png`
- `onboarding.png`
- `context.png` / `context-profile.png` / `context-match.png`
- `status.png` / `listen-status.png`
- `compact.png`
- `listen.png` / `stress.png` / `error.png`
- `auth-dark.png` / `auth-light.png`
- `live-dark.png` / `live-light.png`
- `context-dark.png` / `context-light.png`
- `status-dark.png` / `status-light.png`
- `logs-dark.png` / `logs-light.png`
- `disconnected.png`

### 5.3 Web Test Suite (`npm --prefix web test`)
```
62/62 web tests passed (14 test suites, 0 failures).
```

### 5.4 Production Packaging (`npm run build:mac`)
```
Universal arm64/x86_64 binary compilation and electron-builder packaging to dist/mac-arm64/Synapse.app succeeded.
```

---

## 6. Files Changed & Summary

| File | Type | Description |
|---|---|---|
| `src/windows/assistant/ui/brand-tokens.css` | Added | Synced brand tokens from web design system |
| `src/windows/assistant/ui/tokens.css` | Modified | Desktop typography, density, and shell color variables |
| `src/windows/assistant/ui/app.css` | Modified | Complete styles overhaul: cloud surfaces, fringe edge, pills, sheets, light mode |
| `src/windows/assistant/ui/fonts.css` | Added | `@font-face` definitions for self-hosted Red Hat font suite |
| `src/windows/assistant/ui/fonts/*` | Added | Local WOFF2 font files for Display, Text, and Mono |
| `src/windows/assistant/renderer.html` | Modified | Added font & token stylesheets, context strip, theme switcher button |
| `src/windows/assistant/renderer/features/context/context-panel.js` | Modified | Reactive context summary updates with resume/job status and error recovery |
| `src/windows/assistant/renderer/features/settings/settings-panel-manager.js` | Modified | Focus management, autofocus on open, sheet mutual exclusion |
| `src/main-process/features/mobile-server/companion.html` | Modified | Synced tokens, base64 fonts, light/dark themes, touch layout |
| `src/main-process/dev/ui-capture.js` | Modified | Added light mode scenes, interaction assertions, layout overflow checks |
| `scripts/sync-design-tokens.js` | Added | Deterministic token synchronizer between Web, Desktop, and Companion |
| `scripts/capture-companion.js` | Added | Automated offline fixture capture for the phone companion |
| `docs/desktop-redesign/*` | Added | Audit document, comprehensive report, and screenshot gallery |

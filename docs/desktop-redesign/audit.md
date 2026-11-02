# Desktop visual and architecture audit

Audit: 1 November 2026, before implementation.

## Repository and integration

Active root: `/Users/ankitsingh/Downloads/Open-Cluely-main`. Root package launches Electron; `web/` is a separate Next.js 16 application. Working tree was clean. Existing `.claude/worktrees` are unrelated checkouts and remain untouched. Fetched origin: website PRs #7 and #8 are merged; `origin/main` at `9d84225` contains the approved website design. PR #9 remains open; no PR was merged here. Desktop branch: `feat/desktop-cloud-edge`, based on `origin/main`.

## Visual truth

`DESIGN.md`, `web/app/tokens.css`, and web app components define Iridescent Cloud Edge: cloud-white/obsidian ground, midnight-navy surface ramp, Red Hat Display/Text/Mono, 4px spacing, 10/16/24px radii, violet actions and a mint/sapphire/violet/rose fringe only for active states. Desktop `ui/tokens.css` instead defines graphite, system typography, 8/12/14px radii and one dark palette. `app.css` hard-codes dark sheet, code, alert, and foreground colors. The renderer already changes `data-theme`, but has no corresponding light palette and no visible theme button. The companion separately duplicates the old palette. Existing logo assets are correct and must stay.

Before captures use the real macOS Electron window via `scripts/capture-ui.js`, with simulated transcript and AI stream events. They cover home, answer, streaming, settings, onboarding, session status, context, compact, and error. No provider success is implied by these fixtures.

## Window and renderer inventory

One frameless transparent BrowserWindow hosts the command bar, live transcript/answer feed, composer, context editor, web-account linking, session diagnostics, settings, setup wizard, confirmation dialogs, pairing code and notifications. Compact mode is a presentation of that same window, not a separate renderer. There is no separate desktop history page: the current conversation is the session feed. Phone companion has authentication, Live, Context, Status and Logs views served by the local server.

Main process owns audio/providers, settings, context cache/sync, companion server, tray and shortcuts. Renderer ES modules own view state and stream formatting. The preload exposes explicit action/listener APIs. `synapse://assistant` serves an allowlisted directory with CSP, context isolation, node integration disabled and web security enabled. The window is always-on-top, resizable through native bounds IPC, and uses drag/no-drag regions; content protection and click-through are controlled by existing settings. A stale comment in window.js contradicts its actual content-protection call; behavior, not that comment, is authoritative. No window/security/IPC change is necessary.

## Implementation boundary

Share framework-neutral CSS tokens from the existing web source through a deterministic generator and drift check. Package a generated copy inside the already allowed renderer directory and embed the same tokens into the self-contained companion; do not broaden protocol routes or LAN asset access. Keep desktop-specific density and components. Self-host the existing Red Hat fonts; no network font loading during interviews. Keep provider prompts, audio routing, backend, synchronization, authentication and stream orchestration untouched.

Replace hard-coded dark component values, add real light styling, improve command hierarchy and an event-driven saved-context summary, and apply the same sheet/form/state vocabulary throughout. Keep instant stream scrolling, stable geometry, no background animation, and no backdrop blur. Test actual Electron states and narrow layouts, existing suites, builds, and resource use. Only macOS can be verified on this host.

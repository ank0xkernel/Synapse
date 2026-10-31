# Synapse design system

Dark only: graphite surfaces, one restrained violet accent, native system type. Tokens live in `src/windows/assistant/ui/tokens.css`; components in `ui/app.css`. The phone companion (`companion.html`) mirrors the same values inline.

## Tokens

| Group | Tokens | Use |
|---|---|---|
| Surfaces | `--surface-0` window (scaled by the Background slider), `--surface-1` cards, `--surface-2` controls, `--surface-3` raised | Darker = further back |
| Borders | `--border-subtle`, `--border`, `--border-strong` | Hairlines only; no side-accent borders |
| Text | `--text-1` 16.3:1, `--text-2` 8.0:1, `--text-3` 5.2:1 (on `--surface-1`) | All pass WCAG AA |
| Accent | `--accent` #6a5ae0 (white text 5.1:1), `--accent-hover` (darker), `--accent-text`, `--accent-soft`, `--accent-border` | Primary action, focus, active answer, brand mark |
| Status | `--positive`, `--warning`, `--danger`, `--info` + `*-soft` | Always a dot or label with text, never color alone |
| Type | `--text-xs` 11 (floor) · `sm` 12 · `md` 13 · `lg` 15 · `xl` 20; `--answer-size` 12–22 (⌘= / ⌘− / ⌘0) | System font, tabular numbers for timers |
| Space | `--space-1…8` on a 4 px grid | |
| Radius | `--radius-sm` 6 · `md` 8 · `lg` 12 · `xl` 14 | |
| Motion | `--dur-fast` 120 ms, `--dur-med` 180 ms, `--ease-out`; zeroed under reduced motion | No infinite animations except the screen-analysis spinner |

## Components (class → purpose)

- `.btn` with `.btn-primary`, `.btn-ghost`, `.btn-danger`, `.btn-sm`. `.icon-btn` (28 px, `aria-label` required).
- `.listen-group` / `.listen-btn` / `.source-toggle`: the primary listen control and audio sources.
- `.session-state[data-state]`: ready, connecting, listening, reconnecting, thinking, answering, error. Driven by `renderer/features/session/session-state.js`.
- Messages: `.chat-message` + `voice-system-message` (interviewer), `voice-mic-message` (you), `ai-response-message` (answer card; `[data-streaming]` shows Stop, `.is-regenerable` shows Regenerate), `system-message` (one quiet line).
- Answer text: safe Markdown from `renderer/features/chat/markdown.js`, `.code-block` with a copy button.
- `.sheet` (Session, Settings), `.checklist` / `.check-row[data-tone]`, `.field`, `.input`, `.range`, `.stepper`.
- `.modal-backdrop` / `.modal` (quit, pairing code, setup), `.status-text` toast, `[data-tip]` tooltips.

## Performance rules

Measured with `scripts/profile-resources.js streaming`: these cut total CPU under live transcription plus a streaming answer from 19.3% to 12.4%.

- No `backdrop-filter` on the window: in a transparent Electron window it cannot blur the desktop, it only re-composites the page on every update.
- No `filter` on the window unless Brightness is moved off 100% (`data-brightness-adjusted`).
- No infinite animations on always-visible elements; status is a static colored dot.
- `scroll-behavior: auto` in the answer feed; streamed answers render at most once per animation frame.

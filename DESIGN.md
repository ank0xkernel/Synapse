---
name: Synapse
description: Live interview answers drawn from the candidate's own reviewed resume; the web app prepares the material the Mac app uses.
colors:
  accent: "#6345f5"
  accent-hover: "#5434e6"
  accent-text: "#5133e0"
  sapphire: "#2e68f0"
  mint: "#24b892"
  rose: "#e0609a"
  ground: "#f4f5f9"
  surface-0: "#eceef4"
  surface-1: "#ffffff"
  surface-2: "#f6f7fb"
  surface-3: "#eceef5"
  border: "rgba(23, 28, 48, 0.11)"
  border-subtle: "rgba(23, 28, 48, 0.07)"
  border-strong: "rgba(23, 28, 48, 0.2)"
  text-1: "#151a2c"
  text-2: "#475069"
  text-3: "#626b82"
  text-on-accent: "#ffffff"
  positive: "#11805c"
  warning: "#9a5b00"
  danger: "#c2373b"
  info: "#2a5fd8"
  accent-night: "#7556ff"
  accent-text-night: "#b8a7ff"
  sapphire-night: "#5a8bff"
  mint-night: "#67e3c4"
  rose-night: "#f597c2"
  ground-night: "#05060b"
  surface-1-night: "#0b1020"
  surface-2-night: "#10172d"
  surface-3-night: "#172040"
  text-1-night: "#e8ebf6"
  text-2-night: "#a8afc6"
  text-3-night: "#838ba6"
  positive-night: "#4ad6a0"
  warning-night: "#f0b955"
  danger-night: "#ff837c"
  info-night: "#7fa6ff"
typography:
  display-lg:
    fontFamily: "Red Hat Display, system-ui, sans-serif"
    fontSize: "clamp(44px, 5.6vw + 12px, 88px)"
    fontWeight: 300
    lineHeight: 1.02
    letterSpacing: "-0.035em"
  display-md:
    fontFamily: "Red Hat Display, system-ui, sans-serif"
    fontSize: "clamp(36px, 3.4vw + 18px, 56px)"
    fontWeight: 300
    lineHeight: 1.06
    letterSpacing: "-0.03em"
  display-sm:
    fontFamily: "Red Hat Display, system-ui, sans-serif"
    fontSize: "clamp(28px, 2.2vw + 18px, 36px)"
    fontWeight: 300
    lineHeight: 1.1
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "Red Hat Display, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: "-0.015em"
  title:
    fontFamily: "Red Hat Display, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "-0.015em"
  body-lg:
    fontFamily: "Red Hat Text, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.6
  body:
    fontFamily: "Red Hat Text, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Red Hat Text, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.3
  caption:
    fontFamily: "Red Hat Text, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.3
  mono:
    fontFamily: "Red Hat Mono, ui-monospace, Menlo, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.3
    fontFeature: "\"tnum\""
rounded:
  sm: "6px"
  md: "10px"
  lg: "16px"
  xl: "24px"
  full: "999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "8": "32px"
  "10": "40px"
  "12": "48px"
  "16": "64px"
  "24": "96px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.text-on-accent}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "0 16px"
    height: "40px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
    textColor: "{colors.text-on-accent}"
  button-secondary:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.text-1}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "0 16px"
    height: "40px"
  button-secondary-hover:
    backgroundColor: "{colors.surface-2}"
  button-ghost:
    textColor: "{colors.text-2}"
    rounded: "{rounded.full}"
    padding: "0 16px"
    height: "40px"
  button-lg:
    padding: "0 24px"
    height: "48px"
  button-sm:
    padding: "0 12px"
    height: "32px"
  input:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.text-1}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "42px"
  card:
    backgroundColor: "{colors.surface-1}"
    rounded: "{rounded.lg}"
    padding: "24px"
  panel-focal:
    backgroundColor: "{colors.surface-1}"
    rounded: "{rounded.xl}"
    padding: "32px"
  chip:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text-1}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "0 10px"
    height: "26px"
  tag:
    textColor: "{colors.text-2}"
    typography: "{typography.caption}"
    rounded: "{rounded.full}"
    padding: "0 8px"
    height: "22px"
  nav-link:
    textColor: "{colors.text-2}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "38px"
  nav-link-active:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.text-1}"
---

# Design System: Synapse

## Overview

**Creative North Star: "Iridescent Cloud Edge"**

Synapse is atmospheric optics. Every page is a calm achromatic field: cloud white with slate ink by day, obsidian ground with midnight-navy surfaces by night. Colour does not fill anything. It appears only as a thin spectral fringe (mint, sapphire, violet, rose) at an edge where something is happening: the current page, the current step, a live status, an upload in progress, a synced manifest, the moment a question meets the candidate's material.

The landing page persuades with one observation band (interviewer caption, forming edge, sourced answer). Every signed-in page operates inside the same world with denser lists and forms. Type is one humanist family, Red Hat, set at light display weights for headlines, with tabular mono for numbers and state readouts. Glass is restrained: only floating chrome (public nav pill, mobile app bar, sticky save bar, dialog backdrop) is translucent.

Both themes are designed, not inverted. The system preference is the default; `data-theme` on `<html>` pins light or dark, applied before first paint from `localStorage` (`synapse-theme`).

**Key Characteristics:**
- Achromatic ground and ink; chroma lives only on edges, focus, live indicators and the active mark.
- One stepped surface ramp per theme (ground, surface-0 to surface-3), hairline translucent borders.
- Red Hat Display at 300 for display sizes; Red Hat Text for UI; Red Hat Mono for numbers and state.
- State follows the cloud: absent, forming, vivid, dispersed.
- CSS-only motion; every animated element has a reduced-motion and reduced-transparency fallback.

## Colors

A two-theme achromatic field with a four-hue spectrum reserved for edges.

### Primary
- **Electric Violet** (accent; night `accent-night`): primary button fill, focus outline, selected-state soft fills (`--accent-soft`), `ai` tags, readiness markers when vivid. `accent-text` is the violet used for text and icons, tuned for contrast against the ground in each theme.

### Secondary
- **Spectral Fringe** (`--fringe`: linear-gradient 90deg, mint 0%, sapphire 34%, violet 66%, rose 100%): the only place the spectrum appears. Drawn as a 1px masked border (`.fringe`), a 1px rule (`.fringe-line`), a 2 to 3px progress or tab underline, or a conic dot for "busy".
- **Sapphire, Mint, Rose**: fringe stops only. Rose also marks the interviewer's live dot on the landing band. None of them fill surfaces or colour text.

### Neutral
- **Cloud Ground / Obsidian Ground** (`ground`, `ground-night`): page background, with a faint violet and sapphire radial `--sky` wash fixed behind it.
- **Surface ramp** (`surface-0` to `surface-3`; night midnight navy `#0b1020` to `#172040`): `surface-1` for cards and panels, `surface-2` for insets, chips and quiet fields, `surface-3` for tracks.
- **Slate Ink** (`text-1`, `text-2`, `text-3`): primary copy, secondary copy, meta and placeholders.
- **Hairlines** (`border-subtle`, `border`, `border-strong`): translucent slate by day, translucent periwinkle (`rgba(170, 186, 255, …)`) by night.

### Status
- **Positive, Warning, Danger, Info** each with a `-soft` tint: status dots with a 3px soft halo, tag tints for source kinds (resume = positive, ai = violet, user = info), and notice borders. Never panel fills.

### Contrast floors (from tokens.css)
- Day: `text-1` on ground 16.9:1, `text-2` 7.9:1, `text-3` 5.0:1, white on accent 5.3:1.
- Night: `text-1` on surface-1 15.6:1, `text-2` 8.4:1, `text-3` 5.2:1, white on accent 4.7:1.

### Named Rules
**The Edge-Only Rule.** Colour lives on edges, never in fields. The fringe is reserved for live or changing states: the active nav item, the current step, live status dots, the landing observation band, upload states, the Desktop manifest when synced, the active resume sheet, the selected tab, matched job-description segments. If nothing is happening, the edge is grey.

**The Achromatic Text Rule.** Body and heading text stay slate or cloud. The only coloured text is `accent-text` on links on hover, small tags, and status labels.

**The Two-Themes Rule.** Every token has a day and a night value. The night block is declared twice (system preference and pinned `data-theme='dark'`) and the two must stay identical.

## Typography

**Display Font:** Red Hat Display (with system-ui)
**Body Font:** Red Hat Text (with system-ui)
**Label/Mono Font:** Red Hat Mono (with ui-monospace, Menlo)

**Character:** one humanist family across three cuts. Display is set light and tight so headlines read as air, not weight; Text carries UI at a calm 15px; Mono is used only for numbers, timers and state readouts.

All three load through `next/font` (self-hosted at build): Display 300/400/500, Text 400/500/600, Mono 400.

### Hierarchy
- **Display LG** (300, clamp 44 to 88px, 1.02, -0.035em): landing hero and closing headline only, max ~19ch.
- **Display MD** (300, clamp 36 to 56px, 1.06, -0.03em): landing section heads, auth titles, first-run dashboard hero.
- **Display SM** (300 to 400, clamp 28 to 36px, 1.1): app page `h1`, focal panel titles.
- **Headline** (400, 22px, 1.2): empty-state titles, ledger technology names, mode tab labels.
- **Title** (500, 17px, 1.3, Display cut): `h2` card and section titles.
- **Body** (400, 15px, 1.6): default copy; lead paragraphs step up to 17px. Measure 56 to 68ch.
- **Label** (500, 13px): buttons, field labels, meta.
- **Caption** (12px): tags, source chips, group labels. Table headers are the one uppercase use (0.08em tracking).
- **Mono** (400, 12px, tabular): timers, counters, edge state readouts, token boxes.

### Named Rules
**The Light Display Rule.** Display sizes use weight 300 (400 at most). Never bold a headline.

**The Tabular Numbers Rule.** Any number that updates or aligns in a column uses `tabular-nums` or Red Hat Mono.

## Layout

A 4px spacing grid (`--space-1` 4px to `--space-24` 96px).

- **Landing:** wide-margin field, max 1320px, side padding `clamp(20px, 5vw, 72px)`. Sections are separated by vertical air (`clamp(96px, 13vh, 168px)`) and hairline rules, not boxes. Asymmetric two-column section heads (1.2fr / 1fr).
- **App shell:** a 256px quiet rail on the left and the page on the right, main content max 1180px with 48px padding. Below 900px the rail becomes a sticky glass top bar with a menu sheet (two-column nav groups, one column below 560px).
- **Public nav:** a sticky floating glass pill, `min(1180px, 100% - 32px)` wide.
- **Auth:** a two-column frame (form field left, account contents right) split by a fringe seam; it stacks below 900px with the seam turning horizontal.

### Responsive standards
- Breakpoints: 1100px (landing stations stack to a vertical rail), 900px (shell collapses, multi-column sections stack, observation band goes vertical with a horizontal edge), 640px (single column, buttons stretch, every control 44px tall), 560px and 420px for nav and brand-word details.
- Hover styles only under `(hover: hover) and (pointer: fine)`.
- `100dvh` for full-height regions.

### Named Rules
**The 44px Rule.** Every touch target is at least 44px tall at 640px and below (buttons, nav links, inputs, selects, crumbs, footer links).

## Elevation & Depth

Depth is mostly tonal: the surface ramp plus hairline borders. Shadows are soft and low, used to lift a `surface-1` panel off the ground, never to decorate. Night shadows are deeper black so panels read on obsidian.

### Shadow Vocabulary
- **Rest** (`--shadow-1`; day `0 1px 2px rgba(21,26,44,0.05), 0 4px 16px rgba(21,26,44,0.04)`): cards, focal panels, the active nav item, the selected theme-switch button.
- **Pop** (`--shadow-pop`; day `0 2px 6px rgba(21,26,44,0.08), 0 24px 48px rgba(21,26,44,0.14)`): dialogs and popovers only.
- **Glass** (`--glass` with `backdrop-filter: blur(14 to 18px) saturate(1.4 to 1.5)`): public nav pill, mobile app bar, sticky save bar, dialog backdrop (blur 6px). Falls back to opaque `--ground` under `prefers-reduced-transparency: reduce`.

### Named Rules
**The Floating-Only Glass Rule.** Translucency is for chrome that floats over content. Content panels are opaque.

## Shapes

Soft, rounded geometry. Radii: 6px (small marks, focus outline), 10px (inputs, nav items, insets, notices), 16px (cards, dialogs, answer panel), 24px (focal panels: dashboard next interview, Desktop manifest, privacy block), full pill for buttons, chips, tags, the nav pill and status dots. Borders are always 1px hairlines; dashed borders mean "not yet" (empty states, drop zones, job-description material kept apart from the resume). The fringe border inherits the element's radius through `border-radius: inherit`.

## Components

### Buttons
- **Shape:** full pill (999px), 40px tall (32px small, 48px large, 44px at mobile).
- **Primary:** violet fill, white label, inset top highlight and a soft violet drop glow. On hover or keyboard focus, a fringe ring fades in 3px outside the pill.
- **Secondary (default):** `surface-1` fill, `border-strong` hairline, `text-1` label; hover moves to `surface-2`.
- **Ghost:** transparent, `text-2`; hover gets `surface-hover`.
- **Danger:** transparent with a danger-tinted hairline; hover adds `danger-soft`.
- **Press:** `scale(0.97)`. **Busy:** label hidden, 14px spinner.

### Chips and Tags
- **Chip:** 26px pill on `surface-2` with a hairline, for skills and lists.
- **Tag:** 22px pill, 12px medium. Kinds tint by source: resume (positive), ai (violet), user (info). Neutral tags such as "Example" mark illustrative content honestly.
- **Source chip** (landing answer): neutral pill with a 6px dot: filled positive for work, violet for project, hollow ring for "only listed".

### Cards / Containers
- **Corner Style:** 16px; focal panels 24px.
- **Background:** `surface-1`; insets and entries `surface-2`.
- **Shadow Strategy:** Rest shadow.
- **Border:** 1px `border`; transparent when the card carries the fringe (`data-live` or `.fringe`).
- **Internal Padding:** 24px (16 to 20px at mobile); focal panels 32px.
- Lists inside cards separate rows with `border-subtle` rules, not nested boxes.

### Inputs / Fields
- **Style:** 42px tall, 10px radius, `surface-1` fill, `border-strong` hairline; label 13px medium `text-2` above, hint 13px `text-3` below.
- **Focus:** violet border plus a 3px `accent-soft` ring; no outline.
- **Error:** danger border with `aria-invalid`, message in 13px danger.

### Navigation
- **App rail:** grouped links with 12px `text-3` group labels; 38px rows (44px at mobile), 20px line icons (1.5 stroke, round caps) in `text-3`. Hover: `surface-hover`. Active (`aria-current='page'`): `surface-1` lift with Rest shadow and inset hairline, icon in `accent-text`, and a 1px fringe along the bottom edge.
- **Theme switch:** three-button pill (system, light, dark) with `aria-pressed`; the pressed one lifts to `surface-1`.

### Status dots and the cloud states
A 7px dot plus text label. Tones: positive, warning, danger, accent (each with a 3px soft halo), neutral `text-3`, and busy (a conic fringe dot pulsing on `forming`). Stateful surfaces use `data-phase` or `data-state` with four states:
- **Absent:** grey hairline or empty dot; label in `text-2`.
- **Forming:** dashed violet marker or partial fringe with the `forming` pulse; the observation edge grows and a highlight runs along it.
- **Vivid:** solid violet marker or full fringe.
- **Dispersed:** warning-toned marker at reduced opacity; a failed upload sheet tilts and fades.

### Observation band (signature)
Landing first viewport: caption row, then the interviewer's question (light 22 to 31px, revealed word by word), a 2px rotated fringe edge with a soft veil, and the answer panel whose lines carry source chips. Phases `clear`, `ask`, `form`, `vivid` on `data-phase`; below 900px the edge turns horizontal. Under reduced motion all band transitions and animations are removed and the final state shows.

### Upload intake
A dashed drop zone holding a paper-sheet glyph. Drag over: violet border and `accent-soft`. Uploading: a 3px fringe grows along the bottom to the progress value. Processing: a whole-sheet fringe pulses and a fringe scan line reads down the page. Done: sheet lifts 4px with a vivid fringe. Failed: dispersed.

### Motion
- Easing: `--ease-out` `cubic-bezier(0.23, 1, 0.32, 1)` for entrances and state changes; `--ease-in-out` for pulses.
- Durations: 140ms fast (hover, colour), 220ms medium (dialog rise, sheets, view transitions), 480ms slow (edge opacity).
- Keyframes: `rise` (6px up plus opacity), `forming` (scale and opacity pulse), `spin`, `sheet`. View transitions on navigation (`@view-transition { navigation: auto }`).
- Only `transform` and `opacity` animate; colour and border transitions are short hover feedback.
- `prefers-reduced-motion`: durations drop to 80/120/160ms, looping animations stop or slow (indeterminate progress slows to 3.6s), entrance animations and view transitions are removed.

### Accessibility floors
- Focus: 2px `--focus` (violet) outline with 2px offset on every `:focus-visible`; inputs swap it for border plus ring.
- Skip link to `#main`.
- Contrast values as listed in Colors; `text-3` is the floor for any readable text.
- Icons are decorative (`aria-hidden`) unless they are the only label, which then carries `aria-label`.

## Do's and Don'ts

### Do:
- **Do** keep every field achromatic and put colour only on an edge that marks a live or changing state.
- **Do** express state through the four cloud states (absent, forming, vivid, dispersed) with dot, marker or fringe, plus a text label.
- **Do** design both themes for every new surface and add night values to both night blocks in `tokens.css`.
- **Do** use Red Hat Display at 300 for display sizes and tabular figures for numbers.
- **Do** separate content with hairline rules and vertical space; use a dashed border for material that is pending or kept apart.
- **Do** ship a reduced-motion and reduced-transparency fallback with every animation and every glass surface.
- **Do** meet 44px touch targets at 640px and below.

### Don't:
- **Don't** add kickers or eyebrow labels above headings.
- **Don't** use gradient text; the fringe is never applied to type.
- **Don't** fill panels with colour; status and accent colours appear as dots, hairlines, tags and soft halos only.
- **Don't** build hero-metric rows of big numbers.
- **Don't** nest cards inside cards; use rows, insets (`surface-2`) or rules.
- **Don't** put the fringe on a static or decorative element where nothing is happening.
- **Don't** use glass on content panels.
- **Don't** add an animation library; motion is CSS only.

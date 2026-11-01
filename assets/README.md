# Assets

Application icons for Synapse.

## Brand artwork (`brand/`)

| File | What it is |
| :--- | :--- |
| `synapse-icon-source.png` | Original app tile artwork, as supplied. Do not edit. |
| `synapse-logo.png` | Wordmark on a dark ground, as supplied. Used for the website's social preview. |
| `synapse-app-icon.png` | The tile cropped out of the source with transparent corners, on the macOS 1024 icon grid (824 px tile). Master for the app icons. |
| `synapse-tile.png` | The same tile full-bleed at 512 px. Source for the website favicon and Apple touch icon. |
| `synapse-tile-64.png` | 64 px tile, inlined as the brand mark in the desktop title bar and phone companion, and served as `web/public/brand-mark.png`. |

## Generated icons

```bash
npm run icons
```

That runs [`scripts/generate-icons.js`](../scripts/generate-icons.js). On macOS it resizes `brand/synapse-app-icon.png` with `sips`; elsewhere it falls back to a drawn vector badge.

| File | Used for |
| :--- | :--- |
| `icon.png` | 1024×1024 master, Linux AppImage |
| `icon.icns` | macOS app bundle (built via `iconutil`, macOS only) |
| `icon.ico` | Windows executable |
| `tray-icon.png` / `@2x` | Menu-bar / system-tray glyph |

## Note on the tray icon

`tray-icon.png` is intentionally **glyph-only on a transparent background** and is still drawn by the script. macOS treats tray images as template images (it reads alpha and discards colour), so the coloured brand tile would render as a solid black square in the menu bar.

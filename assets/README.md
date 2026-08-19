# Assets

Application icons for Synapse. **These files are generated — don't edit them by hand.**

## Regenerating

```bash
npm run icons
```

That runs [`scripts/generate-icons.js`](../scripts/generate-icons.js), which renders every asset below from a single vector definition with no external dependencies (a small PNG encoder built on Node's `zlib`).

| File | Used for |
| :--- | :--- |
| `icon.png` | 1024×1024 master, Linux AppImage |
| `icon.icns` | macOS app bundle (built via `iconutil`, macOS only) |
| `icon.ico` | Windows executable |
| `tray-icon.png` / `@2x` | Menu-bar / system-tray glyph |

## Changing the mark

Edit the constants at the top of `scripts/generate-icons.js`:

- `GRADIENT_TOP` / `GRADIENT_BOTTOM` — the badge gradient
- `BARS` — the soundwave bar heights

Then re-run `npm run icons`.

## Note on the tray icon

`tray-icon.png` is intentionally **glyph-only on a transparent background**. macOS treats tray images as template images — it reads alpha and discards colour — so a filled badge would render as a solid black square in the menu bar.

# Legacy setup: capturing call audio on macOS 12 and older

**On macOS 13 or later you do not need anything on this page.** Synapse captures
your Mac's audio directly while you keep listening through MacBook Speakers or
headphones as usual. The first time you turn on Host audio, macOS asks for the
"Screen & System Audio Recording" permission; allow it once.

This page only applies when the Synapse window says native capture is
unavailable, which happens on macOS 12 and older. There, macOS has no public API
for recording what plays through your speakers, so Synapse falls back to
**BlackHole**, a virtual audio device.

---

## 1. Install BlackHole

```bash
brew install blackhole-2ch
```

Log out and back in if it does not appear in the next step. macOS only rescans
audio drivers at login.

## 2. Create a Multi-Output Device

Without this you would send call audio to BlackHole and hear nothing yourself.

1. Open **Audio MIDI Setup** (`/Applications/Utilities`).
2. Click **+** at the bottom left → **Create Multi-Output Device**.
3. Tick both **BlackHole 2ch** and your real output (speakers or headphones).
4. Keep your **real output listed first**: it becomes the clock source.
5. Tick **Drift Correction** on BlackHole only.

## 3. Route your call

- **Per app (better):** in Zoom, Meet, or Teams, set **Speaker** to the
  Multi-Output Device in the app's own audio settings.
- **System-wide:** System Settings → Sound → Output → the Multi-Output Device.
  Browser calls follow the system output, so use this for them.

Synapse never changes your output device itself.

---

## Troubleshooting

**"No loopback audio device found"**: BlackHole is not installed, or macOS has
not rescanned drivers. Install it and log out and back in.

**Host source is on but no transcript appears**: audio is not reaching BlackHole.
Check that the call app's speaker is set to the Multi-Output Device.

**You cannot hear the call**: output is set to raw `BlackHole 2ch` instead of the
Multi-Output Device.

**Sample-rate crackle**: in Audio MIDI Setup, set BlackHole and your real output
to the same sample rate (48 kHz).

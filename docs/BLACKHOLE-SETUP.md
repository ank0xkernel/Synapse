# Capturing the other person's voice (macOS)

Synapse listens to the **far end of your call** — the interviewer, the client, the
person on Zoom — not your own microphone. macOS has no built-in way to record
what comes out of your speakers, so we use **BlackHole**, a virtual audio device.

The idea: your call audio is sent to BlackHole, Synapse records BlackHole, and a
**Multi-Output Device** makes sure you can still hear everything through your
speakers or headphones.

---

## 1. Install BlackHole

```bash
brew install blackhole-2ch
```

Log out and back in (or reboot) if it does not appear in the next step —
macOS only rescans audio drivers at login.

## 2. Create a Multi-Output Device

Without this you would send call audio to BlackHole and hear nothing yourself.

1. Open **Audio MIDI Setup** (`/Applications/Utilities`).
2. Click **+** at the bottom left → **Create Multi-Output Device**.
3. Tick both:
   - **BlackHole 2ch**
   - your real output (MacBook Pro Speakers, or your headphones)
4. Make sure your **real output is listed first** — it becomes the clock source.
5. Tick **Drift Correction** on BlackHole (not on the primary device).
6. Rename it to something like `Synapse Output`.

## 3. Route your call

- **System-wide:** System Settings → Sound → Output → select `Synapse Output`.
- **Per app (better):** in Zoom / Meet / Teams, set **Speaker** to `Synapse Output`
  in the app's own audio settings. This keeps music and notifications out of the
  transcript.

Browser-based calls (Google Meet, WhatsApp Web) follow the system output, so use
the system-wide option for those.

---

## Verify it works

```bash
node scripts/diagnose-audio-capture.js
```

Then play any video with speech on your Mac. In Synapse, the **Host** source
should show a transcript of the video. The mobile companion's **System Audio**
dot turns green.

If you speak into your microphone and see *that* transcribed under Host, the
routing is wrong — Synapse is on the built-in mic, not BlackHole.

---

## Troubleshooting

**"No loopback audio device found"**
BlackHole is not installed, or macOS has not rescanned drivers. Run
`brew install blackhole-2ch` and log out and back in.

**Host source is green but no transcript appears**
Audio is not reaching BlackHole. Check that your call app's speaker is set to
the Multi-Output Device, and that the call is not muted on the far end.

**You cannot hear the call any more**
Your output is set to raw `BlackHole 2ch` instead of the Multi-Output Device.
BlackHole alone is a sink with no speakers attached.

**Transcript is only picking up one side of a stereo source**
Should not happen — Synapse downmixes stereo to mono before transcription. If it
does, confirm you selected **BlackHole 2ch** and not a 16ch variant.

**Sample-rate crackle**
In Audio MIDI Setup, set BlackHole and your real output to the **same** sample
rate (48 kHz is a safe default).

'use strict';

const { execFile } = require('child_process');
const { clipboard } = require('electron');

/**
 * TextInserter
 *
 * Sends a drafted answer into whatever editor currently has focus, so you can
 * work through it during practice instead of retyping it by hand.
 *
 * This deliberately does NOT imitate a human typist. An earlier version varied
 * keystroke timing and injected fake typos with backspace "corrections", which
 * served no purpose except to disguise the source of the text. Insertion here
 * is plain and fast; the small inter-chunk delay exists because editors with
 * autocomplete (VSCode, Xcode) drop characters when fed a large buffer at once.
 */
class TextInserter {
  constructor(options = {}) {
    this.isInserting = false;
    this.nutKeyboard = null;

    // Characters per write. Small enough that editor autocomplete keeps up,
    // large enough that a long answer lands in a couple of seconds.
    this.chunkSize = options.chunkSize || 24;
    this.chunkDelayMs = options.chunkDelayMs ?? 12;
    this.speedLevel = options.speedLevel ?? 7;

    // nut-js is an optional native dependency and is not declared in
    // package.json, so on a normal install it is simply absent. It is still
    // honoured when a user has installed it themselves.
    try {
      const nut = require('@nut-tree-fork/nut-js');
      this.nutKeyboard = nut.keyboard;
      if (this.nutKeyboard && this.nutKeyboard.config) {
        this.nutKeyboard.config.autoDelayMs = 0;
      }
      console.log('[TextInserter] Keyboard insertion available (nut-js).');
    } catch (_) {
      // Expected on a default install — the platform paste path below covers it.
    }

    // macOS can drive the paste itself through System Events, which needs no
    // native module. Without this the "send to editor" button only ever reached
    // the clipboard and the user still had to paste by hand, which is not what
    // the button claims to do.
    this.canOsPaste = process.platform === 'darwin';

    if (!this.nutKeyboard) {
      console.log(
        this.canOsPaste
          ? '[TextInserter] Using macOS System Events paste (needs Accessibility permission).'
          : '[TextInserter] No keyboard backend; answers will be staged on the clipboard.'
      );
    }
  }

  /**
   * Sets insertion pace on a 1-10 scale, where 10 is as fast as the editor can
   * accept text and 1 leaves a wide gap between chunks for editors whose
   * autocomplete drops characters under load.
   *
   * This adjusts throughput only. It deliberately does not reintroduce the
   * randomised per-keystroke timing this class used to have — that varied
   * delays and injected fake typos, which changed nothing about the result and
   * existed only to make machine insertion look hand-typed.
   *
   * @param {number} level 1 (slowest) to 10 (fastest)
   * @returns {{ speed: number, chunkDelayMs: number }} the applied setting
   */
  setSpeed(level) {
    const parsed = Number(level);
    const clamped = Number.isFinite(parsed) ? Math.min(10, Math.max(1, Math.round(parsed))) : 7;

    // Level 1 -> 45ms between chunks, level 10 -> 0ms (back-to-back writes).
    this.chunkDelayMs = Math.round(45 - ((clamped - 1) / 9) * 45);
    this.speedLevel = clamped;

    console.log(`[TextInserter] Insertion speed set to ${clamped}/10 (${this.chunkDelayMs}ms between chunks).`);
    return { speed: clamped, chunkDelayMs: this.chunkDelayMs };
  }

  /** Current pace, for the mobile companion's settings panel. */
  getSpeed() {
    return { speed: this.speedLevel, chunkDelayMs: this.chunkDelayMs };
  }

  /**
   * Issues Cmd+V to the focused app via AppleScript.
   * Requires Accessibility permission for the app (System Settings → Privacy &
   * Security → Accessibility); rejects with a readable message when missing.
   */
  osPaste() {
    return new Promise((resolve, reject) => {
      execFile(
        'osascript',
        ['-e', 'tell application "System Events" to keystroke "v" using command down'],
        { timeout: 5000 },
        (error, _stdout, stderr) => {
          if (error) {
            const detail = String(stderr || error.message).trim();
            if (/not allowed|assistive|accessibility|-25211|1002/i.test(detail)) {
              reject(new Error(
                'Accessibility permission is required to paste into another app. '
                + 'Enable Synapse under System Settings → Privacy & Security → Accessibility.'
              ));
              return;
            }
            reject(new Error(detail));
            return;
          }
          resolve();
        }
      );
    });
  }

  /**
   * Insert text at the current cursor position. Must be triggered explicitly by
   * the user (mobile "Send to editor" button or the dashboard control) — never
   * call this automatically on answer completion.
   *
   * @param {string} text
   * @returns {Promise<{ method: string, chars: number }>}
   */
  async insertText(text) {
    if (!text || this.isInserting) {
      return { method: 'skipped', chars: 0 };
    }

    this.isInserting = true;
    console.log(`[TextInserter] Inserting ${text.length} chars into the focused editor...`);

    try {
      if (!this.nutKeyboard) {
        // The clipboard is the user's, so put back whatever was there once the
        // paste has landed rather than silently keeping their buffer.
        const previousClipboard = clipboard.readText();
        clipboard.writeText(text);

        if (this.canOsPaste) {
          try {
            await this.osPaste();
            console.log('[TextInserter] Pasted into the focused app.');
            setTimeout(() => {
              // Only restore if nothing else has claimed the clipboard since.
              if (clipboard.readText() === text) {
                clipboard.writeText(previousClipboard);
              }
            }, 800);
            return { method: 'paste', chars: text.length };
          } catch (pasteError) {
            console.warn(`[TextInserter] Automatic paste unavailable: ${pasteError.message}`);
          }
        }

        console.log('[TextInserter] Copied to clipboard — paste with Cmd/Ctrl+V.');
        return { method: 'clipboard', chars: text.length };
      }

      for (let i = 0; i < text.length; i += this.chunkSize) {
        if (!this.isInserting) {
          console.log('[TextInserter] Insertion cancelled.');
          break;
        }

        await this.nutKeyboard.type(text.slice(i, i + this.chunkSize));
        if (this.chunkDelayMs > 0) {
          await this.sleep(this.chunkDelayMs);
        }
      }

      return { method: 'keyboard', chars: text.length };
    } catch (err) {
      console.error('[TextInserter] Insertion failed, copying to clipboard instead:', err.message);
      clipboard.writeText(text);
      return { method: 'clipboard', chars: text.length };
    } finally {
      this.isInserting = false;
      console.log('[TextInserter] Done.');
    }
  }

  stop() {
    this.isInserting = false;
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = TextInserter;

const WINDOW_DEFAULT_WIDTH = 900;
const WINDOW_DEFAULT_HEIGHT = 400;
const WINDOW_MIN_WIDTH = 600;
const WINDOW_MIN_HEIGHT = 380;
const WINDOW_OPACITY_LEVEL_MIN = 1;
const WINDOW_OPACITY_LEVEL_MAX = 10;
const DEFAULT_WINDOW_OPACITY_LEVEL = 10;
const STEALTH_WINDOW_OPACITY = 0.02;
// Distance the Cmd+Arrow nudge shortcuts slide the overlay per press. Large
// enough that one tap visibly moves it, small enough to fine-tune placement
// around a video call without overshooting.
const WINDOW_NUDGE_STEP = 40;

module.exports = {
  WINDOW_DEFAULT_WIDTH,
  WINDOW_DEFAULT_HEIGHT,
  WINDOW_MIN_WIDTH,
  WINDOW_MIN_HEIGHT,
  WINDOW_OPACITY_LEVEL_MIN,
  WINDOW_OPACITY_LEVEL_MAX,
  DEFAULT_WINDOW_OPACITY_LEVEL,
  STEALTH_WINDOW_OPACITY,
  WINDOW_NUDGE_STEP
};

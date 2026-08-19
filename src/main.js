// Capture console output into the shared ring buffer before anything else is
// required, so the dashboard's log panel also shows startup and module-load
// messages. Installing this later would drop exactly the lines you want when
// diagnosing a failed launch.
const { logBuffer } = require('./services/logging/log-buffer');

logBuffer.install();

// Safety net for anything that escapes every other try/catch in the main
// process after startup. Without this, an uncaught exception here vanishes —
// Electron either kills the process or leaves it in an undiagnosable half-
// broken state, and none of it reaches the log buffer (so it never shows up
// in /api/logs either). This does not change any feature's behavior; it only
// makes a crash that would already happen visible before the process exits,
// the same way the pre-existing startup failure handler below already does
// for the boot path.
process.on('uncaughtException', (error) => {
  console.error('[main] Uncaught exception:', error?.stack || error);
});

process.on('unhandledRejection', (reason) => {
  console.error('[main] Unhandled promise rejection:', reason?.stack || reason);
});

const { startApplication } = require('./main-process/start-application');

startApplication().catch((error) => {
  console.error('Fatal startup failure:', error);
  process.exit(1);
});

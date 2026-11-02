'use strict';

const { secondBrainService } = require('../../../services/second-brain/second-brain-service');

/**
 * Second Brain IPC handlers
 *
 * Bridges Electron renderer to Second Brain service.
 */

function registerSecondBrainIpc({ ipcMain }) {
  ipcMain.handle('second-brain:get-status', async () => {
    try {
      await secondBrainService.initialize();
      return {
        ok: true,
        health: secondBrainService.getHealth(),
        projects: secondBrainService.getProjects()
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('second-brain:query', async (_event, payload = {}) => {
    try {
      await secondBrainService.initialize();
      const query = typeof payload === 'string' ? payload : (payload.query || '');
      const projectId = typeof payload === 'object' ? payload.projectId : null;
      const limit = typeof payload === 'object' ? payload.limit : 6;

      const t0 = Date.now();
      const result = secondBrainService.query(query, { projectId, limit });
      const latencyMs = Date.now() - t0;

      return {
        ok: true,
        latencyMs,
        ...result
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('second-brain:reindex', async () => {
    try {
      const stats = await secondBrainService.reindex(true);
      return { ok: true, stats };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

module.exports = {
  registerSecondBrainIpc
};


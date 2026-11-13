'use strict';

// Registered projects, persisted as JSON. Writes are atomic (tmp + fsync +
// rename); a corrupt file is renamed aside, never overwritten.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSION = 1;

function projectIdFor(realRoot) {
  return 'prj_' + crypto.createHash('sha1').update(realRoot).digest('hex').slice(0, 12);
}

function createProjectStore({ filePath, log = console.warn } = {}) {
  if (!filePath) throw new Error('filePath required');
  let state = null;

  function load() {
    if (state) return state;
    state = { version: VERSION, projects: [], activeProjectId: null };
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') log(`[project-store] cannot read ${filePath}: ${error.message}`);
      return state;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.projects)) throw new Error('unexpected shape');
      const projects = parsed.projects.filter((p) => p && typeof p.id === 'string' && typeof p.root === 'string');
      state = {
        version: VERSION,
        projects,
        activeProjectId: projects.some((p) => p.id === parsed.activeProjectId) ? parsed.activeProjectId : null
      };
    } catch (error) {
      const aside = `${filePath}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(filePath, aside);
        log(`[project-store] corrupt store moved to ${aside}: ${error.message}`);
      } catch (renameError) {
        log(`[project-store] corrupt store and could not move it: ${renameError.message}`);
      }
    }
    return state;
  }

  function save() {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(state, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(tmp, filePath);
    } catch (error) {
      fs.rmSync(tmp, { force: true });
      throw error;
    }
  }

  const find = (id) => load().projects.find((p) => p.id === id) || null;

  return {
    list: () => load().projects.map((p) => ({ ...p })),
    get(id) {
      const p = find(id);
      return p ? { ...p } : null;
    },
    add(rootPath) {
      if (typeof rootPath !== 'string' || !rootPath.trim()) throw new Error('Project path required.');
      let real;
      try {
        real = fs.realpathSync(rootPath);
      } catch {
        throw new Error(`Folder does not exist: ${rootPath}`);
      }
      if (!fs.statSync(real).isDirectory()) throw new Error(`Not a folder: ${rootPath}`);
      const id = projectIdFor(real);
      const existing = find(id);
      if (existing) return { ...existing };
      let name = path.basename(real);
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(real, 'package.json'), 'utf8'));
        if (pkg && typeof pkg.name === 'string' && pkg.name.trim()) name = pkg.name.trim();
      } catch { /* no usable package.json: keep folder name */ }
      const now = Date.now();
      const project = { id, name, root: real, addedAt: now, lastUsedAt: now };
      load().projects.push(project);
      save();
      return { ...project };
    },
    remove(id) {
      const s = load();
      const before = s.projects.length;
      s.projects = s.projects.filter((p) => p.id !== id);
      if (s.activeProjectId === id) s.activeProjectId = null;
      if (s.projects.length !== before) save();
      return s.projects.length !== before;
    },
    setActive(id) {
      const s = load();
      if (id !== null && !find(id)) throw new Error(`Unknown project: ${id}`);
      s.activeProjectId = id;
      save();
    },
    getActive: () => {
      const s = load();
      return s.activeProjectId ? find(s.activeProjectId) : null;
    },
    touch(id) {
      const p = find(id);
      if (!p) return false;
      p.lastUsedAt = Date.now();
      save();
      return true;
    }
  };
}

module.exports = { createProjectStore, projectIdFor };

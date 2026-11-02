'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { KNOWN_PROJECTS } = require('./config');

/**
 * Project Registry
 *
 * Discovers, validates, and registers local engineering repositories.
 * Gathers verified stack, version, and metadata directly from disk.
 */

class ProjectRegistry {
  constructor() {
    this.projects = new Map();
    this.initialized = false;
  }

  discoverProjects() {
    this.projects.clear();

    for (const [id, def] of Object.entries(KNOWN_PROJECTS)) {
      let resolvedPath = null;
      for (const cand of def.candidatePaths) {
        if (fs.existsSync(cand) && fs.statSync(cand).isDirectory()) {
          resolvedPath = cand;
          break;
        }
      }

      const isDiscovered = resolvedPath !== null;
      let gitRemote = null;
      let lastCommit = null;
      let gitBranch = null;
      let detectedTech = [...def.primaryStack];
      let packageMetadata = null;

      if (isDiscovered) {
        // Read Git info if available
        const gitDir = path.join(resolvedPath, '.git');
        if (fs.existsSync(gitDir)) {
          try {
            gitRemote = execSync('git remote get-url origin', { cwd: resolvedPath, timeout: 1500, stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
          } catch {
            gitRemote = null;
          }
          try {
            lastCommit = execSync('git log -1 --format="%h %s (%cd)" --date=short', { cwd: resolvedPath, timeout: 1500, stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
            gitBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: resolvedPath, timeout: 1500, stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
          } catch {
            // Non-fatal if git is uninitialized or detached
          }
        }

        // Read package.json if present
        const pkgPath = path.join(resolvedPath, 'package.json');
        if (fs.existsSync(pkgPath)) {
          try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            packageMetadata = {
              name: pkg.name || id,
              version: pkg.version || '0.1.0',
              dependencies: Object.keys(pkg.dependencies || {}),
              devDependencies: Object.keys(pkg.devDependencies || {})
            };
          } catch {
            // Ignore parse errors
          }
        }
      }

      this.projects.set(id, {
        id,
        name: def.name,
        category: def.category,
        resumeTitle: def.resumeTitle,
        rootPath: resolvedPath,
        isDiscovered,
        gitRemote,
        lastCommit,
        gitBranch,
        verifiedSummary: def.verifiedSummary,
        primaryStack: detectedTech,
        packageMetadata,
        discoveredAt: new Date().toISOString()
      });
    }

    this.initialized = true;
    return Array.from(this.projects.values());
  }

  getProject(id) {
    if (!this.initialized) this.discoverProjects();
    return this.projects.get(id) || null;
  }

  getAllProjects() {
    if (!this.initialized) this.discoverProjects();
    return Array.from(this.projects.values());
  }

  getDiscoveredProjects() {
    return this.getAllProjects().filter((p) => p.isDiscovered);
  }
}

const registry = new ProjectRegistry();

module.exports = {
  ProjectRegistry,
  projectRegistry: registry
};


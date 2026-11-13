# Workbench: project-aware tasks with approved execution

## Functional DAG

```
screen context (Phase 1 getPromptContext) ─┐
registered projects (project-store) ───────┼─> project-match ─> user confirms project ─┐
                                           │                                            │
project folder ─> project-scanner ─> code-index ─────────────────────────────────────┐ │
                                                                                      ├─┴─> task-engine.understand
user question ────────────────────────────────────────────────────────────────────────┘        │
                                                                                                v
                                            code-index.search + file-ops.read (evidence) ─> task-engine.plan
                                                                                                │ (validated: paths exist, edit anchors match once)
                                                                                                v
                                         UI approval per edit / per command ─> file-ops.apply | command-runner.run
                                                                                                │ (action-log records every step)
                                                                                                v
                                                                 task-engine.answer (statuses: suggested / executed / verified / failed)
                                                                                                v
                                                                         VERIFY: npm test + test:workbench:e2e
```

## Decisions (from the user)

- Projects: Add Project folder picker, multiple projects persisted. Screen evidence suggests a registered project; the user confirms. Never an unregistered or ambiguous project silently.
- Reads, search, indexing: automatic, inside the confirmed project only.
- Every file write shows path and diff; every command shows command, cwd, purpose. Nothing runs without Approve.
- Direct file operations; `code -g file:line` to open in the editor. No keyboard/mouse automation, no Accessibility permission. Existing paste-into-editor stays.

## Modules (src/services/workbench/)

| Module | Owner | Responsibility |
|---|---|---|
| contracts.js | lead | Versioned shapes + validators for task, plan, proposals, results, evidence |
| project-store.js | A | Registered projects, atomic JSON in userData |
| project-scanner.js | A | Languages, manifests, package managers, workspaces, scripts, entry points |
| code-index.js | A | Symbols and imports: TypeScript compiler API for JS/TS, python3 `ast` for Python, regex fallback for others; search |
| project-match.js | A | Score registered projects against screen text; never picks unregistered |
| path-guard.js | B | Resolve a path inside a root (realpath, no symlink escape) |
| unified-diff.js | B | Line diff in unified format |
| file-ops.js | B | Read, propose, apply with stale-file check, atomic write, backup, undo |
| command-runner.js | B | Risk classification, spawn with timeout/cancel/output cap, secret redaction |
| action-log.js | B | Append-only JSONL audit trail |
| task-engine.js | lead | Classify, retrieve evidence, plan (model JSON), validate, answer |
| main-process/features/workbench/ipc.js | lead | IPC, approval state, events |
| renderer/features/workbench/* | C | Panel UI |

## Risks

- Model returns invalid JSON or anchors that do not match: plan validation marks each edit invalid with the reason; nothing is applied.
- Large repos: index caps files and bytes; search is bounded.
- Packaged PATH lacks Homebrew/nvm: commands run through the user's login shell.

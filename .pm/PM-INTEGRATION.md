# ProjectManager Integration Spec (pm-manifest-v1)

How to integrate any project with ProjectManager. Written for AI coding agents (Claude Code, Codex, Cursor) and humans.

## The contract in one paragraph

Each project folder contains `.pm/project.json` — the **manifest**. ProjectManager reads it live (file-watched) to render the project's dashboard: deploy buttons, services, databases, hosting, docs index, links. **Secrets never go in the manifest.** Credentials live only in ProjectManager's central store; the manifest references them by `credentialRef` id. To integrate a project: write/update `.pm/project.json`, validate it, done.

## Rules for agents

1. **Never write passwords, API keys, or tokens into `.pm/project.json`** or anywhere else in the project folder. Use a `credentialRef` string and tell the user to add the credential in ProjectManager (Credentials tab) under that id.
2. Don't delete manifest sections you don't understand — merge, don't replace.
3. After editing, validate: `npm run validate:manifest -- <path-to-project>` (run from the ProjectManager folder), or check against `pm-manifest.schema.json`.
4. Relative paths in the manifest (`cwd`, `docs[].path`, `planning.dir`, `assets.dir`) are relative to the project root, forward slashes.
5. When adding deploy actions that touch production, set `"confirm": true` (and `"danger": true` if destructive).

## Manifest reference

```jsonc
{
  "$schema": "pm-manifest-v1",
  "name": "Project Name",                    // required
  "description": "One-paragraph summary",
  "tags": ["client"],                        // free-form; "client" / "personal" conventional
  "client": "bayfields",                     // clientId from ProjectManager's clients.json (optional)
  "status": "active",                        // active | paused | waiting-on-client | done | idea
  "focus": "Current next step, one line",    // shown front-and-centre on the Overview
  "waitingOn": { "note": "template sign-off", "since": "2026-07-01T00:00:00Z" },

  "run": [                                   // local dev actions (Deploy tab, "Run / local dev")
    { "name": "Dev server", "command": "npm run dev", "cwd": "recall-app/vps",
      "description": "Starts Postgres container + app on :3000" }
  ],
  "deploy": [                                // deploy actions — one row each, with a Run button
    { "name": "Deploy (copy)", "command": "npm run deploy:copy", "cwd": "recall-app/vps",
      "description": "Code only — tsx watch hot-reloads", "confirm": false },
    { "name": "Deploy (build)", "command": "npm run deploy:build", "cwd": "recall-app/vps",
      "description": "Copy + rebuild container", "confirm": true, "danger": true }
  ],

  "environments": {
    "local":      { "url": "http://localhost:3000", "localPath": "website",   // localPath = where this env's code lives (relative or absolute)
                    "notes": "Docker Desktop required", "hosts": [] },
    "production": {
      "url": "https://app.example.com",
      "healthCheck": "https://app.example.com/api/health",   // GET; 2xx = green dot
      "hosts": [
        { "kind": "ssh", "host": "191.101.81.131", "port": 22, "user": "root",
          "credentialRef": "bayfields-vps-ssh" }             // kind: ssh | sftp | ftp
      ]
    }
  },

  "services": [                              // remote services & APIs
    { "name": "Klaviyo", "url": "https://www.klaviyo.com",
      "docsUrl": "https://developers.klaviyo.com",
      "credentialRef": "bayfields-klaviyo", "notes": "private key also in VPS .env" }
  ],

  "databases": [
    { "name": "recall (prod)", "engine": "postgres",         // postgres | mysql | sqlite | mssql | other
      "host": "127.0.0.1", "port": 5433, "database": "recall",
      "webUI": "http://pgadmin.example.com/browser/",
      "credentialRef": "bayfields-pg", "notes": "loopback-only on VPS" }
  ],

  "git": { "remote": "git@github.com:user/repo.git" },       // expected remote; mismatch is flagged

  "docs": [                                  // knowledge-base index; files stay where they are
    { "path": "docs/SYSTEM-REFERENCE.md", "type": "master", "title": "System Reference" }
    // type: master | planning | feature | frontend | backend | api | other
  ],

  "links": [ { "title": "Hostinger panel", "url": "https://hpanel.hostinger.com/…" } ],

  "planning": { "dir": "docs/planning" },    // Planning tab file browser root
  "assets":   { "dirs": ["docs/assets", "public"] },  // Assets tab sections (legacy { "dir": "…" } also accepted)
  "ports": [3000, 5433]                      // dev ports for the port watcher
}
```

## Doc type heuristics

`master` = system reference / overview / README / handover · `planning` = plans, roadmaps, scopes, specs, estimates · `feature` = single-feature docs · `frontend` / `backend` = layer-specific · `api` = endpoint/webhook references · `other` = everything else.

## Integration procedure (for the `pm-integrate` skill)

1. Read this spec and `pm-manifest.schema.json`.
2. Scan the project: git remote/branch, every `package.json`'s scripts (root + subdirs), `.env*` files, `**/*.md` docs (max depth 3, skip node_modules/.git/dist).
3. Draft the manifest: scripts named `deploy*`/`publish*`/`release*` → `deploy[]` with `confirm: true`; `dev`/`start`/`build` → `run[]`. Docs → `docs[]` with heuristic types. Detect URLs/hosts from existing docs where possible.
4. For any credentials discovered (e.g. in `.env`): DO NOT copy values. Create `credentialRef` placeholders (kebab-case: `<project>-<service>`) and list them for the user to fill in ProjectManager.
5. Write `.pm/project.json` (merge if it exists). Validate. Report what was added.

## Central store (read-only for agents unless asked)

`<Documents>\Claude\Projects\ProjectManager\data\` — registry.json (project list + folder paths), clients.json, credentials/*.json (secrets — do not read into context unless the user explicitly asks), tasks/, notes/ (session journals, markdown), runs/ (deploy history).

An MCP server is available for structured access: see `tools/pm-mcp/README.md`.

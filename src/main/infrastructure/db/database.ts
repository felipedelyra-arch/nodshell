import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { BUILTIN_PRESETS, ORCHESTRATOR_PROMPT } from '../../domain/preset'

export type Db = Database.Database

/** What version 1 seeded for the built-in Orchestrator. */
export const ORCHESTRATOR_PROMPT_V1 = 'You are the orchestrator. Break the goal into small tasks, delegate them to the other agents and track their progress.'

/** Each entry upgrades the schema by one version (PRAGMA user_version). Never edit a shipped one; append. */
const MIGRATIONS: ((db: Db) => void)[] = [
  (db) => {
    db.exec(`CREATE TABLE presets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,
      adapter TEXT NOT NULL CHECK (adapter IN ('claude','generic')),
      model TEXT,
      system_prompt TEXT NOT NULL DEFAULT '',
      builtin INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX presets_name_nocase ON presets (name COLLATE NOCASE);`)
    const ins = db.prepare("INSERT INTO presets (id, name, role, adapter, model, system_prompt, builtin, created_at) VALUES (?, ?, ?, 'claude', NULL, ?, 1, ?)")
    const now = Date.now()
    for (const p of BUILTIN_PRESETS) ins.run(randomUUID(), p.name, p.role, p.systemPrompt, now)
  },
  (db) => {
    // F6: the built-in Orchestrator learns its tools; a prompt the user already changed, and any user preset, are left alone
    db.prepare('UPDATE presets SET system_prompt = ? WHERE builtin = 1 AND system_prompt = ?').run(ORCHESTRATOR_PROMPT, ORCHESTRATOR_PROMPT_V1)
  },
  (db) => {
    // F8: memory (global and per repository) and the board of each project; everything of a project goes with its row
    db.exec(`CREATE TABLE memory (
      scope TEXT NOT NULL CHECK (scope IN ('global','repo')),
      key TEXT NOT NULL,
      content TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      updated_by TEXT NOT NULL,
      PRIMARY KEY (scope, key));
    CREATE TABLE projects (root TEXT PRIMARY KEY, opened_at INTEGER NOT NULL);
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL REFERENCES projects(root) ON DELETE CASCADE,
      name TEXT NOT NULL,
      ord INTEGER NOT NULL,
      vx REAL NOT NULL, vy REAL NOT NULL, zoom REAL NOT NULL,
      active INTEGER NOT NULL);
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL REFERENCES projects(root) ON DELETE CASCADE,
      role TEXT NOT NULL,
      preset_id TEXT,
      model TEXT,
      name TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      branch TEXT NOT NULL,
      worktree TEXT NOT NULL,
      base TEXT NOT NULL,
      session_id TEXT NOT NULL,
      pending INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE groups (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL REFERENCES projects(root) ON DELETE CASCADE,
      name TEXT NOT NULL,
      collapsed INTEGER NOT NULL,
      preset_id TEXT);
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL REFERENCES projects(root) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('console','agent','group','orchestrator')),
      x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL,
      pinned INTEGER NOT NULL,
      parent_id TEXT,
      ord INTEGER NOT NULL);
    CREATE TABLE squads (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL REFERENCES projects(root) ON DELETE CASCADE,
      orchestrator_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE);
    CREATE TABLE squad_groups (
      squad_id TEXT NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      ord INTEGER NOT NULL,
      PRIMARY KEY (squad_id, group_id));
    CREATE TABLE squad_extras (
      squad_id TEXT NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      PRIMARY KEY (squad_id, agent_id));
    CREATE TABLE edges (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL REFERENCES projects(root) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      source_kind TEXT NOT NULL CHECK (source_kind IN ('agent','group')),
      source_id TEXT NOT NULL,
      target_kind TEXT NOT NULL CHECK (target_kind IN ('agent','group','squad')),
      target_id TEXT NOT NULL,
      template TEXT NOT NULL,
      condition TEXT NOT NULL,
      paused TEXT);
    CREATE INDEX nodes_project ON nodes (project);
    CREATE INDEX workspaces_project ON workspaces (project);`)
  },
  (db) => {
    // F11: board annotations. Not tied to the workspaces table (a layout save recreates those rows); the project's row owns them
    db.exec(`CREATE TABLE annotations (
      project TEXT NOT NULL REFERENCES projects(root) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL,
      id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('stroke','shape','text','image')),
      image_id TEXT,
      data TEXT NOT NULL,
      ord INTEGER NOT NULL,
      PRIMARY KEY (project, workspace_id, id));
    CREATE INDEX annotations_image ON annotations (image_id) WHERE image_id IS NOT NULL;`)
  },
  (db) => {
    // F12: web tiles (address, place, size). Like annotations, owned by the project's row, not by the workspaces table
    db.exec(`CREATE TABLE web_tiles (
      project TEXT NOT NULL REFERENCES projects(root) ON DELETE CASCADE,
      id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      url TEXT NOT NULL,
      x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL,
      ord INTEGER NOT NULL,
      PRIMARY KEY (project, id));`)
  },
  (db) => {
    // F13: loops (prompt, trigger, goal, max runs); runs and state are never kept. Owned by the project's row, like web tiles
    db.exec(`CREATE TABLE loops (
      project TEXT NOT NULL REFERENCES projects(root) ON DELETE CASCADE,
      id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('schedule','idle','output')),
      trigger_sec INTEGER,
      terminal_id TEXT,
      trigger_text TEXT,
      goal TEXT NOT NULL,
      max_runs INTEGER NOT NULL,
      ord INTEGER NOT NULL,
      PRIMARY KEY (project, id));`)
  },
  (db) => {
    // F10: app settings (key/value; today only the live-terminal limit)
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  },
]

export function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number
  if (current > MIGRATIONS.length) throw new Error('Database is newer than this app')
  for (let v = current; v < MIGRATIONS.length; v++) {
    // PRAGMA cannot take parameters; `v` is our own loop counter
    db.transaction(() => {
      MIGRATIONS[v]!(db)
      db.pragma(`user_version = ${v + 1}`)
    })()
  }
}

/** The file is created owner-only (0600) before sqlite touches it; -wal and -shm inherit its mode. Its directory is owner-only too (0700). */
export function openDatabase(file: string): Db {
  chmodSync(dirname(file), 0o700)
  closeSync(openSync(file, 'a', 0o600))
  chmodSync(file, 0o600)
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

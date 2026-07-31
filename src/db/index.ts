import { drizzle } from 'drizzle-orm/better-sqlite3'
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { dbPath, assetsDir } from '../env'
import * as schema from './schema'

export type Db = ReturnType<typeof openDb>

/**
 * Every caller resolves the path through env.ts. Tests pass their own file so a
 * suite can never share a database with the dev worker, whose 2s claim loop
 * would happily delete assets you paid for.
 */
export function openDb(file: string = dbPath()) {
  mkdirSync(path.dirname(file), { recursive: true })
  mkdirSync(assetsDir(), { recursive: true })

  const sqlite = new Database(file)
  // WAL so the worker writing a run cannot block the UI reading one.
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')

  migrate(sqlite)
  return drizzle(sqlite, { schema })
}

/**
 * Schema is created straight from DDL rather than drizzle-kit's generated
 * migration folder. One file to keep in sync while the schema is still moving;
 * swap to `drizzle-kit migrate` the first time a shipped database needs
 * altering rather than recreating.
 */
function migrate(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      brand_profile TEXT,
      brand_profile_version INTEGER NOT NULL DEFAULT 1,
      settings TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      files TEXT NOT NULL,
      text TEXT,
      notes TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS flows (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      graph_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS node_runs (
      id TEXT PRIMARY KEY,
      flow_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      model_id TEXT NOT NULL,
      fal_request_id TEXT,
      cost_cents INTEGER NOT NULL DEFAULT 0,
      output_refs TEXT,
      error TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      claimed_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS node_runs_input_hash_idx ON node_runs(input_hash);
    CREATE INDEX IF NOT EXISTS node_runs_status_idx ON node_runs(status);
    CREATE INDEX IF NOT EXISTS node_runs_flow_node_idx ON node_runs(flow_id, node_id);

    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      mime TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      duration_ms INTEGER,
      fps INTEGER,
      codec TEXT,
      source_run_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS exports (
      id TEXT PRIMARY KEY,
      flow_id TEXT NOT NULL,
      format TEXT NOT NULL,
      asset_id TEXT REFERENCES assets(id),
      spec_check TEXT,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `)
}

let cached: Db | undefined

/**
 * One connection per process. Opening a handle per request is wasteful, and
 * more importantly WAL mode wants a stable writer — the worker and the request
 * handlers share this.
 */
export function getDb(): Db {
  cached ??= openDb()
  return cached
}

export { schema }

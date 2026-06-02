import Database, { type Database as SqliteDb } from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { projectConfigDir, globalConfigDir } from '../config.js';

/**
 * SQL schema files are copied into dist/db/ during build. At dev time we read
 * from src/db/. Resolution is best-effort: try dist relative to compiled file,
 * fall back to src relative to repo root.
 */
function schemaPath(file: string): string {
  const fromDist = join(__dirname, '..', 'db', file);
  if (existsSync(fromDist)) return fromDist;
  return join(__dirname, '..', '..', 'src', 'db', file);
}

function open(path: string): SqliteDb {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function applySchema(db: SqliteDb, schemaFile: string): void {
  const sql = readFileSync(schemaPath(schemaFile), 'utf8');
  db.exec(sql);
}

/** Add a column to a table if it doesn't already exist (idempotent migration). */
function ensureColumn(db: SqliteDb, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

/**
 * Migrate an existing knowledge.db forward. CREATE TABLE IF NOT EXISTS cannot
 * add columns to a pre-existing table, so additive columns are applied here.
 */
function migrateKnowledgeDb(db: SqliteDb): void {
  ensureColumn(db, 'k_nodes', 'grounding', 'grounding TEXT');
  ensureColumn(db, 'k_nodes', 'scope', 'scope TEXT');
  ensureColumn(db, 'k_nodes', 'source_url', 'source_url TEXT');
  ensureColumn(db, 'concepts', 'scope', 'scope TEXT');
  ensureColumn(db, 'concepts', 'grounding', 'grounding TEXT');
  ensureColumn(db, 'concepts', 'structured', 'structured TEXT');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_knodes_grounding ON k_nodes(grounding)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_knodes_scope ON k_nodes(scope)`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS research_cache (
      query_hash TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      result_json TEXT NOT NULL,
      source_url TEXT,
      fetched_at INTEGER NOT NULL
    )
  `);
}

export function openCodeDb(projectRoot: string): SqliteDb {
  const db = open(join(projectConfigDir(projectRoot), 'code.db'));
  applySchema(db, 'code-schema.sql');
  return db;
}

export function openKnowledgeDb(projectRoot: string): SqliteDb {
  const db = open(join(projectConfigDir(projectRoot), 'knowledge.db'));
  applySchema(db, 'knowledge-schema.sql');
  migrateKnowledgeDb(db);
  return db;
}

function migrateGlobalDb(db: SqliteDb): void {
  ensureColumn(db, 'concepts_global', 'scope', 'scope TEXT');
}

export function openGlobalDb(): SqliteDb {
  const db = open(join(globalConfigDir(), 'global.db'));
  applySchema(db, 'global-schema.sql');
  migrateGlobalDb(db);
  return db;
}

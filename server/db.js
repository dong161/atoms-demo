// 数据库适配层：有 DATABASE_URL 用 Postgres（线上），否则用 Node 内置 SQLite（本地开发）。
// SQL 统一写成 Postgres 风格的 $1 占位符，SQLite 下自动转换成 ?。
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  plan TEXT,
  current_version_id TEXT,
  published_version_id TEXT,
  share_slug TEXT UNIQUE,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id, updated_at);
CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  title TEXT NOT NULL,
  html TEXT NOT NULL,
  model TEXT,
  source TEXT NOT NULL,
  score INTEGER,
  score_detail TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_versions_project ON versions(project_id, seq);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  role TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  meta TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project_id, created_at);
CREATE TABLE IF NOT EXISTS races (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  instruction TEXT NOT NULL,
  base_version_id TEXT,
  status TEXT NOT NULL,
  adopted_entry_id TEXT,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS race_entries (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  html TEXT,
  error TEXT,
  source TEXT,
  duration_ms INTEGER,
  score INTEGER,
  score_detail TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entries_race ON race_entries(race_id);
CREATE TABLE IF NOT EXISTS app_kv (
  project_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  k TEXT NOT NULL,
  v TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (project_id, scope, k)
);
`;

export async function openDb({ databaseUrl = process.env.DATABASE_URL, sqlitePath } = {}) {
  if (databaseUrl) return openPg(databaseUrl);
  return openSqlite(sqlitePath ?? path.resolve('data/atoms-demo.db'));
}

async function openPg(url) {
  const { default: pg } = await import('pg');
  const local = /localhost|127\.0\.0\.1/.test(url);
  const pool = new pg.Pool({
    connectionString: url,
    ssl: local ? false : { rejectUnauthorized: false },
    max: 5,
  });
  await pool.query(SCHEMA);
  return {
    kind: 'postgres',
    async all(sql, params = []) { return (await pool.query(sql, params)).rows; },
    async get(sql, params = []) { return (await pool.query(sql, params)).rows[0]; },
    async run(sql, params = []) { const r = await pool.query(sql, params); return { changes: r.rowCount }; },
    async close() { await pool.end(); },
  };
}

async function openSqlite(file) {
  const { DatabaseSync } = await import('node:sqlite');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  const conv = (sql) => sql.replace(/\$\d+/g, '?');
  const norm = (row) => (row ? { ...row } : row);
  return {
    kind: 'sqlite',
    async all(sql, params = []) { return db.prepare(conv(sql)).all(...params).map(norm); },
    async get(sql, params = []) { return norm(db.prepare(conv(sql)).get(...params)); },
    async run(sql, params = []) { const r = db.prepare(conv(sql)).run(...params); return { changes: Number(r.changes) }; },
    async close() { db.close(); },
  };
}

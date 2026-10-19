import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { RecentProject } from '@cutroom/core';

function open(file: string): Database.Database {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

/** App-level store: settings and recent projects (lives in the per-user data directory). */
export class AppDb {
  private readonly db: Database.Database;

  constructor(file: string) {
    this.db = open(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recent_projects (
        path TEXT PRIMARY KEY, name TEXT NOT NULL, opened_at INTEGER NOT NULL
      );
    `);
  }

  getSetting<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  touchRecent(projectPath: string, name: string): void {
    this.db
      .prepare('INSERT INTO recent_projects(path, name, opened_at) VALUES(?, ?, ?) ON CONFLICT(path) DO UPDATE SET name = excluded.name, opened_at = excluded.opened_at')
      .run(projectPath, name, Date.now());
  }

  recent(limit = 12): RecentProject[] {
    const rows = this.db
      .prepare('SELECT path, name, opened_at AS openedAt FROM recent_projects ORDER BY opened_at DESC LIMIT ?')
      .all(limit) as RecentProject[];
    return rows;
  }

  forgetRecent(projectPath: string): void {
    this.db.prepare('DELETE FROM recent_projects WHERE path = ?').run(projectPath);
  }

  close(): void {
    this.db.close();
  }
}

export interface FileIndexRow {
  path: string;
  fingerprint: string;
  size: number;
  mtimeMs: number;
  mediaId: string | null;
}

/** Per-project index inside `.cutroom/`: lets rescans skip hashing unchanged files, and logs job outcomes. */
export class ProjectDb {
  private readonly db: Database.Database;

  constructor(file: string) {
    this.db = open(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL, media_id TEXT
      );
      CREATE INDEX IF NOT EXISTS files_fp ON files(fingerprint);
      CREATE TABLE IF NOT EXISTS job_log (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, media_id TEXT, state TEXT NOT NULL,
        started_at INTEGER, finished_at INTEGER, error TEXT
      );
    `);
  }

  getFile(p: string): FileIndexRow | undefined {
    const r = this.db
      .prepare('SELECT path, fingerprint, size, mtime_ms AS mtimeMs, media_id AS mediaId FROM files WHERE path = ?')
      .get(p) as FileIndexRow | undefined;
    return r;
  }

  putFile(row: FileIndexRow): void {
    this.db
      .prepare(
        `INSERT INTO files(path, fingerprint, size, mtime_ms, media_id) VALUES(@path, @fingerprint, @size, @mtimeMs, @mediaId)
         ON CONFLICT(path) DO UPDATE SET fingerprint = @fingerprint, size = @size, mtime_ms = @mtimeMs, media_id = @mediaId`,
      )
      .run(row);
  }

  removeFile(p: string): void {
    this.db.prepare('DELETE FROM files WHERE path = ?').run(p);
  }

  findByFingerprint(fingerprint: string): FileIndexRow[] {
    return this.db
      .prepare('SELECT path, fingerprint, size, mtime_ms AS mtimeMs, media_id AS mediaId FROM files WHERE fingerprint = ?')
      .all(fingerprint) as FileIndexRow[];
  }

  logJob(row: { id: string; kind: string; mediaId?: string; state: string; startedAt?: number; finishedAt?: number; error?: string }): void {
    this.db
      .prepare(
        `INSERT INTO job_log(id, kind, media_id, state, started_at, finished_at, error)
         VALUES(@id, @kind, @mediaId, @state, @startedAt, @finishedAt, @error)
         ON CONFLICT(id) DO UPDATE SET state = @state, started_at = @startedAt, finished_at = @finishedAt, error = @error`,
      )
      .run({ mediaId: null, startedAt: null, finishedAt: null, error: null, ...row });
  }

  close(): void {
    this.db.close();
  }
}

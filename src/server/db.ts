import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type DB = DatabaseSync;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT    NOT NULL,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL CHECK (role IN ('admin', 'author')),
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    token_hash TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_expiry ON sessions (expires_at);

  CREATE TABLE articles (
    id           INTEGER PRIMARY KEY,
    slug         TEXT    NOT NULL UNIQUE,
    title        TEXT    NOT NULL,
    summary      TEXT    NOT NULL DEFAULT '',
    body         TEXT    NOT NULL DEFAULT '',
    category     TEXT    NOT NULL,
    cover        TEXT,
    status       TEXT    NOT NULL CHECK (status IN ('draft', 'published')),
    word_count   INTEGER NOT NULL DEFAULT 0,
    author_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    published_at INTEGER
  );
  CREATE INDEX articles_feed     ON articles (status, published_at DESC);
  CREATE INDEX articles_category ON articles (category, status, published_at DESC);
  CREATE INDEX articles_author   ON articles (author_id, updated_at DESC);

  CREATE VIRTUAL TABLE articles_fts USING fts5(
    title, summary, body,
    content = 'articles', content_rowid = 'id',
    tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER articles_ai AFTER INSERT ON articles BEGIN
    INSERT INTO articles_fts (rowid, title, summary, body) VALUES (new.id, new.title, new.summary, new.body);
  END;
  CREATE TRIGGER articles_ad AFTER DELETE ON articles BEGIN
    INSERT INTO articles_fts (articles_fts, rowid, title, summary, body) VALUES ('delete', old.id, old.title, old.summary, old.body);
  END;
  CREATE TRIGGER articles_au AFTER UPDATE ON articles BEGIN
    INSERT INTO articles_fts (articles_fts, rowid, title, summary, body) VALUES ('delete', old.id, old.title, old.summary, old.body);
    INSERT INTO articles_fts (rowid, title, summary, body) VALUES (new.id, new.title, new.summary, new.body);
  END;
  `,
];

function migrate(db: DB): void {
  const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

/** Opens (and creates/migrates) the database. Pass ":memory:" for tests. */
export function openDb(file: string): DB {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  if (file !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  migrate(db);
  return db;
}

export function transaction<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

import { Pool, type QueryResultRow } from "pg";
import { config } from "../config.js";

let pool: Pool | undefined;
let ready = false;
let checked = false;
let lastError = "";
let nextRetryAt = 0;

const syncSchema = `
CREATE TABLE IF NOT EXISTS sync_diaries (
  user_key TEXT NOT NULL,
  diary_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  last_modified_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_key, diary_id)
);

CREATE INDEX IF NOT EXISTS sync_diaries_user_modified_idx
  ON sync_diaries (user_key, last_modified_at DESC);

CREATE TABLE IF NOT EXISTS sync_user_settings (
  user_key TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS uploaded_files (
  user_key TEXT NOT NULL,
  file_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size BIGINT NOT NULL,
  storage_path TEXT NOT NULL,
  relative_url TEXT NOT NULL,
  public_url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_key, file_id)
);

CREATE INDEX IF NOT EXISTS uploaded_files_user_created_idx
  ON uploaded_files (user_key, created_at DESC);
`;

function getPool() {
  pool ??= new Pool({
    connectionString: config.DATABASE_URL,
    connectionTimeoutMillis: 1200,
    idleTimeoutMillis: 5000,
    max: 5
  });
  return pool;
}

export async function ensureDatabase() {
  if (ready) return true;
  if (checked && Date.now() < nextRetryAt) return false;
  try {
    await getPool().query(syncSchema);
    ready = true;
    checked = true;
    lastError = "";
    return true;
  } catch (error) {
    ready = false;
    checked = true;
    lastError = error instanceof Error ? error.message : "Unknown database error";
    nextRetryAt = Date.now() + 10_000;
    return false;
  }
}

export async function dbQuery<T extends QueryResultRow>(text: string, params: unknown[] = []) {
  const available = await ensureDatabase();
  if (!available) throw new Error(lastError || "Database is not available");
  return getPool().query<T>(text, params);
}

export async function getDatabaseStatus() {
  if (!checked) await ensureDatabase();
  return {
    available: ready,
    fallback: ready ? "postgres" : "memory",
    error: ready ? "" : lastError || "PostgreSQL is not connected"
  };
}

import type { Diary, UserSettings } from "@tietie/shared";
import type { FastifyPluginAsync } from "fastify";
import { dbQuery, ensureDatabase } from "../db/client.js";

const userDiaries = new Map<string, Map<string, Diary>>();
const userSettings = new Map<string, UserSettings>();

interface SyncConflict {
  id: string;
  kept: "client" | "server";
}

interface DiaryRow {
  payload: Diary;
}

interface SettingsRow {
  payload: UserSettings;
}

function getUserKey(user: unknown) {
  const payload = user as { email?: string; sub?: string };
  return payload.email ?? payload.sub ?? "anonymous";
}

function getMemoryBucket(userKey: string) {
  let bucket = userDiaries.get(userKey);
  if (!bucket) {
    bucket = new Map<string, Diary>();
    userDiaries.set(userKey, bucket);
  }
  return bucket;
}

function newerOf(client: Diary, server: Diary) {
  return client.lastModifiedAt >= server.lastModifiedAt ? client : server;
}

async function pullFromPostgres(userKey: string) {
  const result = await dbQuery<DiaryRow>(
    `SELECT payload
       FROM sync_diaries
      WHERE user_key = $1
      ORDER BY last_modified_at DESC`,
    [userKey]
  );
  return result.rows.map((row) => row.payload);
}

async function pullSettingsFromPostgres(userKey: string) {
  const result = await dbQuery<SettingsRow>(`SELECT payload FROM sync_user_settings WHERE user_key = $1`, [userKey]);
  return result.rows[0]?.payload ?? null;
}

async function pushSettingsToPostgres(userKey: string, settings: UserSettings) {
  await dbQuery(
    `INSERT INTO sync_user_settings (user_key, payload, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (user_key)
     DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
    [userKey, JSON.stringify(settings)]
  );
}

async function pushToPostgres(userKey: string, diaries: Diary[]) {
  const conflicts: SyncConflict[] = [];

  for (const diary of diaries) {
    const existing = await dbQuery<DiaryRow>(
      `SELECT payload
         FROM sync_diaries
        WHERE user_key = $1 AND diary_id = $2`,
      [userKey, diary.id]
    );
    const serverDiary = existing.rows[0]?.payload;
    const next = serverDiary ? newerOf(diary, serverDiary) : diary;

    await dbQuery(
      `INSERT INTO sync_diaries (user_key, diary_id, payload, last_modified_at, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, now())
       ON CONFLICT (user_key, diary_id)
       DO UPDATE SET
         payload = EXCLUDED.payload,
         last_modified_at = EXCLUDED.last_modified_at,
         updated_at = now()`,
      [userKey, diary.id, JSON.stringify(next), next.lastModifiedAt]
    );

    if (serverDiary && serverDiary.lastModifiedAt !== diary.lastModifiedAt) {
      conflicts.push({
        id: diary.id,
        kept: next === diary ? "client" : "server"
      });
    }
  }

  return {
    conflicts,
    diaries: await pullFromPostgres(userKey)
  };
}

async function deleteFromPostgres(userKey: string, diaryIds: string[]) {
  if (!diaryIds.length) return;
  await dbQuery(`DELETE FROM sync_diaries WHERE user_key = $1 AND diary_id = ANY($2::text[])`, [userKey, diaryIds]);
}

function pullFromMemory(userKey: string) {
  const bucket = getMemoryBucket(userKey);
  return [...bucket.values()].sort((a, b) => b.lastModifiedAt.localeCompare(a.lastModifiedAt));
}

function pullSettingsFromMemory(userKey: string) {
  return userSettings.get(userKey) ?? null;
}

function pushToMemory(userKey: string, diaries: Diary[]) {
  const bucket = getMemoryBucket(userKey);
  const conflicts: SyncConflict[] = [];

  for (const diary of diaries) {
    const existing = bucket.get(diary.id);
    if (!existing) {
      bucket.set(diary.id, diary);
      continue;
    }
    const next = newerOf(diary, existing);
    bucket.set(diary.id, next);
    if (existing.lastModifiedAt !== diary.lastModifiedAt) {
      conflicts.push({
        id: diary.id,
        kept: next === diary ? "client" : "server"
      });
    }
  }

  return {
    conflicts,
    diaries: pullFromMemory(userKey)
  };
}

function deleteFromMemory(userKey: string, diaryIds: string[]) {
  if (!diaryIds.length) return;
  const bucket = getMemoryBucket(userKey);
  for (const id of diaryIds) bucket.delete(id);
}

function pushSettingsToMemory(userKey: string, settings: UserSettings) {
  userSettings.set(userKey, settings);
}

export const syncRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/pull", async (request) => {
    const userKey = getUserKey(request.user);
    const databaseAvailable = await ensureDatabase();
    const diaries = databaseAvailable ? await pullFromPostgres(userKey) : pullFromMemory(userKey);
    const settings = databaseAvailable ? await pullSettingsFromPostgres(userKey) : pullSettingsFromMemory(userKey);

    return {
      serverTime: new Date().toISOString(),
      storage: databaseAvailable ? "postgres" : "memory",
      diaries,
      settings
    };
  });

  app.post("/push", async (request) => {
    const userKey = getUserKey(request.user);
    const payload = request.body as { diaries?: Diary[]; deletedDiaryIds?: string[]; settings?: UserSettings };
    const input = payload.diaries ?? [];
    const deletedDiaryIds = [...new Set(payload.deletedDiaryIds ?? [])].filter(Boolean);
    const databaseAvailable = await ensureDatabase();
    if (databaseAvailable) {
      await deleteFromPostgres(userKey, deletedDiaryIds);
      if (payload.settings) await pushSettingsToPostgres(userKey, payload.settings);
    } else {
      deleteFromMemory(userKey, deletedDiaryIds);
      if (payload.settings) pushSettingsToMemory(userKey, payload.settings);
    }
    const result = databaseAvailable ? await pushToPostgres(userKey, input) : pushToMemory(userKey, input);
    const settings = databaseAvailable ? await pullSettingsFromPostgres(userKey) : pullSettingsFromMemory(userKey);

    return {
      accepted: input.length + deletedDiaryIds.length,
      conflicts: result.conflicts,
      serverTime: new Date().toISOString(),
      storage: databaseAvailable ? "postgres" : "memory",
      diaries: result.diaries,
      settings
    };
  });

  app.post("/resolve-conflict", async () => ({
    ok: true,
    strategy: "last-write-wins-with-conflict-copy"
  }));
};

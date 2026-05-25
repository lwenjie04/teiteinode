import type { FastifyPluginAsync } from "fastify";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { config } from "../config.js";
import { dbQuery, ensureDatabase } from "../db/client.js";

interface FileRow {
  file_id: string;
  filename: string;
  mime_type: string;
  size: string;
  relative_url: string;
  public_url: string;
  storage_path: string;
  created_at: string;
}

const memoryFiles = new Map<string, Map<string, FileRow>>();

function getUserKey(user: unknown) {
  const payload = user as { email?: string; sub?: string };
  return payload.email ?? payload.sub ?? "anonymous";
}

function getMemoryBucket(userKey: string) {
  let bucket = memoryFiles.get(userKey);
  if (!bucket) {
    bucket = new Map<string, FileRow>();
    memoryFiles.set(userKey, bucket);
  }
  return bucket;
}

function serializeFileRow(row: FileRow) {
  return {
    id: row.file_id,
    filename: row.filename,
    mimeType: row.mime_type,
    size: Number(row.size),
    relativeUrl: row.relative_url,
    url: row.public_url,
    storagePath: row.storage_path,
    createdAt: row.created_at
  };
}

function sanitizeFilename(filename: string) {
  return filename.replace(/[^\w.-]/g, "_").slice(0, 120);
}

function isInsideStorage(storagePath: string) {
  const root = path.resolve(config.STORAGE_DIR);
  const target = path.resolve(storagePath);
  return target === root || target.startsWith(`${root}${path.sep}`);
}

async function insertFileMetadata(input: {
  userKey: string;
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  storagePath: string;
  relativeUrl: string;
  publicUrl: string;
}) {
  const available = await ensureDatabase();
  if (!available) {
    getMemoryBucket(input.userKey).set(input.id, {
      file_id: input.id,
      filename: input.filename,
      mime_type: input.mimeType,
      size: String(input.size),
      storage_path: input.storagePath,
      relative_url: input.relativeUrl,
      public_url: input.publicUrl,
      created_at: new Date().toISOString()
    });
    return "memory";
  }

  await dbQuery(
    `INSERT INTO uploaded_files
      (user_key, file_id, filename, mime_type, size, storage_path, relative_url, public_url, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (user_key, file_id)
     DO UPDATE SET
       filename = EXCLUDED.filename,
       mime_type = EXCLUDED.mime_type,
       size = EXCLUDED.size,
       storage_path = EXCLUDED.storage_path,
       relative_url = EXCLUDED.relative_url,
       public_url = EXCLUDED.public_url`,
    [input.userKey, input.id, input.filename, input.mimeType, input.size, input.storagePath, input.relativeUrl, input.publicUrl]
  );
  return "postgres";
}

export const fileRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async (request) => {
    const userKey = getUserKey(request.user);
    const available = await ensureDatabase();
    if (!available) {
      return {
        storage: "memory",
        items: [...getMemoryBucket(userKey).values()].sort((a, b) => b.created_at.localeCompare(a.created_at)).map(serializeFileRow),
        message: "数据库未连接，当前显示本次服务运行期间的内存文件记录。"
      };
    }

    const result = await dbQuery<FileRow>(
      `SELECT file_id, filename, mime_type, size, relative_url, public_url, storage_path, created_at
         FROM uploaded_files
        WHERE user_key = $1
        ORDER BY created_at DESC
        LIMIT 200`,
      [userKey]
    );

    return {
      storage: "postgres",
      items: result.rows.map(serializeFileRow)
    };
  });

  app.get("/stats", async (request) => {
    const userKey = getUserKey(request.user);
    const available = await ensureDatabase();
    if (!available) {
      const rows = [...getMemoryBucket(userKey).values()];
      return {
        storage: "memory",
        count: rows.length,
        totalSize: rows.reduce((sum, row) => sum + Number(row.size), 0)
      };
    }

    const result = await dbQuery<{ count: string; total_size: string | null }>(
      `SELECT COUNT(*)::text AS count, COALESCE(SUM(size), 0)::text AS total_size
         FROM uploaded_files
        WHERE user_key = $1`,
      [userKey]
    );

    return {
      storage: "postgres",
      count: Number(result.rows[0]?.count ?? 0),
      totalSize: Number(result.rows[0]?.total_size ?? 0)
    };
  });

  app.post("/upload", async (request, reply) => {
    const file = await request.file();
    if (!file) return reply.code(400).send({ message: "没有收到文件" });
    if (!file.mimetype.startsWith("image/")) {
      return reply.code(415).send({ message: "目前只支持上传图片文件" });
    }

    const id = randomUUID();
    const safeName = `${id}-${sanitizeFilename(file.filename || "image")}`;
    const dateFolder = new Date().toISOString().slice(0, 10);
    const folder = path.join(config.STORAGE_DIR, dateFolder);
    await mkdir(folder, { recursive: true });
    const storagePath = path.join(folder, safeName);

    let size = 0;
    file.file.on("data", (chunk: Buffer) => {
      size += chunk.length;
    });
    await pipeline(file.file, createWriteStream(storagePath));

    const relativeUrl = `/uploads/${dateFolder}/${safeName}`;
    const publicUrl = `${config.PUBLIC_BASE_URL}${relativeUrl}`;
    const metadataStorage = await insertFileMetadata({
      userKey: getUserKey(request.user),
      id,
      filename: file.filename,
      mimeType: file.mimetype,
      size,
      storagePath,
      relativeUrl,
      publicUrl
    });

    return {
      id,
      filename: file.filename,
      mimeType: file.mimetype,
      size,
      relativeUrl,
      url: publicUrl,
      metadataStored: true,
      storage: metadataStorage
    };
  });

  app.delete("/:id", async (request) => {
    const userKey = getUserKey(request.user);
    const { id } = request.params as { id: string };
    const available = await ensureDatabase();
    let deletedFile = false;
    let deletedMetadata = false;

    if (available) {
      const existing = await dbQuery<{ storage_path: string }>(
        `SELECT storage_path
           FROM uploaded_files
          WHERE user_key = $1 AND file_id = $2`,
        [userKey, id]
      );
      const storagePath = existing.rows[0]?.storage_path;
      if (storagePath && isInsideStorage(storagePath)) {
        try {
          await unlink(storagePath);
          deletedFile = true;
        } catch {
          deletedFile = false;
        }
      }
      const result = await dbQuery(`DELETE FROM uploaded_files WHERE user_key = $1 AND file_id = $2`, [userKey, id]);
      deletedMetadata = (result.rowCount ?? 0) > 0;
    } else {
      const bucket = getMemoryBucket(userKey);
      const existing = bucket.get(id);
      const storagePath = existing?.storage_path;
      if (storagePath && isInsideStorage(storagePath)) {
        try {
          await unlink(storagePath);
          deletedFile = true;
        } catch {
          deletedFile = false;
        }
      }
      deletedMetadata = bucket.delete(id);
    }

    return {
      ok: true,
      deletedMetadata,
      deletedFile,
      message: deletedMetadata ? "文件记录已删除，磁盘文件已尝试清理。" : "没有找到可删除的文件记录。"
    };
  });
};

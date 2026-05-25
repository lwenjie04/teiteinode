import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import Fastify from "fastify";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { getDatabaseStatus } from "./db/client.js";
import { aiRoutes } from "./modules/ai.js";
import { authRoutes } from "./modules/auth.js";
import { diaryRoutes } from "./modules/diaries.js";
import { fileRoutes } from "./modules/files.js";
import { syncRoutes } from "./modules/sync.js";

export async function buildServer() {
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === "development" ? "info" : "warn"
    }
  });

  await mkdir(config.STORAGE_DIR, { recursive: true });

  await app.register(cors, {
    origin: true,
    credentials: true
  });
  await app.register(jwt, { secret: config.JWT_SECRET });
  await app.register(multipart, {
    limits: {
      fileSize: 12 * 1024 * 1024
    }
  });
  await app.register(staticFiles, {
    root: path.resolve(config.STORAGE_DIR),
    prefix: "/uploads/"
  });
  await app.register(staticFiles, {
    root: path.resolve(config.STORAGE_DIR),
    prefix: "/assets/",
    decorateReply: false
  });

  app.decorate("authenticate", async (request) => {
    await request.jwtVerify();
  });

  app.get("/api/health", async () => ({
    ok: true,
    name: "贴贴日记 API",
    aiConfigured: Boolean(config.AI_PROVIDER && config.AI_API_KEY),
    database: await getDatabaseStatus()
  }));

  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(syncRoutes, { prefix: "/api/sync" });
  await app.register(diaryRoutes, { prefix: "/api/diaries" });
  await app.register(fileRoutes, { prefix: "/api/files" });
  await app.register(aiRoutes, { prefix: "/api/ai" });

  return app;
}

const app = await buildServer();
await app.listen({ port: config.PORT, host: "0.0.0.0" });

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

function loadEnvFile(filePath: string) {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    if (!key || process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, "");
  }
}

loadEnvFile(path.resolve(process.cwd(), ".env"));
loadEnvFile(path.resolve(process.cwd(), "apps/api/.env"));

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().default("postgres://tietie:tietie_dev@localhost:5432/tietie_diary"),
  JWT_SECRET: z.string().default("dev-secret"),
  STORAGE_DIR: z.string().default("./storage"),
  PUBLIC_BASE_URL: z.string().default("http://localhost:4000"),
  AI_PROVIDER: z.string().optional(),
  AI_API_KEY: z.string().optional(),
  AI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  AI_MODEL: z.string().default("gpt-4.1-mini"),
  AI_IMAGE_MODEL: z.string().default("gpt-image-1")
});

export const config = envSchema.parse(process.env);

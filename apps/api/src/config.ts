import { z } from "zod";

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
  AI_MODEL: z.string().default("gpt-4.1-mini")
});

export const config = envSchema.parse(process.env);

import type { FastifyPluginAsync } from "fastify";
import { createHash, randomInt } from "node:crypto";
import { z } from "zod";
import { config } from "../config.js";

const emailSchema = z.object({
  email: z.string().email().transform((email) => email.trim().toLowerCase())
});

const verifySchema = emailSchema.extend({
  code: z.string().regex(/^\d{6}$/)
});

interface EmailCodeRecord {
  codeHash: string;
  expiresAt: number;
  attempts: number;
  lastSentAt: number;
}

const emailCodes = new Map<string, EmailCodeRecord>();
const codeTtlMs = 10 * 60 * 1000;
const resendCooldownMs = 30 * 1000;
const maxAttempts = 5;

function hashCode(email: string, code: string) {
  return createHash("sha256").update(`${config.JWT_SECRET}:${email}:${code}`).digest("hex");
}

function createCode() {
  return String(randomInt(100000, 1_000_000));
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post("/email-code/send", async (request, reply) => {
    const { email } = emailSchema.parse(request.body);
    const existing = emailCodes.get(email);
    const now = Date.now();
    if (existing && now - existing.lastSentAt < resendCooldownMs) {
      return reply.code(429).send({
        ok: false,
        message: "验证码发送太频繁，请稍后再试。"
      });
    }

    const code = createCode();
    emailCodes.set(email, {
      codeHash: hashCode(email, code),
      expiresAt: now + codeTtlMs,
      attempts: 0,
      lastSentAt: now
    });

    request.log.info({ email, devCode: config.NODE_ENV === "production" ? undefined : code }, "email code requested");

    return {
      ok: true,
      message: config.NODE_ENV === "production" ? "验证码已发送，请检查邮箱。" : "开发环境验证码已生成。",
      devCode: config.NODE_ENV === "production" ? undefined : code,
      expiresInSeconds: Math.round(codeTtlMs / 1000)
    };
  });

  app.post("/email-code/verify", async (request, reply) => {
    const { email, code } = verifySchema.parse(request.body);
    const record = emailCodes.get(email);
    if (!record) {
      return reply.code(401).send({ message: "请先获取验证码。" });
    }
    if (Date.now() > record.expiresAt) {
      emailCodes.delete(email);
      return reply.code(401).send({ message: "验证码已过期，请重新获取。" });
    }
    if (record.attempts >= maxAttempts) {
      emailCodes.delete(email);
      return reply.code(401).send({ message: "验证码错误次数过多，请重新获取。" });
    }
    if (record.codeHash !== hashCode(email, code)) {
      record.attempts += 1;
      return reply.code(401).send({ message: "验证码不正确。" });
    }

    emailCodes.delete(email);
    const token = app.jwt.sign({ sub: email, email }, { expiresIn: "30d" });

    return {
      token,
      user: {
        id: email,
        email
      }
    };
  });

  app.post("/logout", async () => ({
    ok: true
  }));

  app.get("/me", { preHandler: app.authenticate }, async (request) => {
    return {
      user: request.user
    };
  });
};

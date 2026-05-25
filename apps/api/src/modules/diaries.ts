import type { Diary } from "@tietie/shared";
import type { FastifyPluginAsync } from "fastify";

const memoryDiaries = new Map<string, Diary>();

export const diaryRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async () => ({
    items: [...memoryDiaries.values()]
  }));

  app.get("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const diary = memoryDiaries.get(id);
    if (!diary) return reply.code(404).send({ message: "日记不存在" });
    return diary;
  });

  app.post("/", async (request) => {
    const diary = request.body as Diary;
    memoryDiaries.set(diary.id, diary);
    return diary;
  });

  app.patch("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = memoryDiaries.get(id);
    if (!existing) return reply.code(404).send({ message: "日记不存在" });

    const next = {
      ...existing,
      ...(request.body as Partial<Diary>),
      updatedAt: new Date().toISOString()
    };
    memoryDiaries.set(id, next);
    return next;
  });

  app.delete("/:id", async (request) => {
    const { id } = request.params as { id: string };
    memoryDiaries.delete(id);
    return { ok: true };
  });
};

import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper to resolve current user id from request (adapt as needed to Sovereign auth)
function getUserId(req) {
  // Adjust this to match Sovereign's auth/user injection
  return (req.user && req.user.id) || req.userId || req.session?.userId || null;
}

// ctx = { prisma, logger, etc. }

export default (ctx) => {
  const router = express.Router();

  const prisma = ctx.prisma;
  const logger = ctx.logger || console;

  function asyncHandler(fn) {
    return function (req, res, next) {
      Promise.resolve(fn(req, res, next)).catch(next);
    };
  }

  // API: Bootstrap tasks state
  router.get("/bootstrap", asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const [lists, tasks] = await Promise.all([
      prisma.taskList.findMany({
        where: { userId },
        orderBy: [{ position: "asc" }, { id: "asc" }],
      }),
      prisma.task.findMany({
        where: { userId },
        orderBy: [{ listId: "asc" }, { position: "asc" }, { id: "asc" }],
      }),
    ]);

    const now = new Date().toISOString();

    res.json({
      meta: {
        version: "2.0.0",
        updatedAt: now,
      },
      lists,
      tasks,
    });
  }));

  // API: List all lists
  router.get("/lists", asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const lists = await prisma.taskList.findMany({
      where: { userId },
      orderBy: [{ position: "asc" }, { id: "asc" }],
    });

    res.json(lists);
  }));

  // API: Create a new list
  router.post("/lists", asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { name, slug } = req.body || {};
    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "name is required" });
    }

    const count = await prisma.taskList.count({ where: { userId } });

    const created = await prisma.taskList.create({
      data: {
        userId,
        name,
        slug: slug && typeof slug === "string" ? slug : name.toLowerCase().replace(/\s+/g, "-"),
        position: count,
      },
    });

    res.status(201).json(created);
  }));

  // API: Update / rename a list
  router.put("/lists/:id", asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

    const { name, slug } = req.body || {};

    const existing = await prisma.taskList.findFirst({
      where: { id, userId },
    });
    if (!existing) return res.status(404).json({ error: "List not found" });

    const updated = await prisma.taskList.update({
      where: { id },
      data: {
        name: typeof name === "string" ? name : existing.name,
        slug: typeof slug === "string"
          ? slug
          : existing.slug,
      },
    });

    res.json(updated);
  }));

  // API: Delete a list (and its tasks)
  router.delete("/lists/:id", asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

    const existing = await prisma.taskList.findFirst({
      where: { id, userId },
    });
    if (!existing) return res.status(404).json({ error: "List not found" });

    await prisma.$transaction([
      prisma.task.deleteMany({ where: { listId: id, userId } }),
      prisma.taskList.delete({ where: { id } }),
    ]);

    res.json({ ok: true });
  }));

  // API: Reorder lists (full order)
  router.put("/lists/order", asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { listOrder } = req.body || {};
    if (!Array.isArray(listOrder) || listOrder.some((v) => !Number.isFinite(Number(v)))) {
      return res.status(400).json({ error: "listOrder must be an array of ids" });
    }

    const ids = listOrder.map((v) => Number(v));

    const lists = await prisma.taskList.findMany({
      where: { userId, id: { in: ids } },
      select: { id: true },
    });
    const existingIds = new Set(lists.map((l) => l.id));
    const missing = ids.filter((id) => !existingIds.has(id));
    if (missing.length > 0) {
      return res.status(400).json({ error: "Some lists do not exist or do not belong to user", missing });
    }

    await prisma.$transaction(
      ids.map((id, index) =>
        prisma.taskList.update({
          where: { id },
          data: { position: index },
        })
      )
    );

    res.json({ ok: true });
  }));

  // API: List tasks (optionally by list)
  router.get("/", asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const listIdParam = req.query.listId;
    const where = { userId };
    if (typeof listIdParam !== "undefined") {
      const listId = Number(listIdParam);
      if (!Number.isFinite(listId)) {
        return res.status(400).json({ error: "Invalid listId" });
      }
      where.listId = listId;
    }

    const tasks = await prisma.task.findMany({
      where,
      orderBy: [{ listId: "asc" }, { position: "asc" }, { id: "asc" }],
    });

    res.json(tasks);
  }));

  // API: Create a new task
  router.post("/", asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const {
      listId,
      title,
      description,
      dueDate,
      recurringConfig,
      starred,
    } = req.body || {};

    const parsedListId = Number(listId);
    if (!Number.isFinite(parsedListId)) {
      return res.status(400).json({ error: "listId is required and must be a number" });
    }
    if (!title || typeof title !== "string") {
      return res.status(400).json({ error: "title is required" });
    }

    console.log("!!!!!Creating task in listId:", parsedListId, userId);

    const list = await prisma.taskList.findFirst({
      where: { id: parsedListId, userId },
    });
    if (!list) return res.status(404).json({ error: "List not found" });

    const countInList = await prisma.task.count({
      where: { userId, listId: parsedListId },
    });

    const created = await prisma.task.create({
      data: {
        userId,
        listId: parsedListId,
        title,
        description: typeof description === "string" ? description : null,
        dueDate: dueDate ? new Date(dueDate) : null,
        recurringConfig: recurringConfig || null,
        completed: false,
        starred: !!starred,
        position: countInList,
      },
    });

    res.status(201).json(created);
  }));

  // API: Update a task
  router.put("/:id", asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

    const existing = await prisma.task.findFirst({
      where: { id, userId },
    });
    if (!existing) return res.status(404).json({ error: "Task not found" });

    const {
      listId,
      title,
      description,
      dueDate,
      recurringConfig,
      completed,
      starred,
      position,
    } = req.body || {};

    const data = {};

    if (typeof listId !== "undefined") {
      const newListId = Number(listId);
      if (!Number.isFinite(newListId)) {
        return res.status(400).json({ error: "Invalid listId" });
      }
      data.listId = newListId;
    }

    if (typeof title === "string") data.title = title;
    if (typeof description !== "undefined") {
      data.description = typeof description === "string" ? description : null;
    }
    if (typeof dueDate !== "undefined") {
      data.dueDate = dueDate ? new Date(dueDate) : null;
    }
    if (typeof recurringConfig !== "undefined") {
      data.recurringConfig = recurringConfig || null;
    }
    if (typeof completed !== "undefined") data.completed = !!completed;
    if (typeof starred !== "undefined") data.starred = !!starred;
    if (typeof position !== "undefined") {
      const newPos = Number(position);
      if (!Number.isFinite(newPos)) {
        return res.status(400).json({ error: "Invalid position" });
      }
      data.position = newPos;
    }

    const updated = await prisma.task.update({
      where: { id },
      data,
    });

    res.json(updated);
  }));

  // API: Delete a task
  router.delete("/:id", asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

    const existing = await prisma.task.findFirst({
      where: { id, userId },
    });
    if (!existing) return res.status(404).json({ error: "Task not found" });

    await prisma.task.delete({ where: { id } });

    res.json({ ok: true });
  }));

  // API: Reorder tasks within a list (and optionally move into list)
  router.put("/order", asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { listId, taskOrder } = req.body || {};
    const parsedListId = Number(listId);

    if (!Number.isFinite(parsedListId)) {
      return res.status(400).json({ error: "listId is required and must be a number" });
    }
    if (!Array.isArray(taskOrder) || taskOrder.some((v) => !Number.isFinite(Number(v)))) {
      return res.status(400).json({ error: "taskOrder must be an array of ids" });
    }

    const ids = taskOrder.map((v) => Number(v));

    const tasks = await prisma.task.findMany({
      where: { userId, id: { in: ids } },
      select: { id: true },
    });
    const existingIds = new Set(tasks.map((t) => t.id));
    const missing = ids.filter((id) => !existingIds.has(id));
    if (missing.length > 0) {
      return res.status(400).json({ error: "Some tasks do not exist or do not belong to user", missing });
    }

    await prisma.$transaction(
      ids.map((id, index) =>
        prisma.task.update({
          where: { id },
          data: { listId: parsedListId, position: index },
        })
      )
    );

    res.json({ ok: true });
  }));

  // API: Delete all completed tasks in a list
  router.delete("/lists/:id/completed", asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const listId = Number(req.params.id);
    if (!Number.isFinite(listId)) return res.status(400).json({ error: "Invalid list id" });

    const list = await prisma.taskList.findFirst({
      where: { id: listId, userId },
    });
    if (!list) return res.status(404).json({ error: "List not found" });

    const result = await prisma.task.deleteMany({
      where: { userId, listId, completed: true },
    });

    res.json({ ok: true, deletedCount: result.count });
  }));

  return router;
};

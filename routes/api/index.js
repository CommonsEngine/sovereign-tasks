import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper to resolve current user id from request (adapt as needed to Sovereign auth)
function getUserId(req) {
  // Adjust this to match Sovereign's auth/user injection
  return (req.user && req.user.id) || req.userId || req.session?.userId || null;
}

export default (ctx) => {
  const router = express.Router();

  const prisma = ctx.prisma;
  const mailer = ctx.mailer;
  const logger = ctx.logger || console;

  function asyncHandler(fn) {
    return function (req, res, next) {
      Promise.resolve(fn(req, res, next)).catch((err) => {
        try {
          const userId = getUserId(req);
          const meta = {
            path: req.path,
            method: req.method,
            userId: userId || null,
          };
          if (logger && typeof logger.error === "function") {
            logger.error("[tasks-api] Unhandled error", {
              ...meta,
              error: err && err.message,
              stack: err && err.stack,
            });
          } else if (logger && typeof logger.log === "function") {
            logger.log("[tasks-api] Unhandled error", meta, err);
          }
        } catch (logErr) {
          // Swallow logging errors to avoid masking the original error
        }
        next(err);
      });
    };
  }

  // API: Bootstrap tasks state
  router.get("/bootstrap", asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const inviterId = String(userId);

    const [lists, tasks, invites] = await Promise.all([
      prisma.taskList.findMany({
        where: { userId },
        orderBy: [{ position: "asc" }, { id: "asc" }],
      }),
      prisma.task.findMany({
        where: { userId },
        orderBy: [{ listId: "asc" }, { position: "asc" }, { id: "asc" }],
      }),
      prisma.taskListShareInvite.findMany({
        where: { inviterId },
        orderBy: [{ listId: "asc" }, { createdAt: "asc" }, { id: "asc" }],
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
      invites,
    });
    if (logger && typeof logger.info === "function") {
      logger.info("[tasks-api] bootstrap", {
        userId,
        listsCount: lists.length,
        tasksCount: tasks.length,
        invitesCount: invites.length,
      });
    }
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
    if (logger && typeof logger.info === "function") {
      logger.info("[tasks-api] lists:list", {
        userId,
        listsCount: lists.length,
      });
    }
  }));

  // API: Create a new list
  router.post("/lists", asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { name, slug } = req.body || {};
    if (!name || typeof name !== "string") {
      if (logger && typeof logger.warn === "function") {
        logger.warn("[tasks-api] lists:create invalid payload", {
          userId,
          body: req.body,
        });
      }
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
    if (logger && typeof logger.info === "function") {
      logger.info("[tasks-api] lists:create", {
        userId,
        listId: created.id,
        name: created.name,
      });
    }
  }));

  // API: Update / rename a list
  router.put("/lists/:id", asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      if (logger && typeof logger.warn === "function") {
        logger.warn("[tasks-api] lists:update invalid id", {
          userId,
          rawId: req.params.id,
        });
      }
      return res.status(400).json({ error: "Invalid id" });
    }

    const { name, slug } = req.body || {};

    const existing = await prisma.taskList.findFirst({
      where: { id, userId },
    });
    if (!existing) {
      if (logger && typeof logger.warn === "function") {
        logger.warn("[tasks-api] lists:update not found", {
          userId,
          id,
        });
      }
      return res.status(404).json({ error: "List not found" });
    }

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
    if (logger && typeof logger.info === "function") {
      logger.info("[tasks-api] lists:update", {
        userId,
        id: updated.id,
        name: updated.name,
      });
    }
  }));

  // API: Delete a list (and its tasks)
  router.delete("/lists/:id", asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      if (logger && typeof logger.warn === "function") {
        logger.warn("[tasks-api] lists:delete invalid id", {
          userId,
          rawId: req.params.id,
        });
      }
      return res.status(400).json({ error: "Invalid id" });
    }

    const existing = await prisma.taskList.findFirst({
      where: { id, userId },
    });
    if (!existing) {
      if (logger && typeof logger.warn === "function") {
        logger.warn("[tasks-api] lists:delete not found", {
          userId,
          id,
        });
      }
      return res.status(404).json({ error: "List not found" });
    }

    await prisma.$transaction([
      prisma.task.deleteMany({ where: { listId: id, userId } }),
      prisma.taskList.delete({ where: { id } }),
    ]);

    res.json({ ok: true });
    if (logger && typeof logger.info === "function") {
      logger.info("[tasks-api] lists:delete", {
        userId,
        id,
      });
    }
  }));

  // API: Reorder lists (full order)
  router.put("/lists/order", asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { listOrder } = req.body || {};
    if (!Array.isArray(listOrder) || listOrder.some((v) => !Number.isFinite(Number(v)))) {
      if (logger && typeof logger.warn === "function") {
        logger.warn("[tasks-api] lists:order invalid listOrder", {
          userId,
          listOrder,
        });
      }
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
      if (logger && typeof logger.warn === "function") {
        logger.warn("[tasks-api] lists:order missing lists", {
          userId,
          missing,
        });
      }
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
    if (logger && typeof logger.info === "function") {
      logger.info("[tasks-api] lists:order", {
        userId,
        listOrder: ids,
      });
    }
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
        if (logger && typeof logger.warn === "function") {
          logger.warn("[tasks-api] tasks:list invalid listId", {
            userId,
            rawListId: listIdParam,
          });
        }
        return res.status(400).json({ error: "Invalid listId" });
      }
      where.listId = listId;
    }

    const tasks = await prisma.task.findMany({
      where,
      orderBy: [{ listId: "asc" }, { position: "asc" }, { id: "asc" }],
    });

    res.json(tasks);
    if (logger && typeof logger.info === "function") {
      logger.info("[tasks-api] tasks:list", {
        userId,
        listId: where.listId || null,
        tasksCount: tasks.length,
      });
    }
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
      if (logger && typeof logger.warn === "function") {
        logger.warn("[tasks-api] tasks:create invalid listId", {
          userId,
          rawListId: listId,
          body: req.body,
        });
      }
      return res.status(400).json({ error: "listId is required and must be a number" });
    }
    if (!title || typeof title !== "string") {
      if (logger && typeof logger.warn === "function") {
        logger.warn("[tasks-api] tasks:create missing title", {
          userId,
          body: req.body,
        });
      }
      return res.status(400).json({ error: "title is required" });
    }

    const list = await prisma.taskList.findFirst({
      where: { id: parsedListId, userId },
    });
    if (!list) {
      if (logger && typeof logger.warn === "function") {
        logger.warn("[tasks-api] tasks:create list not found", {
          userId,
          listId: parsedListId,
        });
      }
      return res.status(404).json({ error: "List not found" });
    }

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
    if (logger && typeof logger.info === "function") {
      logger.info("[tasks-api] tasks:create", {
        userId,
        taskId: created.id,
        listId: created.listId,
        title: created.title,
      });
    }
  }));

  // API: Update a task
  router.put("/:id", asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      if (logger && typeof logger.warn === "function") {
        logger.warn("[tasks-api] tasks:update invalid id", {
          userId,
          rawId: req.params.id,
        });
      }
      return res.status(400).json({ error: "Invalid id" });
    }

    const existing = await prisma.task.findFirst({
      where: { id, userId },
    });
    if (!existing) {
      if (logger && typeof logger.warn === "function") {
        logger.warn("[tasks-api] tasks:update not found", {
          userId,
          id,
        });
      }
      return res.status(404).json({ error: "Task not found" });
    }

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
        if (logger && typeof logger.warn === "function") {
          logger.warn("[tasks-api] tasks:update invalid listId", {
            userId,
            rawListId: listId,
          });
        }
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
        if (logger && typeof logger.warn === "function") {
          logger.warn("[tasks-api] tasks:update invalid position", {
            userId,
            rawPosition: position,
          });
        }
        return res.status(400).json({ error: "Invalid position" });
      }
      data.position = newPos;
    }

    const updated = await prisma.task.update({
      where: { id },
      data,
    });

    res.json(updated);
    if (logger && typeof logger.info === "function") {
      logger.info("[tasks-api] tasks:update", {
        userId,
        id: updated.id,
        listId: updated.listId,
        completed: updated.completed,
        starred: updated.starred,
      });
    }
  }));

  // API: Delete a task
  router.delete("/:id", asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      if (logger && typeof logger.warn === "function") {
        logger.warn("[tasks-api] tasks:delete invalid id", {
          userId,
          rawId: req.params.id,
        });
      }
      return res.status(400).json({ error: "Invalid id" });
    }

    const existing = await prisma.task.findFirst({
      where: { id, userId },
    });
    if (!existing) {
      if (logger && typeof logger.warn === "function") {
        logger.warn("[tasks-api] tasks:delete not found", {
          userId,
          id,
        });
      }
      return res.status(404).json({ error: "Task not found" });
    }

    await prisma.task.delete({ where: { id } });

    res.json({ ok: true });
    if (logger && typeof logger.info === "function") {
      logger.info("[tasks-api] tasks:delete", {
        userId,
        id,
      });
    }
  }));

  // API: Reorder tasks within a list (and optionally move into list)
  router.put("/order", asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { listId, taskOrder } = req.body || {};
    const parsedListId = Number(listId);

    if (!Number.isFinite(parsedListId)) {
      if (logger && typeof logger.warn === "function") {
        logger.warn("[tasks-api] tasks:order invalid listId", {
          userId,
          rawListId: listId,
        });
      }
      return res.status(400).json({ error: "listId is required and must be a number" });
    }
    if (!Array.isArray(taskOrder) || taskOrder.some((v) => !Number.isFinite(Number(v)))) {
      if (logger && typeof logger.warn === "function") {
        logger.warn("[tasks-api] tasks:order invalid taskOrder", {
          userId,
          taskOrder,
        });
      }
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
      if (logger && typeof logger.warn === "function") {
        logger.warn("[tasks-api] tasks:order missing tasks", {
          userId,
          missing,
        });
      }
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
    if (logger && typeof logger.info === "function") {
      logger.info("[tasks-api] tasks:order", {
        userId,
        listId: parsedListId,
        taskOrder: ids,
      });
    }
  }));

  // API: Share a list with another user via email (invitation)
  router.post("/lists/:id/share", asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      if (logger && typeof logger.warn === "function") {
        logger.warn("[tasks-api] lists:share invalid id", {
          userId,
          rawId: req.params.id,
        });
      }
      return res.status(400).json({ error: "Invalid list id" });
    }

    const { email } = req.body || {};
    const trimmedEmail = (email || "").trim();
    // Very lightweight email validation
    const simpleEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
    if (!trimmedEmail || !simpleEmail.test(trimmedEmail)) {
      if (logger && typeof logger.warn === "function") {
        logger.warn("[tasks-api] lists:share invalid email", {
          userId,
          email,
        });
      }
      return res.status(400).json({ error: "A valid email address is required" });
    }

    const list = await prisma.taskList.findFirst({
      where: { id, userId },
    });
    if (!list) {
      if (logger && typeof logger.warn === "function") {
        logger.warn("[tasks-api] lists:share list not found", {
          userId,
          id,
        });
      }
      return res.status(404).json({ error: "List not found" });
    }

    // Create an invite record with a secure token
    const token = crypto.randomBytes(32).toString("hex");
    const inviterId = String(userId);

    const invite = await prisma.taskListShareInvite.create({
      data: {
        listId: id,
        inviterId,
        email: trimmedEmail,
        token,
        role: "editor",
        status: "pending",
      },
    });

    // Determine how to call mailer (support both function and { sendMail } forms)
    let sendMailFn = null;
    if (mailer && typeof mailer.sendMail === "function") {
      sendMailFn = mailer.sendMail.bind(mailer);
    } else if (typeof mailer === "function") {
      sendMailFn = mailer;
    }

    if (!sendMailFn) {
      if (logger && typeof logger.warn === "function") {
        logger.warn("[tasks-api] lists:share mailer not configured", {
          userId,
          listId: id,
        });
      }
      // 501 to indicate feature not available on this deployment
      return res.status(501).json({ error: "Email delivery is not configured" });
    }

    const subject = `Sovereign Tasks: list "${list.name}" shared with you`;
    const baseUrl = `${req.protocol}://${req.get("host") || ""}`;
    // URL used by the front-end to accept the invite (to be implemented by core Sovereign router)
    const listUrl = `${baseUrl}/tasks/share/accept?token=${encodeURIComponent(invite.token)}`;

    const text = [
      `A Sovereign user has shared a task list with you.`,
      ``,
      `List: ${list.name}`,
      ``,
      `You can open Sovereign Tasks to view this list:`,
      listUrl,
      ``,
      `If you believe this email was sent to you by mistake, you can safely ignore it.`,
    ].join("\n");

    const html = [
      `<p>A Sovereign user has shared a task list with you.</p>`,
      `<p><strong>List:</strong> ${list.name}</p>`,
      `<p>You can open Sovereign Tasks to view this list:</p>`,
      `<p><a href="${listUrl}">${listUrl}</a></p>`,
      `<p>If you believe this email was sent to you by mistake, you can safely ignore it.</p>`,
    ].join("");

    let mailResult;
    try {
      mailResult = await sendMailFn({
        to: trimmedEmail,
        subject,
        text,
        html,
        headers: {
          "X-Sovereign-Plugin": "tasks",
          "X-Sovereign-Tasks-List-Id": String(id),
        },
      });
    } catch (err) {
      if (logger && typeof logger.error === "function") {
        logger.error("[tasks-api] lists:share email send failed", {
          userId,
          listId: id,
          email: trimmedEmail,
          error: err && err.message,
        });
      }
      return res.status(500).json({ error: "Failed to send invitation email" });
    }

    if (logger && typeof logger.info === "function") {
      logger.info("[tasks-api] lists:share", {
        userId,
        listId: id,
        email: trimmedEmail,
        inviteId: invite.id,
        token: invite.token,
        mailStatus: mailResult && mailResult.status ? mailResult.status : "unknown",
      });
    }

    // 202 Accepted to reflect that the invite has been handed over to mailer
    return res.status(202).json({
      ok: true,
      email: trimmedEmail,
      inviteId: invite.id,
      token: invite.token,
      status: mailResult && mailResult.status ? mailResult.status : "unknown",
    });
  }));

  // API: Delete all completed tasks in a list
  router.delete("/lists/:id/completed", asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const listId = Number(req.params.id);
    if (!Number.isFinite(listId)) {
      if (logger && typeof logger.warn === "function") {
        logger.warn("[tasks-api] tasks:deleteCompleted invalid listId", {
          userId,
          rawListId: req.params.id,
        });
      }
      return res.status(400).json({ error: "Invalid list id" });
    }

    const list = await prisma.taskList.findFirst({
      where: { id: listId, userId },
    });
    if (!list) {
      if (logger && typeof logger.warn === "function") {
        logger.warn("[tasks-api] tasks:deleteCompleted list not found", {
          userId,
          listId,
        });
      }
      return res.status(404).json({ error: "List not found" });
    }

    const result = await prisma.task.deleteMany({
      where: { userId, listId, completed: true },
    });

    res.json({ ok: true, deletedCount: result.count });
    if (logger && typeof logger.info === "function") {
      logger.info("[tasks-api] tasks:deleteCompleted", {
        userId,
        listId,
        deletedCount: result.count,
      });
    }
  }));

  // Local error handler for this router (JSON responses)
  router.use((err, req, res, next) => {
    try {
      const userId = getUserId(req);
      if (logger && typeof logger.error === "function") {
        logger.error("[tasks-api] error handler", {
          path: req.path,
          method: req.method,
          userId: userId || null,
          error: err && err.message,
          stack: err && err.stack,
        });
      }
    } catch (e) {
      // ignore logging errors
    }

    if (res.headersSent) {
      return next(err);
    }

    res.status(500).json({ error: "Internal server error" });
  });

  return router;
};

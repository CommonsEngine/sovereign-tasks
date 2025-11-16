import express from "express";
// Helper to resolve current user id from request (adapt as needed to Sovereign auth)
function getUserId(req) {
  // Adjust this to match Sovereign's auth/user injection
  return (req.user && req.user.id) || req.userId || req.session?.userId || null;
}

function renderInviteError(res, statusCode, message, description) {
  return res.status(statusCode).render("error", {
    code: statusCode,
    message,
    description,
    nodeEnv: process.env.NODE_ENV,
  });
}

// ctx = { prisma, logger, etc. }

export default (ctx) => {
  const router = express.Router();

  const prisma = ctx.prisma;
  const logger = ctx.logger || console;
  const INVITE_MAX_AGE_DAYS = 30;

  function asyncHandler(fn) {
    return function (req, res, next) {
      Promise.resolve(fn(req, res, next)).catch(next);
    };
  }

  // API: Bootstrap tasks state
  router.get("/api/tasks/bootstrap", asyncHandler(async (req, res) => {
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
  router.get("/api/tasks/lists", asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const lists = await prisma.taskList.findMany({
      where: { userId },
      orderBy: [{ position: "asc" }, { id: "asc" }],
    });

    res.json(lists);
  }));

  // API: Create a new list
  router.post("/api/tasks/lists", asyncHandler(async (req, res) => {
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
  router.put("/api/tasks/lists/:id", asyncHandler(async (req, res) => {
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
  router.delete("/api/tasks/lists/:id", asyncHandler(async (req, res) => {
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
  router.put("/api/tasks/lists/order", asyncHandler(async (req, res) => {
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
  router.get("/api/tasks", asyncHandler(async (req, res) => {
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
  router.post("/api/tasks", asyncHandler(async (req, res) => {
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
  router.put("/api/tasks/:id", asyncHandler(async (req, res) => {
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
  router.delete("/api/tasks/:id", asyncHandler(async (req, res) => {
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
  router.put("/api/tasks/order", asyncHandler(async (req, res) => {
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
  router.delete("/api/tasks/lists/:id/completed", asyncHandler(async (req, res) => {
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

  // Web: Accept a shared list invitation
  router.get("/share/accept", asyncHandler(async (req, res) => {
    const token = (req.query && req.query.token) ? String(req.query.token) : "";
    if (!token) {
      return renderInviteError(
        res,
        400,
        "Missing invitation",
        "The invitation link is missing a token. Please use the link from your email again."
      );
    }

    const invite = await prisma.taskListShareInvite.findUnique({
      where: { token },
    });
    if (!invite) {
      return renderInviteError(
        res,
        404,
        "Invitation not found",
        "This invitation link is invalid or has already been used."
      );
    }

    if (invite.status === "revoked") {
      return renderInviteError(
        res,
        410,
        "Invitation revoked",
        "The sender revoked this invitation. Please ask for a new invite if you still need access."
      );
    }

    if (invite.status === "accepted") {
      return res.status(409).render("tasks/share-accept", {
        heading: "Invitation already accepted",
        message: "This invitation was already accepted. If you believe this is a mistake, request a new invite.",
        ctaHref: "/tasks",
        note: "If you don't see the list, open Tasks and refresh. This invite is already finished.",
      });
    }

    const userId = getUserId(req);
    if (!userId) {
      return renderInviteError(
        res,
        401,
        "Sign in required",
        "Please sign in to accept this shared list invitation, then open the link again."
      );
    }

    const sourceList = await prisma.taskList.findUnique({
      where: { id: invite.listId },
    });
    if (!sourceList) {
      // Update invite status to avoid dangling unusable tokens
      await prisma.taskListShareInvite.update({
        where: { id: invite.id },
        data: { status: "revoked" },
      });
      return renderInviteError(
        res,
        410,
        "List unavailable",
        "The list linked to this invitation no longer exists."
      );
    }

    // Enforce invite recipient email: require the signed-in user's email to match the invite target
    const currentEmail = (req.user && req.user.email ? String(req.user.email) : "").toLowerCase().trim();
    const invitedEmail = (invite.email || "").toLowerCase().trim();
    if (!currentEmail || currentEmail !== invitedEmail) {
      return renderInviteError(
        res,
        403,
        "Sign in with the invited email",
        `You are signed in as ${currentEmail || "another account"}, but this invitation was sent to ${invitedEmail || "a different email"}. Please switch accounts and try again.`
      );
    }

    // Enforce a maximum age on invites to avoid indefinite validity
    const createdAt = invite.createdAt ? new Date(invite.createdAt) : null;
    const now = new Date();
    if (createdAt && now.getTime() - createdAt.getTime() > INVITE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000) {
      await prisma.taskListShareInvite.update({
        where: { id: invite.id },
        data: { status: "revoked" },
      });
      return renderInviteError(
        res,
        410,
        "Invitation expired",
        "This invitation has expired. Please ask the sender to share the list again."
      );
    }

    const tasksToClone = await prisma.task.findMany({
      where: { listId: sourceList.id },
      orderBy: [{ position: "asc" }, { id: "asc" }],
    });

    const baseSlug = sourceList.slug || (sourceList.name || "list")
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "list";

    const createdList = await prisma.$transaction(async (tx) => {
      const listPosition = await tx.taskList.count({ where: { userId } });

      // Ensure slug uniqueness per user
      let uniqueSlug = baseSlug;
      let suffix = 2;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const conflict = await tx.taskList.findFirst({
          where: { userId, slug: uniqueSlug },
          select: { id: true },
        });
        if (!conflict) break;
        uniqueSlug = `${baseSlug}-${suffix}`;
        suffix += 1;
      }

      const clonedList = await tx.taskList.create({
        data: {
          userId,
          name: sourceList.name,
          slug: uniqueSlug,
          position: listPosition,
        },
      });

      if (tasksToClone.length > 0) {
        await tx.task.createMany({
          data: tasksToClone.map((task) => ({
            userId,
            listId: clonedList.id,
            title: task.title,
            description: task.description,
            dueDate: task.dueDate,
            recurringConfig: task.recurringConfig,
            completed: task.completed,
            starred: task.starred,
            position: task.position,
          })),
        });
      }

      await tx.taskListShareInvite.update({
        where: { id: invite.id },
        data: { status: "accepted" },
      });

      return clonedList;
    });

    if (logger && typeof logger.info === "function") {
      logger.info("[tasks-web] share:accept", {
        userId,
        inviteId: invite.id,
        sourceListId: invite.listId,
        clonedListId: createdList.id,
      });
    }

    return res.render("tasks/share-accept", {
      heading: "Invitation accepted",
      message: `The list "${createdList.name}" was added to your Tasks.`,
      ctaHref: "/tasks",
      listUrl: `/tasks?list=${encodeURIComponent(createdList.slug)}`,
      note: "You'll find this list in your Tasks board. If it doesn't appear immediately, refresh the page.",
    });
  }));

  // Main view
  router.get(["/", "/index", "/home"], (req, res) => {
    const userId = getUserId(req);
    return res.render("tasks/index", { tasksUserId: userId || "" });
  });

  return router;
};

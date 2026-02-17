import { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { eventBus, SSEEvent } from "../services/eventBus";
import { logger } from "../utils/logger";
import { prisma } from "../utils/db";

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET || process.env.SESSION_SECRET;

const connections = new Map<string, Set<Response>>();

/**
 * GET /api/events?token=<jwt>
 * SSE endpoint for real-time event streaming.
 * Auth via query param because EventSource API cannot set headers.
 */
router.get("/", async (req: Request, res: Response) => {
  const token = req.query.token as string | undefined;
  if (!token || !JWT_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  let userId: string;
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as {
      userId: string;
      tokenVersion?: number;
    };

    // Validate tokenVersion against database (same as authenticateRequest in middleware/auth.ts)
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, tokenVersion: true },
    });

    if (!user) {
      res.status(401).json({ error: "User not found" });
      return;
    }

    if (
      decoded.tokenVersion === undefined ||
      decoded.tokenVersion !== user.tokenVersion
    ) {
      res.status(401).json({ error: "Token has been revoked" });
      return;
    }

    userId = decoded.userId;
  } catch {
    res.status(401).json({ error: "Invalid token" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Flush headers immediately to establish SSE connection
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

  if (!connections.has(userId)) {
    connections.set(userId, new Set());
  }
  connections.get(userId)!.add(res);

  logger.debug(`[SSE] Client connected: userId=${userId}`);

  const safeSend = (data: string): boolean => {
    try {
      if (!res.destroyed && !res.writableEnded) {
        res.write(data);
        // Flush the response to ensure data is sent immediately
        if (typeof (res as any).flush === 'function') {
          (res as any).flush();
        }
        return true;
      }
    } catch {
      // Connection already closed
    }
    return false;
  };

  const listener = (event: SSEEvent) => {
    if (event.userId === userId) {
      // Flatten payload into top-level so frontend can read data.searchId etc.
      const { userId: _uid, payload, ...rest } = event;
      safeSend(`data: ${JSON.stringify({ ...rest, ...payload })}\n\n`);
    }
  };
  const unsubscribe = eventBus.subscribe(listener);

  const heartbeat = setInterval(() => {
    if (!safeSend(`: heartbeat\n\n`)) {
      clearInterval(heartbeat);
      unsubscribe();
    }
  }, 30_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    const userConns = connections.get(userId);
    if (userConns) {
      userConns.delete(res);
      if (userConns.size === 0) {
        connections.delete(userId);
      }
    }
    logger.debug(`[SSE] Client disconnected: userId=${userId}`);
  });
});

export default router;

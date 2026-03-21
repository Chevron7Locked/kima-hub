import { Router, Request, Response } from "express";
import { eventBus, SSEEvent } from "../services/eventBus";
import { logger } from "../utils/logger";
import { redisClient } from "../utils/redis";

const router = Router();

const connections = new Map<string, Set<Response>>();

/**
 * GET /api/events?ticket=<uuid>
 * SSE endpoint for real-time event streaming.
 * Auth via short-lived, one-time-use ticket obtained from POST /api/events/ticket.
 */
router.get("/", async (req: Request, res: Response) => {
  const ticket = req.query.ticket as string | undefined;
  if (!ticket) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const userId = await redisClient.getdel(`sse:ticket:${ticket}`);
  if (!userId) {
    res.status(401).json({ error: "Invalid or expired ticket" });
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
    if (event.userId === userId || event.userId === "*") {
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

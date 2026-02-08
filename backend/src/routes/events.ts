import { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { eventBus, SSEEvent } from "../services/eventBus";
import { logger } from "../utils/logger";

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET || process.env.SESSION_SECRET;

const connections = new Map<string, Set<Response>>();

/**
 * GET /api/events?token=<jwt>
 * SSE endpoint for real-time event streaming.
 * Auth via query param because EventSource API cannot set headers.
 */
router.get("/", (req: Request, res: Response) => {
    const token = req.query.token as string | undefined;
    if (!token || !JWT_SECRET) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }

    let userId: string;
    try {
        const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };
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

    res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

    if (!connections.has(userId)) {
        connections.set(userId, new Set());
    }
    connections.get(userId)!.add(res);

    logger.debug(`[SSE] Client connected: userId=${userId}`);

    const listener = (event: SSEEvent) => {
        if (event.userId === userId) {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
    };
    const unsubscribe = eventBus.subscribe(listener);

    const heartbeat = setInterval(() => {
        res.write(`: heartbeat\n\n`);
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

export function getSSEConnectionCount(): number {
    let count = 0;
    for (const set of connections.values()) {
        count += set.size;
    }
    return count;
}

export default router;

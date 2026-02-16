# Soulseek + SSE Notification Upgrade - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace slsk-client with vendored soulseek-ts (extended with queue management + connection resilience), replace HTTP polling with SSE for real-time notifications and download progress.

**Architecture:** Vendor soulseek-ts into `backend/src/lib/soulseek/`, add EventBus singleton for typed event dispatch, SSE endpoint for real-time frontend push, rewrite soulseek service wrapper. Delete all polling infrastructure.

**Tech Stack:** soulseek-ts (ISC, vendored), native EventEmitter, native SSE (EventSource), React Query cache invalidation, typed-emitter

**Core Principle:** No parallel systems. Replace, don't layer. Delete dead code immediately.

**Design doc:** `docs/plans/2026-02-08-soulseek-sse-upgrade-design.md`

---

## Task 1: Create EventBus singleton

**Files:**
- Create: `backend/src/services/eventBus.ts`

**Context:** This is the backbone for SSE. Every backend service emits events through this bus, and the SSE endpoint subscribes to it. Simple typed EventEmitter - no Redis, no external deps.

**Step 1: Create the EventBus**

Create `backend/src/services/eventBus.ts`:

```typescript
import { EventEmitter } from "events";

export type SSEEventType =
    | "notification"
    | "notification:cleared"
    | "download:progress"
    | "download:queued"
    | "download:complete"
    | "download:failed";

export interface SSEEvent {
    type: SSEEventType;
    userId: string;
    payload: Record<string, unknown>;
}

class EventBus {
    private emitter = new EventEmitter();

    constructor() {
        // Allow many SSE connections (one per browser tab per user)
        this.emitter.setMaxListeners(100);
    }

    emit(event: SSEEvent): void {
        this.emitter.emit("sse", event);
    }

    subscribe(listener: (event: SSEEvent) => void): () => void {
        this.emitter.on("sse", listener);
        return () => this.emitter.off("sse", listener);
    }
}

export const eventBus = new EventBus();
```

**Step 2: Verify it compiles**

Run: `cd /run/media/chevron7/Storage/Projects/kima/backend && npx tsc --noEmit src/services/eventBus.ts`

**Step 3: Commit**

```bash
git add backend/src/services/eventBus.ts
git commit -m "feat: add EventBus singleton for SSE event dispatch"
```

---

## Task 2: Create SSE endpoint

**Files:**
- Create: `backend/src/routes/events.ts`
- Modify: `backend/src/index.ts` (add route registration at ~line 165)

**Context:** Single SSE endpoint at `GET /api/events?token=<jwt>`. EventSource API cannot set Authorization headers, so JWT is passed as query param. Maintains a `Map<string, Set<Response>>` for multi-tab support. Heartbeat every 30s. Cleanup on disconnect.

**Step 1: Create the SSE route**

Create `backend/src/routes/events.ts`:

```typescript
import { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { logger } from "../utils/logger";
import { eventBus, SSEEvent } from "../services/eventBus";

const router = Router();

// Active SSE connections: userId -> Set of Response objects
const connections = new Map<string, Set<Response>>();

/**
 * GET /events?token=<jwt>
 * SSE endpoint for real-time notifications and download progress.
 * Auth via query param because EventSource API cannot set headers.
 */
router.get("/", (req: Request, res: Response) => {
    const token = req.query.token as string;
    if (!token) {
        return res.status(401).json({ error: "Token required" });
    }

    // Verify JWT
    let userId: string;
    try {
        const secret = process.env.JWT_SECRET || process.env.SESSION_SECRET!;
        const decoded = jwt.verify(token, secret) as { userId: string };
        userId = decoded.userId;
    } catch {
        return res.status(401).json({ error: "Invalid token" });
    }

    // Set SSE headers
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no", // Disable nginx buffering
    });

    // Send initial connection event
    res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

    // Register connection
    if (!connections.has(userId)) {
        connections.set(userId, new Set());
    }
    connections.get(userId)!.add(res);

    logger.debug(`[SSE] Client connected: ${userId} (${connections.get(userId)!.size} tabs)`);

    // Heartbeat to keep connection alive
    const heartbeat = setInterval(() => {
        res.write(": heartbeat\n\n");
    }, 30000);

    // Subscribe to EventBus
    const unsubscribe = eventBus.subscribe((event: SSEEvent) => {
        if (event.userId === userId) {
            res.write(`data: ${JSON.stringify({ type: event.type, ...event.payload })}\n\n`);
        }
    });

    // Cleanup on disconnect
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
        logger.debug(`[SSE] Client disconnected: ${userId}`);
    });
});

/** Get count of active SSE connections (for health checks) */
export function getSSEConnectionCount(): number {
    let count = 0;
    for (const conns of connections.values()) {
        count += conns.size;
    }
    return count;
}

export default router;
```

**Step 2: Register the route in index.ts**

In `backend/src/index.ts`, add import at top with the other route imports (~line 37):

```typescript
import eventsRoutes from "./routes/events";
```

Add route registration after the system routes line (~line 165):

```typescript
app.use("/api/events", eventsRoutes); // SSE - no rate limit, long-lived connections
```

**Step 3: Verify compilation**

Run: `cd /run/media/chevron7/Storage/Projects/kima/backend && npx tsc --noEmit`

**Step 4: Commit**

```bash
git add backend/src/routes/events.ts backend/src/index.ts
git commit -m "feat: add SSE endpoint for real-time event streaming"
```

---

## Task 3: Wire NotificationService into EventBus

**Files:**
- Modify: `backend/src/services/notificationService.ts`

**Context:** After every `create()` call writes to DB, emit a `"notification"` event through the EventBus. After `clearAll()`, emit `"notification:cleared"`. This replaces the 30s polling delay with instant push. Also fix the `new PrismaClient()` - use the shared import from `../utils/db`.

**Step 1: Modify notificationService.ts**

At the top, add imports:
```typescript
import { eventBus } from "./eventBus";
```

Replace `const prisma = new PrismaClient();` (line 4) with:
```typescript
import { prisma } from "../utils/db";
```

Remove the `import { PrismaClient } from "@prisma/client";` import (line 1).

In the `create()` method, after the `prisma.notification.create()` call (after line 37, before the logger.debug), add:

```typescript
        // Push to connected clients via SSE
        eventBus.emit({
            type: "notification",
            userId,
            payload: {
                id: notification.id,
                notificationType: type,
                title,
                message,
            },
        });
```

In the `clearAll()` method (after line 110), add:

```typescript
        eventBus.emit({
            type: "notification:cleared",
            userId,
            payload: {},
        });
```

In the `clear()` method (after line 100), add:

```typescript
        eventBus.emit({
            type: "notification:cleared",
            userId,
            payload: { id },
        });
```

**Step 2: Verify compilation**

Run: `cd /run/media/chevron7/Storage/Projects/kima/backend && npx tsc --noEmit`

**Step 3: Commit**

```bash
git add backend/src/services/notificationService.ts
git commit -m "feat: emit SSE events from NotificationService on create/clear"
```

---

## Task 4: Wire download events into EventBus

**Files:**
- Modify: `backend/src/services/simpleDownloadManager.ts`

**Context:** The simpleDownloadManager already calls `notificationService.notifyDownloadComplete/Failed()` at lines ~786 and ~1230. Those now auto-emit via Task 3. But we also need to emit `download:complete` and `download:failed` events for the active downloads query invalidation. Find the download completion/failure points and add EventBus emits.

**Step 1: Add EventBus import**

At the top of `simpleDownloadManager.ts`, add:
```typescript
import { eventBus } from "./eventBus";
```

**Step 2: Emit on download completion**

Find where download jobs are marked `completed` (search for `status: "completed"` in the Prisma update calls). After each completion update, add:

```typescript
eventBus.emit({
    type: "download:complete",
    userId: job.userId,
    payload: { jobId: job.id, subject: job.subject },
});
```

**Step 3: Emit on download failure**

Find where download jobs are marked `failed` or `exhausted`. After each failure update, add:

```typescript
eventBus.emit({
    type: "download:failed",
    userId: job.userId,
    payload: { jobId: job.id, subject: job.subject, error: job.error },
});
```

**Step 4: Clean up dead slskd references**

Search for "slskd" or "SLSKD" comments in simpleDownloadManager.ts and update/remove them. Specifically:
- Line ~1361-1363: Update comment about Soulseek jobs to reference the new soulseek-ts client, or remove if the logic is no longer relevant.

**Step 5: Verify compilation**

Run: `cd /run/media/chevron7/Storage/Projects/kima/backend && npx tsc --noEmit`

**Step 6: Commit**

```bash
git add backend/src/services/simpleDownloadManager.ts
git commit -m "feat: emit SSE download events from simpleDownloadManager"
```

---

## Task 5: Create frontend SSE hook and DownloadProgress context

**Files:**
- Create: `frontend/hooks/useEventSource.ts`
- Create: `frontend/lib/download-progress-context.tsx`

**Context:** The SSE hook connects to `/api/events?token=<jwt>` at the app level. On each event, it invalidates the relevant React Query cache. Download progress events (high frequency) are stored in a dedicated context (not React Query) to avoid re-render storms.

**Step 1: Create useEventSource hook**

Create `frontend/hooks/useEventSource.ts`:

```typescript
"use client";

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { useDownloadProgress } from "@/lib/download-progress-context";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3006/api";

export function useEventSource() {
    const { token, isAuthenticated } = useAuth();
    const queryClient = useQueryClient();
    const { updateProgress, clearProgress } = useDownloadProgress();
    const eventSourceRef = useRef<EventSource | null>(null);
    const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    useEffect(() => {
        if (!isAuthenticated || !token) return;

        let mounted = true;

        const connect = () => {
            if (!mounted) return;

            const es = new EventSource(`${API_BASE}/events?token=${token}`);
            eventSourceRef.current = es;

            es.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);

                    switch (data.type) {
                        case "notification":
                        case "notification:cleared":
                            queryClient.invalidateQueries({ queryKey: ["notifications"] });
                            // Also refresh playlists if it's a playlist notification
                            if (data.notificationType === "playlist_ready" || data.notificationType === "import_complete") {
                                queryClient.invalidateQueries({ queryKey: ["playlists"] });
                            }
                            break;
                        case "download:progress":
                            updateProgress(data.jobId, {
                                bytesReceived: data.bytesReceived,
                                totalBytes: data.totalBytes,
                                filename: data.filename,
                            });
                            break;
                        case "download:queued":
                            updateProgress(data.jobId, {
                                queuePosition: data.position,
                                username: data.username,
                                filename: data.filename,
                            });
                            break;
                        case "download:complete":
                            clearProgress(data.jobId);
                            queryClient.invalidateQueries({ queryKey: ["active-downloads"] });
                            queryClient.invalidateQueries({ queryKey: ["download-history"] });
                            queryClient.invalidateQueries({ queryKey: ["notifications"] });
                            break;
                        case "download:failed":
                            clearProgress(data.jobId);
                            queryClient.invalidateQueries({ queryKey: ["active-downloads"] });
                            queryClient.invalidateQueries({ queryKey: ["download-history"] });
                            queryClient.invalidateQueries({ queryKey: ["notifications"] });
                            break;
                        case "connected":
                            break; // Initial connection acknowledgement
                    }
                } catch {
                    // Ignore parse errors (heartbeat comments, etc.)
                }
            };

            es.onerror = () => {
                es.close();
                eventSourceRef.current = null;
                // Reconnect after 5 seconds
                if (mounted) {
                    reconnectTimeoutRef.current = setTimeout(connect, 5000);
                }
            };
        };

        connect();

        return () => {
            mounted = false;
            if (reconnectTimeoutRef.current) {
                clearTimeout(reconnectTimeoutRef.current);
            }
            if (eventSourceRef.current) {
                eventSourceRef.current.close();
                eventSourceRef.current = null;
            }
        };
    }, [isAuthenticated, token, queryClient, updateProgress, clearProgress]);
}
```

**Step 2: Create DownloadProgress context**

Create `frontend/lib/download-progress-context.tsx`:

```typescript
"use client";

import { createContext, useContext, useCallback, useRef, useSyncExternalStore, ReactNode } from "react";

export interface DownloadProgressData {
    bytesReceived?: number;
    totalBytes?: number;
    queuePosition?: number;
    username?: string;
    filename?: string;
}

interface DownloadProgressContextType {
    getProgress: (jobId: string) => DownloadProgressData | undefined;
    updateProgress: (jobId: string, data: DownloadProgressData) => void;
    clearProgress: (jobId: string) => void;
    subscribe: (callback: () => void) => () => void;
}

const DownloadProgressContext = createContext<DownloadProgressContextType | undefined>(undefined);

export function DownloadProgressProvider({ children }: { children: ReactNode }) {
    const progressRef = useRef<Map<string, DownloadProgressData>>(new Map());
    const listenersRef = useRef<Set<() => void>>(new Set());

    const notify = useCallback(() => {
        for (const listener of listenersRef.current) {
            listener();
        }
    }, []);

    const subscribe = useCallback((callback: () => void) => {
        listenersRef.current.add(callback);
        return () => listenersRef.current.delete(callback);
    }, []);

    const getProgress = useCallback((jobId: string) => {
        return progressRef.current.get(jobId);
    }, []);

    const updateProgress = useCallback((jobId: string, data: DownloadProgressData) => {
        const existing = progressRef.current.get(jobId);
        progressRef.current.set(jobId, { ...existing, ...data });
        notify();
    }, [notify]);

    const clearProgress = useCallback((jobId: string) => {
        progressRef.current.delete(jobId);
        notify();
    }, [notify]);

    return (
        <DownloadProgressContext.Provider value={{ getProgress, updateProgress, clearProgress, subscribe }}>
            {children}
        </DownloadProgressContext.Provider>
    );
}

export function useDownloadProgress() {
    const context = useContext(DownloadProgressContext);
    if (!context) {
        throw new Error("useDownloadProgress must be used within DownloadProgressProvider");
    }
    return context;
}

/** Hook to subscribe to progress for a specific job */
export function useJobProgress(jobId: string): DownloadProgressData | undefined {
    const { getProgress, subscribe } = useDownloadProgress();
    return useSyncExternalStore(
        subscribe,
        () => getProgress(jobId),
        () => undefined
    );
}
```

**Step 3: Verify frontend compiles**

Run: `cd /run/media/chevron7/Storage/Projects/kima/frontend && npx next lint`

**Step 4: Commit**

```bash
git add frontend/hooks/useEventSource.ts frontend/lib/download-progress-context.tsx
git commit -m "feat: add SSE hook and download progress context"
```

---

## Task 6: Mount SSE hook and progress provider in app layout

**Files:**
- Modify: `frontend/app/layout.tsx`
- Modify: `frontend/lib/download-context.tsx`

**Context:** The `DownloadProgressProvider` must wrap the app so all components can access progress data. The `useEventSource` hook must be called inside a component that has access to both `AuthProvider` and `QueryProvider`. The existing `DownloadProvider` already sits inside both - mount the hook there. Wrap `DownloadProvider` with `DownloadProgressProvider` in layout.tsx.

**Step 1: Add DownloadProgressProvider to layout.tsx**

In `frontend/app/layout.tsx`, add import:
```typescript
import { DownloadProgressProvider } from "@/lib/download-progress-context";
```

Wrap `DownloadProvider` with `DownloadProgressProvider` (around line 65):
```tsx
<DownloadProgressProvider>
    <DownloadProvider>
        ...
    </DownloadProvider>
</DownloadProgressProvider>
```

**Step 2: Mount useEventSource in DownloadProvider**

In `frontend/lib/download-context.tsx`, add import:
```typescript
import { useEventSource } from "@/hooks/useEventSource";
```

Inside the `DownloadProvider` component, call the hook (after the `useAuth` and `useDownloadStatus` calls):
```typescript
useEventSource();
```

**Step 3: Verify frontend compiles**

Run: `cd /run/media/chevron7/Storage/Projects/kima/frontend && npx next lint`

**Step 4: Commit**

```bash
git add frontend/app/layout.tsx frontend/lib/download-context.tsx
git commit -m "feat: mount SSE hook and progress provider in app layout"
```

---

## Task 7: Remove all polling infrastructure

**Files:**
- Modify: `frontend/hooks/useNotifications.ts`
- Modify: `frontend/components/activity/NotificationsTab.tsx`
- Modify: `frontend/components/layout/Sidebar.tsx`
- Delete: `frontend/hooks/useDownloadStatus.ts`
- Modify: `frontend/lib/download-context.tsx`

**Context:** SSE is now wired up. Delete all polling intervals, CustomEvent dispatchers, and CustomEvent listeners. Replace `useDownloadStatus` with `useActiveDownloads` from useNotifications.ts (which already exists and will also lose its polling). The `DownloadProvider` needs to stop using `useDownloadStatus` entirely.

**Step 1: Remove polling from useNotifications.ts**

In `useNotifications()` (line 47): Remove `refetchInterval: 30000,`

In `useDownloadHistory()` (line 160): Remove `refetchInterval: 30000,`

In `useActiveDownloads()` (lines 228-231): Remove the entire `refetchInterval` block (the adaptive polling function).

**Step 2: Remove CustomEvent dispatch from NotificationsTab.tsx**

Delete the entire `useEffect` block at lines 46-65 that dispatches `"playlist-created"` events. SSE `notification` events now trigger React Query invalidation directly, and the SSE hook invalidates `["playlists"]` for playlist-related notifications.

Also delete the `previousNotificationIds` ref (line 30) since it's only used by that useEffect.

Remove the `useEffect` and `useRef` imports if no longer needed (check remaining usage).

Remove the `refetchInterval: 30000` from the useQuery at line 42.

**Step 3: Remove CustomEvent listeners from Sidebar.tsx**

Delete the three `window.addEventListener` calls at lines 103-105 and the matching `window.removeEventListener` calls at lines 111-113. The `handlePlaylistEvent` function (lines 93-101) is now dead code - delete it.

Replace the playlist loading with React Query so SSE invalidation works:

```typescript
import { useQuery } from "@tanstack/react-query";
```

Replace the manual `loadPlaylists`/`useState` pattern with:
```typescript
const { data: playlists = [] } = useQuery({
    queryKey: ["playlists"],
    queryFn: () => api.getPlaylists(),
    enabled: isAuthenticated,
});
```

Delete the `playlists` useState, `isLoadingPlaylists` useState, `hasLoadedPlaylists` useRef, and the entire useEffect that was loading playlists + listening for events (lines 69-115).

**Step 4: Delete useDownloadStatus.ts**

Delete `frontend/hooks/useDownloadStatus.ts` entirely. This file is being fully replaced by SSE-driven React Query invalidation.

**Step 5: Refactor DownloadProvider**

In `frontend/lib/download-context.tsx`:

Remove the import of `useDownloadStatus` and `DownloadJob` from `@/hooks/useDownloadStatus`.

Import `useActiveDownloads` from `@/hooks/useNotifications` and the `DownloadHistoryItem` type:
```typescript
import { useActiveDownloads, DownloadHistoryItem } from "@/hooks/useNotifications";
```

Replace `const downloadStatus = useDownloadStatus(15000, isAuthenticated);` with:
```typescript
const { downloads: activeDownloads } = useActiveDownloads();
```

Update `DownloadContextType` to use `DownloadHistoryItem` instead of `DownloadJob`. Update the `downloadStatus` shape to derive from `activeDownloads`:

```typescript
const downloadStatus = useMemo(() => ({
    activeDownloads: activeDownloads.filter(d => d.status === "pending" || d.status === "processing"),
    recentDownloads: [],
    hasActiveDownloads: activeDownloads.some(d => d.status === "pending" || d.status === "processing"),
    failedDownloads: [],
}), [activeDownloads]);
```

Remove the `prevActiveDownloads`/`prevRecentDownloads`/`prevFailedDownloads` state and the render-time adjustment block (lines 55-85) - this was compensating for polling latency which SSE eliminates.

Remove the `DownloadJob` reference from `DownloadContextType` and replace with `DownloadHistoryItem`.

**Step 6: Remove dead CustomEvent from Sidebar.tsx handleSync**

In `Sidebar.tsx` line 58: `window.dispatchEvent(new CustomEvent("notifications-changed"));` - delete this line. The scan completion will create a notification via the backend, which SSE will push instantly.

**Step 7: Verify frontend compiles**

Run: `cd /run/media/chevron7/Storage/Projects/kima/frontend && npx next lint`

**Step 8: Commit**

```bash
git add -u frontend/
git commit -m "refactor: replace all polling with SSE-driven cache invalidation

Remove refetchInterval from all notification/download hooks.
Delete useDownloadStatus.ts (replaced by SSE + useActiveDownloads).
Remove CustomEvent dispatchers and listeners from NotificationsTab
and Sidebar. Sidebar playlists now use React Query (SSE invalidated)."
```

---

## Task 8: Vendor soulseek-ts source

**Files:**
- Create: `backend/src/lib/soulseek/` (entire directory tree)

**Context:** Copy the soulseek-ts source (ISC license) into the project. The library has 18 TypeScript files across `src/`, `src/messages/`, `src/messages/from/`, `src/messages/to/`, `src/utils/`. We vendor it as-is first, then extend in subsequent tasks. The library depends on `typed-emitter` (already has TS types) and `zlib` (Node.js built-in, npm package just re-exports it - not needed).

**Step 1: Create directory structure**

```bash
mkdir -p backend/src/lib/soulseek/messages/from
mkdir -p backend/src/lib/soulseek/messages/to
mkdir -p backend/src/lib/soulseek/utils
```

**Step 2: Copy all source files**

Create each file exactly as shown in the soulseek-ts source. Key files:

- `backend/src/lib/soulseek/index.ts` - re-exports SlskClient and Messages
- `backend/src/lib/soulseek/common.ts` - Address type
- `backend/src/lib/soulseek/client.ts` - Main client (17KB, the orchestrator)
- `backend/src/lib/soulseek/downloads.ts` - Download state types and helpers
- `backend/src/lib/soulseek/listen.ts` - TCP listener for incoming peer connections
- `backend/src/lib/soulseek/peer.ts` - Peer connection wrapper
- `backend/src/lib/soulseek/server.ts` - Server connection wrapper
- `backend/src/lib/soulseek/utils/types.ts` - DistributiveOmit utility
- `backend/src/lib/soulseek/messages/index.ts` - Message type re-exports
- `backend/src/lib/soulseek/messages/common.ts` - ConnectionType, UserStatus, TransferDirection, FileAttribute enums
- `backend/src/lib/soulseek/messages/message-builder.ts` - Binary message serialization
- `backend/src/lib/soulseek/messages/message-parser.ts` - Binary message deserialization
- `backend/src/lib/soulseek/messages/message-stream.ts` - TCP framing (length-prefixed messages)
- `backend/src/lib/soulseek/messages/from/index.ts` - From message re-exports
- `backend/src/lib/soulseek/messages/from/peer-init.ts` - PierceFirewall/PeerInit parsers
- `backend/src/lib/soulseek/messages/from/peer.ts` - Peer message parsers (search response, transfer, queue)
- `backend/src/lib/soulseek/messages/from/server.ts` - Server message parsers (login, peer address, etc.)
- `backend/src/lib/soulseek/messages/to/index.ts` - To message re-exports
- `backend/src/lib/soulseek/messages/to/peer.ts` - Peer message builders
- `backend/src/lib/soulseek/messages/to/server.ts` - Server message builders

**Important changes from upstream:**
- Replace `import zlib from 'zlib'` with `import * as zlib from 'zlib'` in `messages/from/peer.ts` (zlib is a Node.js built-in, no npm dep needed)
- Replace all `console.error` calls with imports from `../../utils/logger` (or just leave as console.error for the vendored library layer - the service wrapper will handle logging)

**Step 3: Add typed-emitter dependency**

```bash
cd /run/media/chevron7/Storage/Projects/kima/backend && npm install typed-emitter
```

**Step 4: Remove slsk-client dependency**

```bash
cd /run/media/chevron7/Storage/Projects/kima/backend && npm uninstall slsk-client
```

Also delete `backend/src/types/slsk-client.d.ts` (the type declarations for the old library).

**Step 5: Verify compilation**

Run: `cd /run/media/chevron7/Storage/Projects/kima/backend && npx tsc --noEmit`

Fix any import path issues. The vendored code uses relative imports internally so it should work as-is.

**Step 6: Commit**

```bash
git add backend/src/lib/soulseek/ backend/package.json backend/package-lock.json
git rm backend/src/types/slsk-client.d.ts
git commit -m "feat: vendor soulseek-ts library (ISC license)

Replace slsk-client npm dep with vendored soulseek-ts source.
TypeScript, Promise-based, with download progress events,
queue position tracking, and NAT traversal via ConnectToPeer."
```

---

## Task 9: Add UploadDenied peer message handler

**Files:**
- Modify: `backend/src/lib/soulseek/messages/from/peer.ts`

**Context:** soulseek-ts already handles codes 4 (SharedFileListRequest), 9 (FileSearchResponse), 40 (TransferRequest), 41 (TransferResponse), 44 (PlaceInQueueResponse), 46 (UploadFailed). It's missing code 50 (UploadDenied) which is sent when a peer rejects our download with a reason (e.g., "Banned", "File not shared", "Too many files"). Add the parser.

**Step 1: Add UploadDenied type and parser**

In `backend/src/lib/soulseek/messages/from/peer.ts`, add to the types:

```typescript
export type UploadDenied = {
    kind: 'uploadDenied'
    filename: string
    reason: string
}
```

Add to `fromPeerMessage`:

```typescript
uploadDenied: (msg: MessageParser): UploadDenied => {
    const filename = msg.str()
    const reason = msg.str()
    return { kind: 'uploadDenied', filename, reason }
},
```

Add to the switch in `fromPeerMessageParser`:

```typescript
case 50:
    return fromPeerMessage.uploadDenied(msg)
```

Update the `FromPeerMessage` type union to include the new type.

**Step 2: Handle UploadDenied in client.ts**

In `backend/src/lib/soulseek/client.ts`, in the `peerMessages.on('message')` handler, add a case for `uploadDenied`:

```typescript
case 'uploadDenied': {
    const existingDownloadIndex = this.downloads.findIndex(
        (d) => d.username === peer.username && d.filename === msg.filename
    )

    if (existingDownloadIndex !== -1) {
        const download = this.downloads[existingDownloadIndex]
        download.stream.destroy(new Error(`Upload denied: ${msg.reason}`))
        download.events.emit('status', 'denied' as any, {
            ...makeDownloadStatusData(download),
            reason: msg.reason,
        } as any)
        this.downloads = this.downloads.filter((_, i) => i !== existingDownloadIndex)
    }
    break
}
```

**Step 3: Verify compilation**

Run: `cd /run/media/chevron7/Storage/Projects/kima/backend && npx tsc --noEmit`

**Step 4: Commit**

```bash
git add backend/src/lib/soulseek/
git commit -m "feat: add UploadDenied (code 50) peer message handler"
```

---

## Task 10: Add connection resilience (exponential backoff)

**Files:**
- Modify: `backend/src/lib/soulseek/client.ts`

**Context:** The current soulseek-ts client has no reconnection logic. The old soulseek.ts had a fixed 30s/5s cooldown. Replace with exponential backoff: 1s, 2s, 4s, 8s, 16s, max 60s. Reset on successful login.

**Step 1: Add reconnection logic to SlskClient**

Add fields to `SlskClient`:

```typescript
private reconnectAttempts = 0
private reconnectTimeout: NodeJS.Timeout | null = null
private autoReconnect = true
private credentials: { username: string; password: string } | null = null
```

Add method:

```typescript
async loginAndRemember(username: string, password: string, timeout?: number) {
    this.credentials = { username, password }
    await this.login(username, password, timeout)
    this.reconnectAttempts = 0 // Reset on success

    // Listen for server disconnect
    this.server.conn.on('close', () => {
        if (this.autoReconnect && this.credentials) {
            this.scheduleReconnect()
        }
    })
}

private scheduleReconnect() {
    if (this.reconnectTimeout) return

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 60000)
    this.reconnectAttempts++

    this.reconnectTimeout = setTimeout(async () => {
        this.reconnectTimeout = null
        if (!this.credentials || !this.autoReconnect) return

        try {
            // Recreate server connection
            this.server.destroy()
            this.server = new SlskServer(this.server.conn.remoteAddress
                ? { host: this.server.conn.remoteAddress, port: this.server.conn.remotePort! }
                : { host: 'server.slsknet.org', port: 2242 })
            // Re-wire server message handler (same as constructor)
            this.wireServerHandlers()
            await this.login(this.credentials.username, this.credentials.password)
            this.reconnectAttempts = 0
        } catch {
            this.scheduleReconnect()
        }
    }, delay)
}
```

Override `destroy()` to disable auto-reconnect:

```typescript
destroy() {
    this.autoReconnect = false
    if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout)
    }
    this.server.destroy()
    this.listen.destroy()
    for (const peer of this.peers.values()) {
        peer.destroy()
    }
    for (const conn of this.fileTransferConnections) {
        conn.destroy()
    }
}
```

**Note:** You'll need to extract the server message handler setup from the constructor into a `wireServerHandlers()` method so it can be re-applied after reconnection.

**Step 2: Verify compilation**

Run: `cd /run/media/chevron7/Storage/Projects/kima/backend && npx tsc --noEmit`

**Step 3: Commit**

```bash
git add backend/src/lib/soulseek/client.ts
git commit -m "feat: add exponential backoff reconnection to soulseek client"
```

---

## Task 11: Rewrite soulseek service wrapper

**Files:**
- Rewrite: `backend/src/services/soulseek.ts` (delete 1280 lines, write ~400 lines)

**Context:** The current `soulseek.ts` wraps `slsk-client` with Promise wrappers, circuit breaker, reconnection logic, and search ranking. The new version wraps the vendored `soulseek-ts` client. Key differences: soulseek-ts is already Promise-based and has progress events. We keep the same public API surface so `acquisitionService.ts` and `routes/soulseek.ts` need minimal changes. We keep the circuit breaker and search ranking logic (those are application-level, not protocol-level). We integrate with EventBus for progress events.

**Step 1: Delete current soulseek.ts and rewrite**

The new service must export:
- `soulseekService` singleton
- `SearchResult` interface (for routes/soulseek.ts compatibility)

The service must:
1. Read credentials from DB (`getSystemSettings()`) on `connect()`
2. Use `SlskClient` from the vendored library
3. Keep the circuit breaker (per-user failure tracking with 5-minute expiry)
4. Keep the search ranking logic (artist match, title match, format preference, bitrate, slots)
5. Emit `download:progress`, `download:queued`, `download:complete`, `download:failed` to EventBus
6. Expose: `connect()`, `disconnect()`, `isAvailable()`, `getStatus()`, `searchTrack()`, `searchAndDownload()`, `searchAndDownloadBatch()`

The `searchTrack()` method should use the client's `search()` with `onResult` callback for streaming results, rank them with the existing scoring algorithm, and return the same shape.

The `searchAndDownload()` method should use the client's `download()` which returns a download object with an event emitter. Wire the events:
- `download.events.on('progress', ...)` → `eventBus.emit({ type: "download:progress", ... })`
- `download.events.on('status', 'queued', ...)` → `eventBus.emit({ type: "download:queued", ... })`
- `download.events.on('complete', ...)` → write stream to file, `eventBus.emit({ type: "download:complete", ... })`
- `download.events.on('error', ...)` → `eventBus.emit({ type: "download:failed", ... })`

The `searchAndDownloadBatch()` method should work similarly to the old one: parallel searches, then queued downloads with PQueue concurrency control.

**Step 2: Verify compilation**

Run: `cd /run/media/chevron7/Storage/Projects/kima/backend && npx tsc --noEmit`

**Step 3: Commit**

```bash
git add backend/src/services/soulseek.ts
git commit -m "feat: rewrite soulseek service using vendored soulseek-ts

Replace slsk-client wrapper with soulseek-ts integration.
Same public API surface (searchTrack, searchAndDownload,
searchAndDownloadBatch). Adds EventBus integration for
real-time progress, queue position, and completion events.
Keeps circuit breaker and search ranking logic."
```

---

## Task 12: Update systemSettings test endpoint

**Files:**
- Modify: `backend/src/routes/systemSettings.ts` (~line 628-660)

**Context:** The test-soulseek endpoint at line 628 currently does `const slsk = require("slsk-client")` and tests connection directly. Replace with the new soulseek service.

**Step 1: Update the test endpoint**

Find the test-soulseek handler (~line 628). Replace the `require("slsk-client")` approach with:

```typescript
import { soulseekService } from "../services/soulseek";

// In the handler:
try {
    await soulseekService.connect();
    const status = await soulseekService.getStatus();
    res.json({
        success: true,
        version: "soulseek-ts",
        connected: status.connected,
    });
} catch (error: any) {
    res.json({
        success: false,
        error: error.message,
    });
}
```

Also update the comment at line 53 referencing "slsk-client" to say "soulseek-ts (vendored)".

Also update the comment at line 628 referencing "slsk-client".

**Step 2: Verify compilation**

Run: `cd /run/media/chevron7/Storage/Projects/kima/backend && npx tsc --noEmit`

**Step 3: Commit**

```bash
git add backend/src/routes/systemSettings.ts
git commit -m "refactor: update soulseek test endpoint to use new client"
```

---

## Task 13: Clean up all dead slskd references

**Files:**
- Modify: `backend/src/routes/library.ts` (lines 139-150)
- Modify: `backend/src/utils/playlistLogger.ts` (line 96)
- Modify: `backend/src/utils/envWriter.ts` (line 59)
- Modify: `backend/src/workers/organizeSingles.ts` (comments throughout)
- Modify: `backend/src/routes/onboarding.ts` (line 320 comment)
- Modify: `backend/src/routes/soulseek.ts` (line 4 comment)
- Delete: `docs/plans/2026-02-07-slskd-integration.md`
- Delete: `docs/plans/2026-02-08-slskd-download-directory.md`

**Context:** Multiple files reference "slskd", "SLSKD", or "slsk-client" in comments. Clean them all up. Also remove the stale env var references.

**Step 1: Fix each file**

- `library.ts:139-150`: Change "SLSKD downloads" comments to "Soulseek downloads" or remove if the organize step is no longer relevant.
- `playlistLogger.ts:96`: Update "Use this for SLSKD" comment.
- `envWriter.ts:59`: Change `SLSKD_SOULSEEK_USERNAME`/`PASSWORD` references. These env vars are no longer used - credentials come from DB. Remove the Soulseek section from envWriter.
- `organizeSingles.ts`: Update all "slskd" and "SLSKD" comments. The `cleanupLegacySlskdJobs()` function can stay (it handles migration) but comments should be accurate.
- `onboarding.ts:320`: Change "direct connection via slsk-client" to "direct connection via soulseek-ts".
- `soulseek.ts:4`: Change "Direct connection via slsk-client" to "Direct connection via vendored soulseek-ts".

**Step 2: Delete obsolete plan docs**

```bash
git rm -f docs/plans/2026-02-07-slskd-integration.md docs/plans/2026-02-08-slskd-download-directory.md
```

**Step 3: Verify compilation**

Run: `cd /run/media/chevron7/Storage/Projects/kima/backend && npx tsc --noEmit`

**Step 4: Commit**

```bash
git add -u
git commit -m "chore: clean up all dead slskd/slsk-client references

Update comments across backend to reference soulseek-ts.
Remove stale env var names from envWriter.
Delete obsolete slskd plan documents."
```

---

## Task 14: Add progress bar to active downloads UI

**Files:**
- Modify: `frontend/components/DownloadNotifications.tsx`

**Context:** The `DownloadNotifications.tsx` component renders active downloads. Enhance it with a progress bar that shows: indeterminate (pulsing) when queued with "Position N in queue" text, determinate when downloading with bytes/total.

**Step 1: Add progress bar**

Import `useJobProgress` from the progress context:
```typescript
import { useJobProgress } from "@/lib/download-progress-context";
```

For each active download item, call `useJobProgress(job.id)` to get real-time progress data. Render:

- If `progress?.queuePosition` exists: Show indeterminate bar + "Position {N} in queue"
- If `progress?.totalBytes` exists: Show determinate bar at `(bytesReceived / totalBytes) * 100`%
- Otherwise: Show indeterminate bar + current status text

Progress bar component (inline, no separate file needed):
```tsx
<div className="w-full h-1 bg-white/10 rounded-full overflow-hidden mt-2">
    {progress?.totalBytes ? (
        <div
            className="h-full bg-[#ecb200] rounded-full transition-all duration-300"
            style={{ width: `${Math.round((progress.bytesReceived || 0) / progress.totalBytes * 100)}%` }}
        />
    ) : (
        <div className="h-full bg-[#ecb200] rounded-full animate-pulse w-full" />
    )}
</div>
```

**Step 2: Verify frontend compiles**

Run: `cd /run/media/chevron7/Storage/Projects/kima/frontend && npx next lint`

**Step 3: Commit**

```bash
git add frontend/components/DownloadNotifications.tsx
git commit -m "feat: add real-time progress bar to active downloads"
```

---

## Task 15: Full typecheck and lint

**Files:** All modified files

**Context:** Final verification that everything compiles and lints cleanly.

**Step 1: Backend typecheck**

Run: `cd /run/media/chevron7/Storage/Projects/kima/backend && npx tsc --noEmit`

Fix any errors.

**Step 2: Frontend lint**

Run: `cd /run/media/chevron7/Storage/Projects/kima/frontend && npx next lint`

Fix any errors.

**Step 3: Commit any fixes**

```bash
git add -u
git commit -m "fix: resolve typecheck and lint errors"
```

---

## Verification Checklist

After all tasks complete, verify:

- [ ] `slsk-client` is NOT in backend/package.json
- [ ] `backend/src/types/slsk-client.d.ts` is deleted
- [ ] No `refetchInterval` in any frontend hook
- [ ] No `CustomEvent("download-status-changed")` anywhere
- [ ] No `CustomEvent("playlist-created")` anywhere
- [ ] No `CustomEvent("notifications-changed")` anywhere
- [ ] `frontend/hooks/useDownloadStatus.ts` is deleted
- [ ] `backend/src/services/eventBus.ts` exists
- [ ] `backend/src/routes/events.ts` exists
- [ ] `backend/src/lib/soulseek/` directory exists with all vendored files
- [ ] `backend/src/services/soulseek.ts` no longer imports from `slsk-client`
- [ ] `npx tsc --noEmit` passes in backend
- [ ] `npx next lint` passes in frontend
- [ ] Grep for "slskd" returns only `organizeSingles.ts` legacy cleanup code and no stale comments

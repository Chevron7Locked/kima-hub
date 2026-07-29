/**
 * Playlist ownership guards.
 *
 * This exact three-statement block -- findUnique, 404 if missing, 403 if not
 * yours -- was copy-pasted eight times in routes/playlists.ts and four more in
 * routes/subsonic/playlists.ts. Twelve copies of an authorisation check is
 * twelve chances for one of them to drift.
 */

import { NextFunction, Request, Response } from "express";
import { prisma } from "../utils/db";

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            playlist?: {
                id: string;
                userId: string;
                isPublic: boolean;
                name: string;
            };
        }
    }
}

async function loadPlaylist(id: string) {
    return prisma.playlist.findUnique({
        where: { id },
        select: { id: true, userId: true, isPublic: true, name: true },
    });
}

/**
 * Require that the caller owns the playlist named by `:id`.
 * Attaches it to `req.playlist` so the handler does not re-query.
 */
export async function requirePlaylistOwner(
    req: Request,
    res: Response,
    next: NextFunction
) {
    const userId = req.user?.id;
    if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    const playlist = await loadPlaylist(req.params.id);
    if (!playlist) {
        return res.status(404).json({ error: "Playlist not found" });
    }
    if (playlist.userId !== userId) {
        return res.status(403).json({ error: "Access denied" });
    }

    req.playlist = playlist;
    next();
}

/**
 * Require read access: the owner, or anyone if the playlist is public.
 */
export async function requirePlaylistReader(
    req: Request,
    res: Response,
    next: NextFunction
) {
    const userId = req.user?.id;
    if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    const playlist = await loadPlaylist(req.params.id);
    if (!playlist) {
        return res.status(404).json({ error: "Playlist not found" });
    }
    if (!playlist.isPublic && playlist.userId !== userId) {
        return res.status(403).json({ error: "Access denied" });
    }

    req.playlist = playlist;
    next();
}

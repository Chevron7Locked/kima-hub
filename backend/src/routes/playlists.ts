import { Router, Request, Response } from "express";
import { logger } from "../utils/logger";
import { z } from "zod";
import { requireAcquirePermission } from "../middleware/auth";
import { prisma } from "../utils/db";
import { safeError } from "../utils/errors";
import {
    requirePlaylistOwner,
    requirePlaylistReader,
} from "../middleware/playlistOwner";
import * as playlistService from "../services/playlistService";
import { announcePlaylistChange } from "../services/playlistEvents";
import { createPlaylist, KeyParamsMismatch, MAX_KEY_LENGTH } from "../services/playlistCreate";
import { namedFields, playlistFields, playlistItemFields } from "../services/playlistFields";
import { announceImportCounts } from "../services/spotifyImport";
import { proxyPreviewStream } from "../utils/previewProxy";
import {
    downloadSources,
    failRetryJob,
    findSources,
    NO_SOURCES,
    openRetryJob,
    soulseekTarget,
} from "../services/pendingTrackRetry";
import { parseLimit } from "./library/paging";

const router = Router();


/**
 * The caller's pending song `:trackId` on playlist `:id`, or null once the refusal is sent: 404 when it is missing or on
 * another playlist (one answer, so other people's pending ids do not show), 403 when the playlist is someone else's.
 */
async function ownedPendingTrack(req: Request, res: Response) {
    const pendingTrack = await prisma.playlistPendingTrack.findUnique({
        where: { id: req.params.trackId },
        include: { playlist: { select: { id: true, userId: true } } },
    });
    if (!pendingTrack || pendingTrack.playlist.id !== req.params.id) {
        res.status(404).json({ error: "Pending track not found" });
        return null;
    }
    if (pendingTrack.playlist.userId !== req.user!.id) {
        res.status(403).json({ error: "Access denied" });
        return null;
    }
    return pendingTrack;
}

/** Adds songs through the rank allocator, and tells the owner's devices when any were added. */
async function addSongs(req: Request, trackIds: string[], options?: { allowRepeats?: boolean }) {
    const result = await playlistService.addTracks(req.params.id, trackIds, options);
    if (result.added > 0) announcePlaylistChange(req.user!.id, req.params.id);
    return result;
}

const createPlaylistSchema = z.object({
    name: z.string().min(1).max(200),
    isPublic: z.boolean().optional().default(false),
});

const updatePlaylistSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    isPublic: z.boolean().optional(),
    reverseOrder: z.boolean().optional(),
});

const playlistOrderSchema = z.enum(["asc", "rev"]).optional();

const addTracksSchema = z
    .object({
        trackId: z.string().optional(),
        trackIds: z.array(z.string()).min(1).max(1000).optional(),
        // The person was asked and chose to add a song the playlist already holds; without it, those are skipped.
        allowRepeats: z.boolean().optional(),
    })
    .refine((d) => Boolean(d.trackId) !== Boolean(d.trackIds), {
        message: "Provide exactly one of trackId or trackIds",
    });

const moveItemSchema = z.object({
    afterItemId: z.string().nullable().optional(),
});

// GET /playlists
router.get("/", async (req, res) => {
    try {
        const userId = req.user!.id;

        const limit = parseLimit(req.query.limit, 50, 100);
        // A page past the last is empty; one so far that its offset is not a whole number the database takes is too.
        const page = Math.min(
            Math.max(1, parseInt(req.query.page as string, 10) || 1),
            Math.floor(Number.MAX_SAFE_INTEGER / limit)
        );

        const hiddenPlaylists = await prisma.hiddenPlaylist.findMany({
            where: { userId },
            select: { playlistId: true },
        });
        const hiddenPlaylistIds = new Set(
            hiddenPlaylists.map((h) => h.playlistId)
        );

        const playlists = await prisma.playlist.findMany({
            where: {
                OR: [{ userId }, { isPublic: true }],
            },
            orderBy: { createdAt: "desc" },
            skip: (page - 1) * limit,
            take: limit,
            select: {
                ...playlistFields,
                // Read to tell the owner; never sent.
                userId: true,
                user: {
                    select: {
                        username: true,
                    },
                },
                _count: {
                    select: { items: true },
                },
                items: {
                    take: 4,
                    select: {
                        id: true,
                        track: {
                            select: {
                                album: {
                                    select: { coverUrl: true },
                                },
                            },
                        },
                    },
                    orderBy: { rank: "asc" },
                },
            },
        });

        const playlistsWithCounts = playlists.map((playlist) => ({
            ...namedFields(playlist),
            user: playlist.user,
            items: playlist.items,
            trackCount: playlist._count.items,
            isOwner: playlist.userId === userId,
            isHidden: hiddenPlaylistIds.has(playlist.id),
        }));

        res.json(playlistsWithCounts);
    } catch (error) {
        logger.error("Get playlists error:", error);
        res.status(500).json({ error: "Failed to get playlists" });
    }
});

// POST /playlists
router.post("/", async (req, res) => {
    try {
        const userId = req.user!.id;
        const data = createPlaylistSchema.parse(req.body);

        const key = req.get("Idempotency-Key") || undefined;
        if (key !== undefined && key.length > MAX_KEY_LENGTH) {
            return res.status(400).json({ error: "Idempotency-Key is too long" });
        }

        const playlist = await createPlaylist(userId, data, key);

        announcePlaylistChange(userId, playlist.id);
        res.json(playlist);
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res
                .status(400)
                .json({ error: "Invalid request", details: error.issues });
        }
        if (error instanceof KeyParamsMismatch) {
            return res.status(422).json({ error: "Idempotency-Key was already used with different parameters" });
        }
        logger.error("Create playlist error:", error);
        res.status(500).json({ error: "Failed to create playlist" });
    }
});

// GET /playlists/:id
router.get("/:id", requirePlaylistReader, async (req, res) => {
    try {
        const userId = req.user!.id;

        const playlist = await prisma.playlist.findUnique({
            where: { id: req.params.id },
            select: {
                ...playlistFields,
                // Read to tell the owner; never sent.
                userId: true,
                user: {
                    select: {
                        username: true,
                    },
                },
                hiddenByUsers: {
                    where: { userId },
                    select: { id: true },
                },
                items: {
                    select: playlistItemFields,
                    orderBy: { rank: "asc" },
                },
                pendingTracks: {
                    orderBy: { rank: "asc" },
                },
            },
        });

        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        const order = playlistOrderSchema.safeParse(req.query.order);
        if (!order.success) {
            return res
                .status(400)
                .json({ error: "Invalid order", details: order.error.issues });
        }
        // An explicit ?order= wins; otherwise the playlist's stored flag.
        const reversed =
            order.data === "rev" ||
            (order.data === undefined && playlist.reverseOrder);

        const markedItems = await playlistService.markUnavailable(playlist.items);
        // Items and pending tracks share one rank space, so a string compare orders them; the rank itself is not sent.
        const songs = markedItems.map((item) => ({
            rank: item.rank,
            entry: {
                id: item.id,
                type: "track" as const,
                sort: item.sort,
                trackId: item.trackId,
                unavailable: item.unavailable,
                track: {
                    id: item.track.id,
                    title: item.track.title,
                    displayTitle: item.track.displayTitle,
                    duration: item.track.duration,
                    album: {
                        id: item.track.album.id,
                        title: item.track.album.title,
                        coverArt: item.track.album.coverUrl,
                        artist: { id: item.track.album.artist.id, name: item.track.album.artist.name },
                    },
                },
            },
        }));

        const pending = playlist.pendingTracks.map((row) => ({
            rank: row.rank,
            entry: {
                id: row.id,
                type: "pending" as const,
                sort: row.sort,
                pending: {
                    id: row.id,
                    artist: row.spotifyArtist,
                    title: row.spotifyTitle,
                    album: row.spotifyAlbum,
                    previewUrl: row.deezerPreviewUrl,
                    missingFromDisk: row.missingFromDisk,
                },
            },
        }));

        const formattedItems = songs.map((song) => song.entry);
        const formattedPending = pending.map((row) => row.entry);
        const mergedItems = [...songs, ...pending]
            .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
            .map((row) => row.entry);

        const displayItems = reversed ? [...formattedItems].reverse() : formattedItems;
        const displayMerged = reversed ? [...mergedItems].reverse() : mergedItems;

        res.json({
            ...namedFields(playlist),
            user: playlist.user,
            isOwner: playlist.userId === userId,
            isHidden: playlist.hiddenByUsers.length > 0,
            trackCount: playlist.items.length,
            pendingCount: playlist.pendingTracks.length,
            items: displayItems,
            pendingTracks: formattedPending,
            mergedItems: displayMerged,
        });
    } catch (error) {
        logger.error("Get playlist error:", error);
        res.status(500).json({ error: "Failed to get playlist" });
    }
});

// PUT and PATCH share one handler: rename, visibility and reverseOrder are
// the same owner-only edit surface.
async function updatePlaylist(req: Request, res: Response) {
    try {
        const data = updatePlaylistSchema.parse(req.body);

        const playlist = await prisma.playlist.update({
            where: { id: req.params.id },
            data: {
                ...(data.name !== undefined && { name: data.name }),
                ...(data.isPublic !== undefined && { isPublic: data.isPublic }),
                ...(data.reverseOrder !== undefined && {
                    reverseOrder: data.reverseOrder,
                }),
            },
            select: playlistFields,
        });

        announcePlaylistChange(req.user!.id, playlist.id);
        res.json(namedFields(playlist));
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res
                .status(400)
                .json({ error: "Invalid request", details: error.issues });
        }
        logger.error("Update playlist error:", error);
        res.status(500).json({ error: "Failed to update playlist" });
    }
}

router.put("/:id", requirePlaylistOwner, updatePlaylist);
router.patch("/:id", requirePlaylistOwner, updatePlaylist);

// POST /playlists/:id/hide - Hide any playlist from your view
router.post("/:id/hide", requirePlaylistReader, async (req, res) => {
    try {
        const userId = req.user!.id;
        const playlistId = req.params.id;

        // Re-hiding finds the row already there and changes nothing.
        const hidden = await prisma.hiddenPlaylist.createMany({
            data: [{ userId, playlistId }],
            skipDuplicates: true,
        });

        if (hidden.count > 0) announcePlaylistChange(userId, playlistId);
        res.json({ message: "Playlist hidden", isHidden: true });
    } catch (error) {
        logger.error("Hide playlist error:", error);
        res.status(500).json({ error: "Failed to hide playlist" });
    }
});

// DELETE /playlists/:id/hide - Unhide a shared playlist
router.delete("/:id/hide", async (req, res) => {
    try {
        const userId = req.user!.id;
        const playlistId = req.params.id;

        const unhidden = await prisma.hiddenPlaylist.deleteMany({
            where: { userId, playlistId },
        });

        if (unhidden.count > 0) announcePlaylistChange(userId, playlistId);
        res.json({ message: "Playlist unhidden", isHidden: false });
    } catch (error) {
        logger.error("Unhide playlist error:", error);
        res.status(500).json({ error: "Failed to unhide playlist" });
    }
});

// DELETE /playlists/:id
router.delete("/:id", requirePlaylistOwner, async (req, res) => {
    try {
        await prisma.playlist.delete({
            where: { id: req.params.id },
        });

        announcePlaylistChange(req.user!.id, req.params.id, true);
        res.json({ message: "Playlist deleted" });
    } catch (error) {
        logger.error("Delete playlist error:", error);
        res.status(500).json({ error: "Failed to delete playlist" });
    }
});

// POST /playlists/:id/items
// Takes { trackId } or { trackIds: [...] }; adding an album should send one bulk request. A song the playlist already
// holds is skipped and counted in `duplicates` unless the body says { allowRepeats: true }.
router.post("/:id/items", requirePlaylistOwner, async (req, res) => {
    try {
        const parsed = addTracksSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                error: "Invalid request",
                details: parsed.error.issues,
            });
        }

        const result = await addSongs(req, parsed.data.trackIds ?? [parsed.data.trackId!], {
            allowRepeats: parsed.data.allowRepeats,
        });

        if (result.added === 0 && result.duplicates === 0) {
            return res.status(404).json({
                error: "No matching tracks in request",
                rejected: result.rejected,
            });
        }

        res.json({
            added: result.added,
            duplicated: result.duplicates > 0,
            duplicates: result.duplicates,
            duplicateIds: result.duplicateIds,
            rejected: result.rejected,
        });
    } catch (error) {
        logger.error("Add tracks to playlist error:", error);
        res.status(500).json({ error: "Failed to add tracks to playlist" });
    }
});

// POST /playlists/:id/items/batch
// Appends many tracks in one call, in the submitted order.
const addTracksBatchSchema = z.object({
    trackIds: z.array(z.string()).min(1).max(500),
});
router.post("/:id/items/batch", requirePlaylistOwner, async (req, res) => {
    try {
        const parsed = addTracksBatchSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                error: "Invalid request",
                details: parsed.error.issues,
            });
        }
        const { trackIds } = parsed.data;
        const result = await addSongs(req, trackIds);

        const rows = await prisma.playlistItem.findMany({
            where: {
                playlistId: req.params.id,
                trackId: { in: [...new Set(trackIds)] },
            },
            include: {
                track: { include: { album: { include: { artist: true } } } },
            },
            orderBy: { rank: "asc" },
        });
        const items = await playlistService.markUnavailable(rows);

        return res.json({
            added: result.added,
            skippedExisting: result.duplicates,
            skippedInvalid: result.rejected.length,
            items,
        });
    } catch (error) {
        logger.error("Batch add tracks to playlist error:", error);
        res.status(500).json({ error: "Failed to add tracks to playlist" });
    }
});

// DELETE /playlists/:id/items/:ref
// `ref` is an item id (removes that one entry) or a song id (removes every entry of the song, which is what the iOS
// app sends). 404 when nothing is left to remove.
router.delete("/:id/items/:ref", requirePlaylistOwner, async (req, res) => {
    try {
        const removed = await playlistService.removeEntry(req.params.id, req.params.ref);
        if (removed === 0) {
            return res.status(404).json({ error: "Track not in playlist" });
        }
        announcePlaylistChange(req.user!.id, req.params.id);
        res.json({ success: true, removed });
    } catch (error) {
        logger.error("Remove track from playlist error:", error);
        res.status(500).json({ error: "Failed to remove track from playlist" });
    }
});

// PATCH /playlists/:id/items/:itemId/move  { afterItemId: string | null }
// Moves one item to sit directly after the anchor, or first when null.
router.patch("/:id/items/:itemId/move", requirePlaylistOwner, async (req, res) => {
    try {
        const parsed = moveItemSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                error: "Invalid request",
                details: parsed.error.issues,
            });
        }

        const { rank } = await playlistService.moveItem(
            req.params.id,
            req.params.itemId,
            parsed.data.afterItemId ?? null
        );

        announcePlaylistChange(req.user!.id, req.params.id);

        res.json({ success: true, rank });
    } catch (error: any) {
        if (error?.code === "ITEM_NOT_FOUND") {
            return res.status(404).json({ error: "Item not in playlist" });
        }
        if (error?.code === "ANCHOR_NOT_FOUND") {
            return res.status(400).json({ error: "Anchor item not in playlist" });
        }
        logger.error("Move playlist item error:", error);
        res.status(500).json({ error: "Failed to move item" });
    }
});

/**
 * DELETE /playlists/:id/pending/:trackId
 * Remove a pending track (user decides they don't want to wait for it)
 */
router.delete("/:id/pending/:trackId", async (req, res) => {
    try {
        const pendingTrack = await ownedPendingTrack(req, res);
        if (!pendingTrack) return;

        // Under the playlist lock, with the import's counts: a scan placing the same song cannot add it back.
        if (!(await playlistService.dismissWaitingEntry(req.params.id, pendingTrack.id))) {
            return res.status(404).json({ error: "Pending track not found" });
        }

        announcePlaylistChange(req.user!.id, req.params.id);
        await announceImportCounts(req.params.id);
        res.json({ message: "Pending track removed" });
    } catch (error: any) {
        logger.error("Delete pending track error:", error);
        res.status(500).json({ error: "Failed to delete pending track" });
    }
});

/**
 * GET /playlists/:id/pending/:trackId/preview/stream
 * Stream pending track preview via backend proxy for strict ORB browsers
 */
router.get("/:id/pending/:trackId/preview/stream", async (req, res) => {
    try {
        const pendingTrack = await ownedPendingTrack(req, res);
        if (!pendingTrack) return;

        const { deezerService } = await import("../services/deezer");
        const previewUrl = await deezerService.getFreshTrackPreview(
            pendingTrack.spotifyArtist,
            pendingTrack.spotifyTitle
        );

        if (!previewUrl) {
            return res
                .status(404)
                .json({ error: "No preview available on Deezer" });
        }

        await proxyPreviewStream(res, previewUrl, {
            notFoundMessage: "No preview available on Deezer",
            logLabel: "Pending preview stream",
            rangeHeader: req.headers.range,
        });
    } catch (error) {
        safeError(res, "Pending track preview stream", error);
    }
});

/**
 * POST /playlists/:id/pending/retry-all
 * Retries every pending song through Soulseek. Answers once the jobs exist; the songs are then fetched one at a time,
 * so Soulseek is not flooded.
 */
router.post("/:id/pending/retry-all", requireAcquirePermission, requirePlaylistOwner, async (req, res) => {
    try {
        const userId = req.user!.id;
        const pendingTracks = await prisma.playlistPendingTrack.findMany({
            where: { playlistId: req.params.id },
        });
        if (pendingTracks.length === 0) {
            return res.json({ success: true, queued: 0, message: "No pending tracks to retry" });
        }

        const target = await soulseekTarget();
        if ("problem" in target) {
            return res.status(502).json({ error: target.problem });
        }

        // A song already being retried keeps its running job: it is neither started again nor counted as queued.
        const retries = [];
        for (const pendingTrack of pendingTracks) {
            const opened = await openRetryJob(userId, pendingTrack);
            if ("created" in opened) retries.push({ job: opened.created, pendingTrack });
        }

        res.json({
            success: true,
            queued: retries.length,
            message:
                retries.length > 0 ? `Retrying ${retries.length} tracks` : "These tracks are already being retried",
        });

        void (async () => {
            for (const { job, pendingTrack } of retries) {
                try {
                    const matches = await findSources(job, pendingTrack);
                    if (matches.length > 0) {
                        await downloadSources(job, pendingTrack, matches, target.musicPath, "retry-pending-track-batch");
                    }
                } catch (error) {
                    logger.error(`[Pending retry] Search for job ${job.id} failed:`, error);
                }
            }
        })();
    } catch (error) {
        logger.error("Retry all pending tracks error:", error);
        res.status(500).json({ error: "Failed to retry pending tracks" });
    }
});

/**
 * POST /playlists/:id/pending/:trackId/retry
 * Retries one pending song through Soulseek. Answers after the search, so a song Soulseek does not have is said at
 * once; a found song downloads in the background.
 */
router.post("/:id/pending/:trackId/retry", requireAcquirePermission, async (req, res) => {
    try {
        const pendingTrack = await ownedPendingTrack(req, res);
        if (!pendingTrack) return;

        const target = await soulseekTarget();
        const opened = await openRetryJob(req.user!.id, pendingTrack);
        if ("running" in opened) {
            return res.json({
                success: true,
                message: "Already retrying",
                downloadJobId: opened.running.id,
                deduplicated: true,
            });
        }
        const job = opened.created;
        if ("problem" in target) {
            await failRetryJob(job.id, target.problem);
            return res.status(502).json({ success: false, error: target.problem, downloadJobId: job.id });
        }

        let matches: Awaited<ReturnType<typeof findSources>>;
        try {
            matches = await findSources(job, pendingTrack);
        } catch (error: any) {
            // findSources has already failed the job; Soulseek, the source, did not answer.
            logger.error(`[Retry] Soulseek search for job ${job.id} failed:`, error);
            return res.status(502).json({ success: false, error: error?.message || "Soulseek search failed", downloadJobId: job.id });
        }
        if (matches.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Track not found on Soulseek",
                error: NO_SOURCES,
                downloadJobId: job.id,
            });
        }

        res.json({
            success: true,
            message: "Download started",
            note: `Found ${matches.length} sources. Downloading... Track will appear after scan.`,
            downloadJobId: job.id,
        });
        void downloadSources(job, pendingTrack, matches, target.musicPath, "retry-pending-track");
    } catch (error) {
        safeError(res, "Retry pending track download", error);
    }
});

export default router;

/**
 * Share links.
 *
 * Extracted from the POST /api/share handler so the Subsonic surface can create
 * a REAL share instead of fabricating one. `createShare.view` used to return a
 * synthetic id and a URL pointing at `/share/unsupported` -- a path that does
 * not exist -- so a client handed the user a link that was dead on arrival,
 * which is worse than refusing. The machinery was already here; only the web
 * route could reach it.
 */

import { randomBytes } from "crypto";
import { prisma } from "../utils/db";

export type ShareEntityType = "playlist" | "track" | "album";

export const SHARE_ENTITY_TYPES: ShareEntityType[] = [
    "playlist",
    "track",
    "album",
];

/** Per-user cap on live share links. */
export const MAX_SHARE_LINKS_PER_USER = 500;

export class ShareError extends Error {
    constructor(
        message: string,
        readonly code:
            | "INVALID_ENTITY_TYPE"
            | "NOT_FOUND"
            | "FORBIDDEN"
            | "LIMIT_REACHED"
    ) {
        super(message);
        this.name = "ShareError";
    }
}

export interface ShareLinkResult {
    token: string;
    /** Path, not an absolute URL — the caller knows its own host. */
    url: string;
    /** True when an existing live link was reused rather than a new one minted. */
    existing: boolean;
}

/**
 * Create (or reuse) a share link for an entity the caller is allowed to share.
 *
 * Reuses a caller's existing live link for the same entity rather than minting
 * duplicates. The unique-ish check and the insert run in one Serializable
 * transaction with a single retry, because `ShareLink` has no unique constraint
 * on (entityType, entityId, createdBy) to lean on.
 */
export async function createShareLink(
    userId: string,
    entityType: string,
    entityId: string
): Promise<ShareLinkResult> {
    if (!SHARE_ENTITY_TYPES.includes(entityType as ShareEntityType)) {
        throw new ShareError(
            "entityType must be playlist, track, or album",
            "INVALID_ENTITY_TYPE"
        );
    }

    if (entityType === "playlist") {
        const playlist = await prisma.playlist.findUnique({
            where: { id: entityId },
            select: { userId: true },
        });
        if (!playlist) throw new ShareError("Playlist not found", "NOT_FOUND");
        if (playlist.userId !== userId) {
            throw new ShareError("Not the playlist owner", "FORBIDDEN");
        }
    } else if (entityType === "track") {
        const track = await prisma.track.findUnique({
            where: { id: entityId },
            select: { id: true },
        });
        if (!track) throw new ShareError("Track not found", "NOT_FOUND");
    } else {
        const album = await prisma.album.findUnique({
            where: { id: entityId },
            select: { id: true },
        });
        if (!album) throw new ShareError("Album not found", "NOT_FOUND");
    }

    const attempt = () =>
        prisma.$transaction(
            async (tx) => {
                const live = {
                    OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
                };

                const existing = await tx.shareLink.findFirst({
                    where: { entityType, entityId, createdBy: userId, ...live },
                });
                if (existing) {
                    return {
                        token: existing.token,
                        url: `/share/${existing.token}`,
                        existing: true,
                    };
                }

                const count = await tx.shareLink.count({
                    where: { createdBy: userId, ...live },
                });
                if (count >= MAX_SHARE_LINKS_PER_USER) {
                    throw new ShareError(
                        `Share link limit reached (max ${MAX_SHARE_LINKS_PER_USER})`,
                        "LIMIT_REACHED"
                    );
                }

                const created = await tx.shareLink.create({
                    data: {
                        token: randomBytes(24).toString("base64url"),
                        entityType,
                        entityId,
                        createdBy: userId,
                    },
                });

                return {
                    token: created.token,
                    url: `/share/${created.token}`,
                    existing: false,
                };
            },
            { isolationLevel: "Serializable" }
        );

    try {
        return await attempt();
    } catch (error: any) {
        // P2034 is a serialization failure; one retry is enough for the
        // read-then-insert race this guards.
        if (error?.code === "P2034") return attempt();
        throw error;
    }
}

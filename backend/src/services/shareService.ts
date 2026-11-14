/** Share links, created by the web route and Subsonic's createShare.view. */

import { randomBytes } from "crypto";
import { prisma } from "../utils/db";
import { isTransactionConflict } from "../utils/dbConflict";
import { PLAYABLE_SONG } from "../utils/playableSong";
import { PLAYABLE_ALBUM_WHERE } from "./libraryFilters";

type ShareEntityType = "playlist" | "track" | "album";

const SHARE_ENTITY_TYPES: ShareEntityType[] = [
    "playlist",
    "track",
    "album",
];

/** Per-user cap on live share links. */
const MAX_SHARE_LINKS_PER_USER = 500;

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
    /** The link as stored: for a reused link, its own dates and visit count, not the request's. */
    createdAt: Date;
    expiresAt: Date | null;
    playCount: number;
}

export interface CreateShareOptions {
    /** When a new link stops working; null or absent never. A reused link keeps the expiry it has. */
    expiresAt?: Date | null;
}

const resultOf = (
    link: { token: string; createdAt: Date; expiresAt: Date | null; playCount: number },
    existing: boolean
): ShareLinkResult => ({
    token: link.token,
    url: `/share/${link.token}`,
    existing,
    createdAt: link.createdAt,
    expiresAt: link.expiresAt,
    playCount: link.playCount,
});

/**
 * Create a share link, or reuse the caller's live link for the same entity.
 * ShareLink has no unique constraint for that, so the check and insert run in
 * one Serializable transaction with a single retry.
 */
export async function createShareLink(
    userId: string,
    entityType: string,
    entityId: string,
    options: CreateShareOptions = {}
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
        // A song or album with nothing to play (Discover, missing, corrupt) is not found, on the web and Subsonic alike.
        const track = await prisma.track.findFirst({
            where: { id: entityId, ...PLAYABLE_SONG },
            select: { id: true },
        });
        if (!track) throw new ShareError("Track not found", "NOT_FOUND");
    } else {
        const album = await prisma.album.findFirst({
            where: { id: entityId, ...PLAYABLE_ALBUM_WHERE },
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
                // A link the caller already has is reused as it is, expiry included: asking again with another
                // expiry is not a request to change this one (updateShare does that).
                if (existing) return resultOf(existing, true);

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
                        expiresAt: options.expiresAt ?? null,
                    },
                });

                return resultOf(created, false);
            },
            { isolationLevel: "Serializable" }
        );

    try {
        return await attempt();
    } catch (error: any) {
        // One retry is enough for the read-then-insert race this guards.
        if (isTransactionConflict(error)) return attempt();
        throw error;
    }
}

/** A caller's live (unexpired) share links, newest first. */
export async function listShareLinks(userId: string) {
    return prisma.shareLink.findMany({
        where: {
            createdBy: userId,
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        orderBy: { createdAt: "desc" },
    });
}

/**
 * Change a share's expiry. Only the owner may.
 *
 * `expiresAt` of null clears the expiry; omitting it leaves it alone, so the
 * caller can distinguish "no change" from "never expires".
 */
export async function updateShareLink(
    userId: string,
    token: string,
    changes: { expiresAt?: Date | null }
) {
    const link = await requireOwnedLink(userId, token);
    if (changes.expiresAt === undefined) return link;

    return prisma.shareLink.update({
        where: { id: link.id },
        data: { expiresAt: changes.expiresAt },
    });
}

/** Revoke a share. Only the owner may. */
export async function deleteShareLink(userId: string, token: string) {
    const link = await requireOwnedLink(userId, token);
    await prisma.shareLink.delete({ where: { id: link.id } });
}

async function requireOwnedLink(userId: string, token: string) {
    const link = await prisma.shareLink.findUnique({ where: { token } });
    if (!link) throw new ShareError("Share not found", "NOT_FOUND");
    if (link.createdBy !== userId) {
        throw new ShareError("Not the link owner", "FORBIDDEN");
    }
    return link;
}


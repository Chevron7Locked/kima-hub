import { Router } from "express";
import { prisma } from "../../utils/db";
import { subsonicOk, subsonicError, SubsonicError } from "../../utils/subsonicResponse";
import { wrap, parseIntParam } from "./mappers";

export const artistInfoRouter = Router();

artistInfoRouter.all(["/getArtistInfo2.view", "/getArtistInfo.view"], wrap(async (req, res) => {
    const id = req.query.id as string | undefined;
    if (!id) return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");

    const count = Math.min(parseIntParam(req.query.count as string | undefined, 20), 50);

    const artist = await prisma.artist.findUnique({
        where: { id },
        select: {
            id: true,
            mbid: true,
            summary: true,
            userSummary: true,
            heroUrl: true,
            similarArtistsJson: true,
        },
    });
    if (!artist) return subsonicError(req, res, SubsonicError.NOT_FOUND, "Artist not found");

    const rawSimilar = (artist.similarArtistsJson as Array<{ name: string; mbid?: string; match: number }>) || [];
    const resolvedSimilar: Array<{ id: string; name: string; coverArt: string }> = [];

    if (rawSimilar.length > 0) {
        const top = rawSimilar.slice(0, count);
        const mbids = top.filter((s) => s.mbid).map((s) => s.mbid as string);
        const names = top.map((s) => s.name.toLowerCase());

        const candidates = await prisma.artist.findMany({
            where: {
                OR: [
                    ...(mbids.length > 0 ? [{ mbid: { in: mbids } }] : []),
                    { normalizedName: { in: names } },
                ],
            },
            select: { id: true, name: true, displayName: true, mbid: true, normalizedName: true },
            take: count * 2,
        });

        const usedIds = new Set<string>();
        for (const s of top) {
            const found = candidates.find(
                (a) => !usedIds.has(a.id) &&
                    ((s.mbid && a.mbid === s.mbid) || a.normalizedName === s.name.toLowerCase())
            );
            if (found) {
                usedIds.add(found.id);
                resolvedSimilar.push({
                    id: found.id,
                    name: found.displayName || found.name,
                    coverArt: `ar-${found.id}`,
                });
            }
        }
    }

    const infoKey = req.path.includes("getArtistInfo2") ? "artistInfo2" : "artistInfo";
    return subsonicOk(req, res, {
        [infoKey]: {
            biography: artist.userSummary || artist.summary || undefined,
            musicBrainzId: artist.mbid || undefined,
            "@_coverArt": `ar-${artist.id}`,
            "@_largeImageUrl": artist.heroUrl || undefined,
            "@_smallImageUrl": artist.heroUrl || undefined,
            "@_mediumImageUrl": artist.heroUrl || undefined,
            ...(resolvedSimilar.length > 0 ? {
                similarArtist: resolvedSimilar.map((s) => ({
                    "@_id": s.id,
                    "@_name": s.name,
                    "@_coverArt": s.coverArt,
                })),
            } : {}),
        },
    });
}));
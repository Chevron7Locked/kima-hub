import { Router } from "express";
import { normalizeArtistName } from "../../services/artistIdentity";
import { prisma } from "../../utils/db";
import { subsonicOk, subsonicError, SubsonicError } from "../../utils/subsonicResponse";
import { wrap, parseIntParam, coverArtId, artistPicture } from "./mappers";
import { one } from "../../utils/subsonicParams";

export const artistInfoRouter = Router();

artistInfoRouter.all(["/getArtistInfo2.view", "/getArtistInfo.view"], wrap(async (req, res) => {
    const id = one(req, "id");
    if (!id) return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");

    const count = Math.min(parseIntParam(one(req, "count"), 20), 50);

    const artist = await prisma.artist.findUnique({
        where: { id },
        select: {
            id: true,
            mbid: true,
            summary: true,
            userSummary: true,
            heroUrl: true,
            userHeroUrl: true,
            similarArtistsJson: true,
        },
    });
    if (!artist) return subsonicError(req, res, SubsonicError.NOT_FOUND, "Artist not found");

    const rawSimilar = (artist.similarArtistsJson as Array<{ name: string; mbid?: string; match: number }>) || [];
    const resolvedSimilar: Array<{ id: string; name: string; coverArt: string }> = [];

    if (rawSimilar.length > 0) {
        const top = rawSimilar.slice(0, count);
        const mbids = top.filter((s) => s.mbid).map((s) => s.mbid as string);
        // normalizeArtistName is what writes normalizedName; toLowerCase alone
        // does not fold accents or ampersands, so accented artists never matched.
        const names = top.map((s) => normalizeArtistName(s.name));

        const candidates = await prisma.artist.findMany({
            where: {
                OR: [
                    ...(mbids.length > 0 ? [{ mbid: { in: mbids } }] : []),
                    { normalizedName: { in: names } },
                ],
            },
            select: { id: true, name: true, displayName: true, mbid: true, normalizedName: true, heroUrl: true, userHeroUrl: true },
            take: count * 2,
        });

        const usedIds = new Set<string>();
        for (const s of top) {
            const found = candidates.find(
                (a) => !usedIds.has(a.id) &&
                    ((s.mbid && a.mbid === s.mbid) || a.normalizedName === normalizeArtistName(s.name))
            );
            if (found) {
                usedIds.add(found.id);
                resolvedSimilar.push({
                    id: found.id,
                    name: found.displayName || found.name,
                    coverArt: coverArtId(`ar-${found.id}`, artistPicture(found)),
                });
            }
        }
    }

    const picture = artistPicture(artist);
    const infoKey = req.path.includes("getArtistInfo2") ? "artistInfo2" : "artistInfo";
    return subsonicOk(req, res, {
        [infoKey]: {
            biography: artist.userSummary || artist.summary || undefined,
            musicBrainzId: artist.mbid || undefined,
            "@_coverArt": coverArtId(`ar-${artist.id}`, picture),
            "@_largeImageUrl": picture || undefined,
            "@_smallImageUrl": picture || undefined,
            "@_mediumImageUrl": picture || undefined,
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
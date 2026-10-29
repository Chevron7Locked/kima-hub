import express from "express";
import { prisma } from "../../../utils/db";
import router from "../../library/tracks";

/** The tracks router mounted at "/", as the radio playable tests call it. */
export function radioApp() {
    const app = express();
    app.use(express.json());
    app.use("/", router);
    return app;
}

export async function cleanupPlayable(prefix: string): Promise<void> {
    await prisma.play.deleteMany({ where: { userId: { startsWith: prefix } } });
    await prisma.track.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: prefix } } });
}

interface PlayableLibrary {
    /** Names the artist, album and tracks, e.g. "Fav" gives "Fav Artist" and "Fav Track 7". */
    label: string;
    trackCount: number;
    /** Track numbers (inclusive) given a missingSince date, and marked corrupt. */
    missing: [number, number];
    corrupt: [number, number];
}

/** One user, artist and album under `prefix`, and tracks numbered 0..trackCount-1 with the missing and corrupt ranges set. */
export async function seedPlayableLibrary(prefix: string, lib: PlayableLibrary): Promise<void> {
    await cleanupPlayable(prefix);
    await prisma.user.create({ data: { id: `${prefix}user`, username: `${prefix}user`, passwordHash: "x" } });
    await prisma.artist.create({
        data: { id: `${prefix}art`, name: `${lib.label} Artist`, normalizedName: `${lib.label.toLowerCase()} artist`, identityKey: `${prefix}ak` },
    });
    await prisma.album.create({
        data: { id: `${prefix}alb`, rgMbid: `${prefix}rg`, artistId: `${prefix}art`, identityKey: `${prefix}ik`, title: `${lib.label} Album`, primaryType: "Album" },
    });
    const trackTitle = `${lib.label} Track `;
    await prisma.$executeRaw`
        INSERT INTO "Track" (id, "albumId", title, "trackNo", duration, "filePath", "fileModified", "fileSize", "missingSince", corrupt, "updatedAt")
        SELECT ${prefix + "trk_"} || lpad(i::text, 3, '0'), ${prefix + "alb"}, ${trackTitle} || i, 1, 200,
               '/tmp/' || ${prefix} || i || '.flac', now(), 1000,
               CASE WHEN i BETWEEN ${lib.missing[0]} AND ${lib.missing[1]} THEN now() END, i BETWEEN ${lib.corrupt[0]} AND ${lib.corrupt[1]}, now()
        FROM generate_series(0, ${lib.trackCount - 1}) AS i`;
}

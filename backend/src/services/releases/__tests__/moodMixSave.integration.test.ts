/**
 * Saving a mood mix as a playlist keeps only playable songs. A song the mix remembers can have left the library
 * since (its file went missing, it was found corrupt, its album was moved to Discover); the saved playlist offers
 * only the songs that are still playable, and when none are, no playlist is made. Real database.
 */
import { prisma } from "../../../utils/db";
import { VALID_MOODS, type MoodType } from "../../moodBucketService";
import { MoodMixNotFoundError, saveMoodMixAsPlaylist } from "../moodMixes";

jest.setTimeout(60_000);

const P = "zz-mixsave";
const USER = `${P}-user`;
const SONG = {
    a: `${P}-a`,
    missing: `${P}-missing`,
    corrupt: `${P}-corrupt`,
    discover: `${P}-discover`,
    b: `${P}-b`,
} as const;
const GENERATED_AT = new Date("2026-01-01T00:00:00Z");
const MIX_ID = `your-mood-mix-${GENERATED_AT.getTime()}`;

async function clean() {
    await prisma.playlist.deleteMany({ where: { userId: USER } });
    await prisma.userMoodMix.deleteMany({ where: { userId: USER } });
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE '${P}%'`);
    await prisma.user.deleteMany({ where: { id: USER } });
}

/** The user's saved mix: `mood` is a retired one by default, so the mix keeps exactly the ids it was saved with. */
const saveMix = (trackIds: string[], mood = "focus") =>
    prisma.userMoodMix.upsert({
        where: { userId: USER },
        create: { userId: USER, mood, trackIds, coverUrls: [], servedTrackIds: [], generatedAt: GENERATED_AT },
        update: { mood, trackIds, generatedAt: GENERATED_AT },
    });

const playlists = () => prisma.playlist.findMany({ where: { userId: USER } });
const itemsOf = async (playlistId: string) =>
    (await prisma.playlistItem.findMany({ where: { playlistId }, orderBy: { rank: "asc" }, select: { trackId: true } })).map(
        (i) => i.trackId,
    );

beforeAll(async () => {
    await clean();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x" } });
    await prisma.artist.create({ data: { id: `${P}-artist`, name: `${P} artist`, identityKey: `${P}-ak` } });
    for (const [album, location] of [[`${P}-lib`, "LIBRARY"], [`${P}-disc`, "DISCOVER"]] as const) {
        await prisma.album.create({
            data: { id: album, artistId: `${P}-artist`, rgMbid: `${album}-rg`, title: album, identityKey: album, primaryType: "Album", location },
        });
    }
    const row = (id: string, albumId: string, trackNo: number, extra: object = {}) => ({
        id, albumId, title: id, trackNo, duration: 200, filePath: `/tmp/${id}.flac`, fileModified: new Date(), fileSize: 1000, ...extra,
    });
    await prisma.track.createMany({
        data: [
            row(SONG.a, `${P}-lib`, 1),
            row(SONG.missing, `${P}-lib`, 2, { missingSince: new Date() }),
            row(SONG.corrupt, `${P}-lib`, 3, { corrupt: true }),
            row(SONG.discover, `${P}-disc`, 1),
            row(SONG.b, `${P}-lib`, 4),
        ],
    });
});

afterEach(async () => {
    await prisma.playlist.deleteMany({ where: { userId: USER } });
    await prisma.userMoodMix.deleteMany({ where: { userId: USER } });
});

afterAll(clean);

describe("saveMoodMixAsPlaylist", () => {
    it("is tested with a retired mood and a current one", () => {
        expect(VALID_MOODS).not.toContain("focus" as MoodType);
        expect(VALID_MOODS).toContain("happy");
    });

    it("makes no playlist when none of the mix's songs is playable", async () => {
        await saveMix([SONG.missing, SONG.corrupt, SONG.discover, `${P}-gone`]);
        await expect(saveMoodMixAsPlaylist(USER, MIX_ID)).rejects.toBeInstanceOf(MoodMixNotFoundError);
        expect(await playlists()).toEqual([]);
    });

    it("makes no playlist when a current mood's mix has lost all its songs", async () => {
        await saveMix([SONG.missing, SONG.corrupt], "happy");
        await expect(saveMoodMixAsPlaylist(USER, MIX_ID)).rejects.toBeInstanceOf(MoodMixNotFoundError);
        expect(await playlists()).toEqual([]);
    });

    it("saves only the playable songs of a partial mix, in the mix's order", async () => {
        await saveMix([SONG.b, SONG.missing, SONG.discover, SONG.a, SONG.corrupt]);
        const saved = await saveMoodMixAsPlaylist(USER, MIX_ID);
        expect(saved).toMatchObject({ created: true, trackCount: 2 });
        expect(await itemsOf(saved.id)).toEqual([SONG.b, SONG.a]);
    });

    it("saves only the playable songs of a partial mix under a current mood", async () => {
        await saveMix([SONG.a, SONG.missing, SONG.b], "happy");
        const saved = await saveMoodMixAsPlaylist(USER, MIX_ID);
        expect(saved).toMatchObject({ created: true, trackCount: 2 });
        expect(await itemsOf(saved.id)).toEqual([SONG.a, SONG.b]);
    });

    it("leaves a playlist saved earlier as it was when the mix has since lost every song", async () => {
        await saveMix([SONG.a, SONG.b]);
        const first = await saveMoodMixAsPlaylist(USER, MIX_ID);
        await prisma.track.update({ where: { id: SONG.a }, data: { missingSince: new Date() } });
        await prisma.track.update({ where: { id: SONG.b }, data: { corrupt: true } });
        try {
            await expect(saveMoodMixAsPlaylist(USER, MIX_ID)).rejects.toBeInstanceOf(MoodMixNotFoundError);
            expect(await playlists()).toHaveLength(1);
            expect(await itemsOf(first.id)).toEqual([SONG.a, SONG.b]);
        } finally {
            await prisma.track.updateMany({ where: { id: { in: [SONG.a, SONG.b] } }, data: { missingSince: null, corrupt: false } });
        }
    });
});

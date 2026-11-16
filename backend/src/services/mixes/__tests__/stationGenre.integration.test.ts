/**
 * The genre station plays the songs that show the genre, or a genre that contains it: a song's own genre tags decide when it
 * has any, else its album's (songGenreFilterSql with the contains match). Real database.
 */
import { prisma } from "../../../utils/db";
import { selectRadioTracks } from "../stationSelection";

jest.setTimeout(60_000);

const P = "stg_";
const GENRE = "Zzstationgenre";
const song = (n: string, albumId: string, extra: Record<string, unknown> = {}) => ({
    id: `${P}t-${n}`, title: `Song ${n}`, albumId, trackNo: 1, duration: 100,
    filePath: `/${P}/${n}.flac`, fileModified: new Date(), fileSize: 1000, ...extra,
});

async function clean() {
    await prisma.genre.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

async function played(value: string) {
    const reply = await selectRadioTracks("genre", value, {}, 50, undefined);
    if ("reply" in reply) return [];
    return reply.trackIds.filter((id) => id.startsWith(P)).sort();
}

beforeAll(async () => {
    await clean();
    for (const [key, genres] of [["match", [GENRE]], ["other", ["zzelse"]], ["broad", [`${GENRE} extra`]]] as const) {
        await prisma.artist.create({
            data: { id: `${P}ar-${key}`, name: `${P} ${key}`, normalizedName: `${P} ${key}`, identityKey: `${P}${key}`, genres: [...genres] },
        });
        await prisma.album.create({
            data: { id: `${P}al-${key}`, artistId: `${P}ar-${key}`, rgMbid: `${P}rg-${key}`, primaryType: "Album", title: `${P} ${key}`, location: "LIBRARY" },
        });
    }
    await prisma.artist.create({
        data: { id: `${P}ar-disc`, name: `${P} disc`, normalizedName: `${P} disc`, identityKey: `${P}disc`, genres: [GENRE] },
    });
    await prisma.album.create({
        data: { id: `${P}al-disc`, artistId: `${P}ar-disc`, rgMbid: `${P}rg-disc`, primaryType: "Album", title: `${P} disc`, location: "DISCOVER" },
    });
    await prisma.track.createMany({
        data: [
            song("plain", `${P}al-match`),
            // On an album showing the genre, but tagged with another genre itself.
            song("retagged", `${P}al-match`),
            // On an album showing another genre, but tagged with the genre itself.
            song("tagged", `${P}al-other`),
            song("untagged-other", `${P}al-other`),
            // A genre that contains the asked one still answers it.
            song("broad", `${P}al-broad`),
            song("discover", `${P}al-disc`),
            song("missing", `${P}al-match`, { missingSince: new Date() }),
            song("corrupt", `${P}al-match`, { corrupt: true }),
        ],
    });
    await prisma.genre.create({ data: { id: `${P}g`, name: GENRE, trackGenres: { create: { trackId: `${P}t-tagged` } } } });
    await prisma.genre.create({ data: { id: `${P}g-else`, name: "zzretag", trackGenres: { create: { trackId: `${P}t-retagged` } } } });
});

afterAll(clean);

it("plays the songs showing the genre or one containing it, by their own tags before their album's", async () => {
    expect(await played(GENRE.toLowerCase())).toEqual([`${P}t-broad`, `${P}t-plain`, `${P}t-tagged`]);
});

it("finds a song by its own tag when its album's genre does not match", async () => {
    expect(await played(GENRE)).toContain(`${P}t-tagged`);
    expect(await played(GENRE)).not.toContain(`${P}t-untagged-other`);
});

it("does not play a song tagged with another genre because its album shows the asked one", async () => {
    expect(await played(GENRE)).not.toContain(`${P}t-retagged`);
});

it("plays no Discover, missing or corrupt song", async () => {
    const ids = await played(GENRE);
    for (const n of ["discover", "missing", "corrupt"]) expect(ids).not.toContain(`${P}t-${n}`);
});

it("plays nothing for a name that is no genre", async () => {
    expect(await played("-")).toEqual([]);
});

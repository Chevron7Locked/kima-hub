/**
 * The M3U import matches an artist and a song by the name stored and by the name a person edited it to
 * (`displayName`, `displayTitle`), in every tier that compares names, the way the Spotify matcher does. Real database.
 *
 * - Tier 2 (the file name): a file whose artist or title agrees with the entry only by its shown name is the one found.
 * - Tier 3 (exact artist and title): a renamed artist and a retitled song match exactly, in every pairing of stored
 *   and shown. A namesake with a lower id and a near title would win the fuzzy tier, so the right song proves tier 3.
 * - Tier 4 (fuzzy): the shown title is scored as well as the stored one.
 */
import { prisma } from "../../utils/db";
import { artistIdentityKey } from "../artistIdentity";
import { m3uSongIds } from "../../__tests__/helpers/m3uImport";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

jest.setTimeout(120_000);

const P = "zz-m3u-shown";
const USER = `${P}-user`;

async function cleanup() {
    await prisma.playlist.deleteMany({ where: { userId: USER } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { identityKey: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { identityKey: { startsWith: artistIdentityKey(P) } } });
}

interface SongSeed {
    id: string;
    title: string;
    displayTitle?: string;
    filePath: string;
}

/** One library artist (`displayName` is its edited name) with the given songs, all on one album. */
async function seedArtist(key: string, name: string, displayName: string | undefined, songs: SongSeed[]) {
    const artist = await prisma.artist.create({
        data: { name, normalizedName: name.toLowerCase(), identityKey: artistIdentityKey(name), displayName },
    });
    const album = await prisma.album.create({
        data: { rgMbid: `${P}-${key}-rg`, identityKey: `${P}-${key}-album`, primaryType: "Album", title: `${P} ${key} album`, artistId: artist.id, location: "LIBRARY" },
    });
    for (const [n, song] of songs.entries()) {
        await prisma.track.create({
            data: { ...song, albumId: album.id, trackNo: n + 1, duration: 100, fileModified: new Date(), fileSize: 1 },
        });
    }
}

let m3uCount = 0;
const m3uMatch = async (artist: string | null, title: string | null, filePath = `/nowhere/${P}-${m3uCount + 1}.mp3`) => {
    const [first] = await m3uSongIds(USER, `${P}-m3u-${++m3uCount}`, [{ filePath, durationSeconds: null, artist, title }]);
    return first ?? null;
};

beforeAll(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
});

afterAll(async () => {
    await cleanup();
    await closeEngineConnections();
});

describe("tier 2: the file name, with the entry's artist or title agreeing by the shown name", () => {
    // The same file name in two folders; the decoy's id sorts first, and neither its artist nor its title is the entry's.
    const seedTwoFolders = async (key: string, shownArtist: boolean, shownTitle: boolean) => {
        await seedArtist(`${key}-decoy`, `${P}-${key}-decoy band`, undefined, [
            { id: `${P}-${key}-a-decoy`, title: `${P} ${key} decoy`, filePath: `/${P}/${key}/decoy/01 qz ${key}.mp3` },
        ]);
        await seedArtist(`${key}-real`, `${P}-${key}-real band`, shownArtist ? `${P}-${key}-real ensemble` : undefined, [
            {
                id: `${P}-${key}-b-real`,
                title: `${P} ${key} stored title`,
                displayTitle: shownTitle ? `${P} ${key} shown title` : undefined,
                filePath: `/${P}/${key}/real/01 qz ${key}.mp3`,
            },
        ]);
        return `${P}-${key}-b-real`;
    };

    it("an entry naming only the renamed artist finds that artist's file", async () => {
        const id = await seedTwoFolders("t2a", true, false);
        expect(await m3uMatch(`${P}-t2a-real ensemble`, null, "/elsewhere/01 qz t2a.mp3")).toBe(id);
    });

    it("an entry naming only the retitled song finds that song's file", async () => {
        const id = await seedTwoFolders("t2t", false, true);
        expect(await m3uMatch(null, `${P} t2t shown title`, "/elsewhere/01 qz t2t.mp3")).toBe(id);
    });

    it("an entry naming neither still finds nothing", async () => {
        await seedTwoFolders("t2n", true, true);
        expect(await m3uMatch(`${P}-t2n-other`, `${P} t2n other`, "/elsewhere/01 qz t2n.mp3")).toBeNull();
    });
});

describe("tier 3: exact artist and title", () => {
    // The wanted song's id sorts after a namesake of the same artist whose title is a near miss: the fuzzy tier would take
    // the namesake, so only the exact tier finds the wanted song.
    it.each([
        ["stored artist, shown title", false, true],
        ["shown artist, stored title", true, false],
        ["shown artist, shown title", true, true],
        ["stored artist, stored title", false, false],
    ])("%s", async (label, artistShown, titleShown) => {
        const key = `t3-${label.replace(/[ ,]+/g, "-")}`;
        const storedArtist = `${P}-${key} band`;
        const shownArtist = `${P}-${key} ensemble`;
        const storedTitle = `lorem ${key} stored`;
        const shownTitle = `ipsum ${key} shown`;
        await seedArtist(key, storedArtist, shownArtist, [
            { id: `${P}-${key}-a-decoy`, title: `${titleShown ? shownTitle : storedTitle} live`, filePath: `/${P}/${key}/decoy.mp3` },
            { id: `${P}-${key}-b-real`, title: storedTitle, displayTitle: shownTitle, filePath: `/${P}/${key}/real.mp3` },
        ]);
        expect(await m3uMatch(artistShown ? shownArtist : storedArtist, titleShown ? shownTitle : storedTitle)).toBe(`${P}-${key}-b-real`);
    });

    it("the exact tier folds case and accents of the shown names as it does the stored ones", async () => {
        const key = "t3-fold";
        await seedArtist(key, `${P}-fold band`, `${P}-Fóld Ensemble`, [
            { id: `${P}-${key}-a-decoy`, title: `${P} fold wanted live`, filePath: `/${P}/${key}/decoy.mp3` },
            { id: `${P}-${key}-b-real`, title: `${P} fold stored`, displayTitle: `${P} Fóld Wanted`, filePath: `/${P}/${key}/real.mp3` },
        ]);
        expect(await m3uMatch(`${P}-FOLD ENSEMBLE`, `${P} fold wanted`)).toBe(`${P}-${key}-b-real`);
    });
});

describe("tier 4: the fuzzy score", () => {
    it("scores the shown title as well as the stored one", async () => {
        const key = "t4";
        await seedArtist(key, `${P}-${key} band`, undefined, [
            { id: `${P}-${key}-song`, title: "unrelated words entirely", displayTitle: `${P} t4 shown wanted`, filePath: `/${P}/${key}/song.mp3` },
        ]);
        // A superset of the shown title's words, so it is no exact match, and none of the stored title's.
        expect(await m3uMatch(`${P}-${key} band`, `${P} t4 shown wanted again`)).toBe(`${P}-${key}-song`);
    });

    it("finds a song by an artist whose edited name alone holds the entry's first word, and by its edited title", async () => {
        const key = "t4s";
        await seedArtist(key, `${P}-${key}-stored band`, `${P}-${key}-shown ensemble`, [
            { id: `${P}-${key}-song`, title: "unrelated words entirely", displayTitle: `${P} t4s shown wanted`, filePath: `/${P}/${key}/song.mp3` },
        ]);
        // Neither the stored artist name nor the stored title is near the entry's.
        expect(await m3uMatch(`${P}-${key}-shown ensemble extra`, `${P} t4s shown wanted again`)).toBe(`${P}-${key}-song`);
    });

    it("an unrelated title still scores under the threshold", async () => {
        const key = "t4n";
        await seedArtist(key, `${P}-${key} band`, undefined, [
            { id: `${P}-${key}-song`, title: "unrelated words entirely", displayTitle: "also something else", filePath: `/${P}/${key}/song.mp3` },
        ]);
        expect(await m3uMatch(`${P}-${key} band`, `${P} t4n wanted`)).toBeNull();
    });
});

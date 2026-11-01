/**
 * The admin re-file: every library album is filed again by its files' own tags, by the scanner's album vote
 * (albumArtistVote.ts). An album under the wrong artist moves to the right one, and onto that artist's copy of it
 * when there is one, its ownership records with it; an artist left with nothing goes. Albums a person edited and
 * Discover albums are left alone. An artist that gains albums is asked again of MusicBrainz.
 * Real database, temp music folder, stand-in tags.
 */

jest.mock("../../utils/logger", () => require("./helpers/scannerMocks").loggerMock());
jest.mock("../../services/artistCountsService", () => require("./helpers/scannerMocks").artistCountsServiceMock());
const mockGetArtist = jest.fn();
jest.mock("../../services/musicbrainz", () => ({ musicBrainzService: { getArtist: (...a: unknown[]) => mockGetArtist(...a) } }));

import fs from "fs";
import os from "os";
import path from "path";
import { parseFile } from "music-metadata";
import { prisma } from "../../utils/db";
import { refileLibrary } from "../albumRefile";

jest.setTimeout(60_000);

const FULL_ID = "7c1d2e3f-0000-4000-8000-000000000001";
const REAL_RG = "7c1d2e3f-0000-4000-8000-0000000000a1";
const OTHER_RG = "7c1d2e3f-0000-4000-8000-0000000000a2";

let musicDir: string;
let tags: Map<string, unknown>;

async function wipe() {
    await prisma.$executeRawUnsafe(`DELETE FROM share_links WHERE token LIKE 'refile-%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "DiscoveryAlbum" WHERE "albumTitle" LIKE 'Refile%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE id = 'refile-user'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "OwnedAlbum" WHERE "artistId" IN (SELECT id FROM "Artist" WHERE name LIKE 'Refile%')`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE "filePath" LIKE 'Refile%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE title LIKE 'Refile%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE name LIKE 'Refile%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE name = 'Various Artists' AND NOT EXISTS (SELECT 1 FROM "Album" WHERE "artistId" = "Artist".id)`);
}

beforeEach(async () => {
    await wipe();
    musicDir = fs.mkdtempSync(path.join(os.tmpdir(), "refile-"));
    tags = new Map();
    mockGetArtist.mockReset();
    mockGetArtist.mockResolvedValue({ kind: "absent", evidence: {} });
    (parseFile as jest.Mock).mockReset();
    (parseFile as jest.Mock).mockImplementation(async (file: string) => {
        const found = tags.get(file);
        if (!found) throw new Error("unreadable");
        return found;
    });
});

afterEach(() => fs.rmSync(musicDir, { recursive: true, force: true }));

afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
});

let n = 0;
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

async function artist(name: string, extra: Record<string, unknown> = {}) {
    return prisma.artist.create({ data: { name, normalizedName: name.toLowerCase(), identityKey: key(name), ...extra } });
}

async function album(artistId: string, title: string, extra: Record<string, unknown> = {}) {
    return prisma.album.create({
        data: { artistId, title, identityKey: key(title), rgMbid: `temp-refile-${++n}`, primaryType: "Album", location: "LIBRARY", ...extra },
    });
}

/** A song on disk filed under `albumId`, whose tags say `common` (none: its tags cannot be read). */
async function song(albumId: string, rel: string, common: Record<string, unknown> | null) {
    const file = path.join(musicDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "dummy audio bytes");
    if (common) tags.set(file, { common: { track: { no: 1 }, disk: { no: 1 }, ...common }, format: {}, native: {} });
    return prisma.track.create({
        data: { albumId, title: rel, trackNo: 1, duration: 200, filePath: rel, fileModified: new Date(), fileSize: 17 },
    });
}

const own = (artistId: string, rgMbid: string, source = "native_scan") =>
    prisma.ownedAlbum.create({ data: { artistId, rgMbid, source } });

async function artistOf(rel: string) {
    return (await prisma.track.findUnique({ where: { filePath: rel }, select: { album: { select: { artist: { select: { name: true } } } } } }))!.album.artist.name;
}

async function filing(title: string) {
    const rows = await prisma.album.findMany({
        where: { title },
        select: { rgMbid: true, artist: { select: { name: true } }, _count: { select: { tracks: true } } },
    });
    return rows.map((r) => ({ artist: r.artist.name, rgMbid: r.rgMbid, songs: r._count.tracks }));
}

describe("re-filing albums by their tags", () => {
    it("moves an album from a cut-off name to the artist its files name, ownership included", async () => {
        const cut = await artist("Refile Cut");
        const full = await artist("Refile Cut and Band", { mbid: FULL_ID });
        const a = await album(cut.id, "Refile Album", { rgMbid: REAL_RG });
        await own(cut.id, REAL_RG);
        for (const i of [1, 2]) {
            await song(a.id, `Refile Cut and Band/Refile Album/0${i}.flac`, {
                album: "Refile Album", albumartist: "Refile Cut and Band", musicbrainz_albumartistid: [FULL_ID],
            });
        }

        const result = await refileLibrary(musicDir);

        expect(await filing("Refile Album")).toEqual([{ artist: "Refile Cut and Band", rgMbid: REAL_RG, songs: 2 }]);
        expect(await prisma.ownedAlbum.findMany({ where: { rgMbid: REAL_RG }, select: { artistId: true } })).toEqual([{ artistId: full.id }]);
        expect(await prisma.artist.count({ where: { name: "Refile Cut" } })).toBe(0);
        expect(result.albumsMoved).toBe(1);
    });

    it("merges an album onto the right artist's copy of it, keeping the row with a real id", async () => {
        const cut = await artist("Refile Cut");
        const full = await artist("Refile Cut and Band", { mbid: FULL_ID });
        const stray = await album(cut.id, "Refile Twin", { rgMbid: REAL_RG });
        const kept = await album(full.id, "Refile Twin");
        await own(cut.id, REAL_RG, "discovery_liked");
        await own(full.id, kept.rgMbid);
        await song(stray.id, "Refile Cut and Band/Refile Twin/01.flac", { album: "Refile Twin", artist: "Refile Cut & Band" });
        for (const i of [2, 3, 4]) {
            await song(kept.id, `Refile Cut and Band/Refile Twin/0${i}.flac`, {
                album: "Refile Twin", albumartist: "Refile Cut and Band", musicbrainz_albumartistid: [FULL_ID],
            });
        }

        const result = await refileLibrary(musicDir);

        expect(await filing("Refile Twin")).toEqual([{ artist: "Refile Cut and Band", rgMbid: REAL_RG, songs: 4 }]);
        // The stronger ownership source survives on the merged album.
        expect(await prisma.ownedAlbum.findMany({ where: { artistId: full.id }, select: { rgMbid: true, source: true } })).toEqual([
            { rgMbid: REAL_RG, source: "native_scan" },
        ]);
        expect(await prisma.album.count({ where: { id: kept.id } }) + (await prisma.album.count({ where: { id: stray.id } }))).toBe(1);
        expect(result.albumsMerged).toBe(1);
    });

    it("does not ask MusicBrainz again about a placeholder artist that gains an album", async () => {
        await prisma.artist.upsert({
            where: { identityKey: "variousartists" },
            update: { enrichmentStatus: "unresolvable", enrichmentFailures: 3 },
            create: { name: "Various Artists", normalizedName: "various artists", identityKey: "variousartists", enrichmentStatus: "unresolvable", enrichmentFailures: 3 },
        });
        const wrong = await artist("Refile Wrong");
        const a = await album(wrong.id, "Refile Placeholder Album");
        await song(a.id, "Refile Mixes/Refile Placeholder Album/01.flac", { album: "Refile Placeholder Album", albumartist: "Various Artists" });

        await refileLibrary(musicDir);

        expect(await prisma.artist.findUnique({ where: { identityKey: "variousartists" }, select: { enrichmentStatus: true, enrichmentFailures: true } }))
            .toEqual({ enrichmentStatus: "unresolvable", enrichmentFailures: 3 });
    });

    it("does not ask MusicBrainz again about an artist that only gains songs on an album it has", async () => {
        const mike = await artist("Refile Mike", { enrichmentStatus: "unresolvable", enrichmentFailures: 3 });
        const janet = await artist("Refile Janet");
        const main = await album(mike.id, "Refile Known");
        const split = await album(janet.id, "Refile Known");
        await song(main.id, "Refile Mike/Refile Known/01.flac", { album: "Refile Known", albumartist: "Refile Mike" });
        await song(main.id, "Refile Mike/Refile Known/02.flac", { album: "Refile Known", albumartist: "Refile Mike" });
        await song(split.id, "Refile Mike/Refile Known/03.flac", { album: "Refile Known", albumartist: "Refile Janet" });

        await refileLibrary(musicDir);

        expect(await prisma.track.count({ where: { albumId: main.id } })).toBe(3);
        expect(await prisma.artist.findUnique({ where: { id: mike.id }, select: { enrichmentStatus: true } })).toEqual({ enrichmentStatus: "unresolvable" });
    });

    it("puts a lone song tagged with a guest as album artist back on its album", async () => {
        const mike = await artist("Refile Mike");
        const janet = await artist("Refile Janet", { enrichmentStatus: "unresolvable" });
        const main = await album(mike.id, "Refile History");
        const split = await album(janet.id, "Refile History");
        for (const i of [1, 2, 3]) {
            await song(main.id, `Refile Mike/Refile History/CD 2/0${i}.flac`, { album: "Refile History", albumartist: "Refile Mike" });
        }
        await song(split.id, "Refile Mike/Refile History/CD 2/04.flac", { album: "Refile History", albumartist: "Refile Janet" });

        await refileLibrary(musicDir);

        expect(await filing("Refile History")).toEqual([{ artist: "Refile Mike", rgMbid: main.rgMbid, songs: 4 }]);
        expect(await prisma.artist.count({ where: { name: "Refile Janet" } })).toBe(0);
    });

    it("asks MusicBrainz again about an artist that gains an album", async () => {
        const cut = await artist("Refile Cut");
        const full = await artist("Refile Cut and Band", { enrichmentStatus: "unresolvable", enrichmentFailures: 3 });
        const a = await album(cut.id, "Refile Gain");
        await song(a.id, "Refile Cut and Band/Refile Gain/01.flac", { album: "Refile Gain", albumartist: "Refile Cut and Band" });

        await refileLibrary(musicDir);

        expect(await prisma.artist.findUnique({ where: { id: full.id }, select: { enrichmentStatus: true, enrichmentFailures: true } }))
            .toEqual({ enrichmentStatus: "pending", enrichmentFailures: 0 });
    });

    it("leaves an album a person edited, and Discover's albums, where they are", async () => {
        const cut = await artist("Refile Cut");
        const edited = await album(cut.id, "Refile Edited", { hasUserOverrides: true });
        const discover = await album(cut.id, "Refile Discover", { location: "DISCOVER" });
        await song(edited.id, "Refile Elsewhere/Refile Edited/01.flac", { album: "Refile Edited", albumartist: "Refile Other" });
        await song(discover.id, "Refile Elsewhere/Refile Discover/01.flac", { album: "Refile Discover", albumartist: "Refile Other" });

        const result = await refileLibrary(musicDir);

        expect(await filing("Refile Edited")).toEqual([{ artist: "Refile Cut", rgMbid: edited.rgMbid, songs: 1 }]);
        expect(await filing("Refile Discover")).toEqual([{ artist: "Refile Cut", rgMbid: discover.rgMbid, songs: 1 }]);
        expect(await prisma.artist.count({ where: { name: "Refile Other" } })).toBe(0);
        expect(result.keptEdited).toBe(1);
    });

    it("changes nothing when every album is already where its tags say", async () => {
        const band = await artist("Refile Band");
        const a = await album(band.id, "Refile Settled");
        await song(a.id, "Refile Band/Refile Settled/01.flac", { album: "Refile Settled", albumartist: "Refile Band" });

        const result = await refileLibrary(musicDir);

        expect(result).toMatchObject({ albumsMoved: 0, albumsMerged: 0, artistsRemoved: 0 });
        expect(await filing("Refile Settled")).toEqual([{ artist: "Refile Band", rgMbid: a.rgMbid, songs: 1 }]);
    });

    it("never deletes or adds to the right artist's own copy when it was edited", async () => {
        const cut = await artist("Refile Cut");
        const full = await artist("Refile Cut and Band", { mbid: FULL_ID });
        const stray = await album(cut.id, "Refile Edited Twin", { rgMbid: REAL_RG });
        const edited = await album(full.id, "Refile Edited Twin", { hasUserOverrides: true, userCoverUrl: "/mine.jpg" });
        await song(stray.id, "Refile Cut and Band/Refile Edited Twin/01.flac", { album: "Refile Edited Twin", albumartist: "Refile Cut and Band", musicbrainz_albumartistid: [FULL_ID] });
        await song(edited.id, "Refile Cut and Band/Refile Edited Twin/02.flac", { album: "Refile Edited Twin", albumartist: "Refile Cut and Band", musicbrainz_albumartistid: [FULL_ID] });

        await refileLibrary(musicDir);

        // Nothing joins an album a person edited: it keeps its cover, id and songs, and the stray copy stays as it is.
        const kept = await prisma.album.findUnique({ where: { id: edited.id }, select: { userCoverUrl: true, rgMbid: true, _count: { select: { tracks: true } } } });
        expect(kept).toEqual({ userCoverUrl: "/mine.jpg", rgMbid: edited.rgMbid, _count: { tracks: 1 } });
        expect(await prisma.album.count({ where: { id: stray.id } })).toBe(1);
    });

    it("moves only an album's own songs off a row it shares with another album, in either order", async () => {
        for (const [first, second] of [["A", "B"], ["B", "A"]]) {
            await wipe();
            const mixed = await artist("Refile Mixed");
            const tee = await artist("Refile Tee");
            const shared = await album(mixed.id, "Refile Shared");
            await song(shared.id, `Refile ${first}/Refile Shared/01.flac`, { album: "Refile Shared", albumartist: "Refile Tee" });
            await song(shared.id, `Refile ${second}/Refile Shared/01.flac`, { album: "Refile Shared", albumartist: "Refile You" });

            await refileLibrary(musicDir);

            expect(await artistOf(`Refile ${first}/Refile Shared/01.flac`)).toBe("Refile Tee");
            expect(await artistOf(`Refile ${second}/Refile Shared/01.flac`)).toBe("Refile You");
            expect(await prisma.artist.count({ where: { id: mixed.id } })).toBe(0);
            // A new row gets its ownership record, as a scanned album does.
            const owned = await prisma.ownedAlbum.findMany({ where: { artistId: tee.id }, select: { source: true } });
            expect(owned).toEqual([{ source: "native_scan" }]);
        }
    });

    it("carries another artist's ownership, Discover's records and the album's details onto the surviving album", async () => {
        const cut = await artist("Refile Cut");
        const full = await artist("Refile Cut and Band", { mbid: FULL_ID });
        const guest = await artist("Refile Guest");
        await song((await album(guest.id, "Refile Guest Own")).id, "Refile Guest/Refile Guest Own/01.flac", { album: "Refile Guest Own", albumartist: "Refile Guest" });
        const stray = await album(cut.id, "Refile Details", { rgMbid: OTHER_RG, coverUrl: "/cover.jpg", year: 1999, label: "Refile Label" });
        const kept = await album(full.id, "Refile Details", { rgMbid: REAL_RG });
        await own(guest.id, OTHER_RG);
        await prisma.user.create({ data: { id: "refile-user", username: "refile-user", passwordHash: "x" } });
        await prisma.discoveryAlbum.create({
            data: { userId: "refile-user", rgMbid: OTHER_RG, artistName: "Refile Cut", albumTitle: "Refile Details", weekStartDate: new Date("2026-10-26") },
        });
        await song(stray.id, "Refile Cut and Band/Refile Details/01.flac", { album: "Refile Details", albumartist: "Refile Cut and Band", musicbrainz_albumartistid: [FULL_ID] });
        await song(kept.id, "Refile Cut and Band/Refile Details/02.flac", { album: "Refile Details", albumartist: "Refile Cut and Band", musicbrainz_albumartistid: [FULL_ID] });

        await refileLibrary(musicDir);

        expect(await prisma.album.findUnique({ where: { id: kept.id }, select: { coverUrl: true, year: true, label: true, rgMbid: true } }))
            .toEqual({ coverUrl: "/cover.jpg", year: 1999, label: "Refile Label", rgMbid: REAL_RG });
        expect(await prisma.ownedAlbum.findMany({ where: { artistId: guest.id, rgMbid: { in: [REAL_RG, OTHER_RG] } }, select: { rgMbid: true } })).toEqual([{ rgMbid: REAL_RG }]);
        expect(await prisma.discoveryAlbum.findMany({ where: { albumTitle: "Refile Details" }, select: { rgMbid: true } })).toEqual([{ rgMbid: REAL_RG }]);
    });

    it("leaves an album alone when one of its songs cannot be read", async () => {
        const cut = await artist("Refile Cut");
        await artist("Refile Cut and Band", { mbid: FULL_ID });
        const a = await album(cut.id, "Refile Unread");
        await song(a.id, "Refile Cut and Band/Refile Unread/01.flac", { album: "Refile Unread", albumartist: "Refile Cut and Band", musicbrainz_albumartistid: [FULL_ID] });
        await song(a.id, "Refile Cut and Band/Refile Unread/02.flac", null);

        const result = await refileLibrary(musicDir);

        expect(await filing("Refile Unread")).toEqual([{ artist: "Refile Cut", rgMbid: a.rgMbid, songs: 2 }]);
        expect(result.songsUnreadable).toBe(1);
    });

    it("counts an album it could not re-file and still re-files the rest", async () => {
        const identity = jest.requireActual("../artistIdentity");
        const real = identity.resolveArtist;
        const spy = jest.spyOn(identity, "resolveArtist").mockImplementation(async (...args: any[]) => {
            if (args[1].name === "Refile Broken") throw new Error("boom");
            return real(...args);
        });
        try {
            const cut = await artist("Refile Cut");
            const a = await album(cut.id, "Refile Breaks");
            const b = await album(cut.id, "Refile Works");
            await song(a.id, "Refile Broken/Refile Breaks/01.flac", { album: "Refile Breaks", albumartist: "Refile Broken" });
            await song(b.id, "Refile Fine/Refile Works/01.flac", { album: "Refile Works", albumartist: "Refile Fine" });

            const result = await refileLibrary(musicDir);

            expect(result.albumsFailed).toBe(1);
            expect(await artistOf("Refile Fine/Refile Works/01.flac")).toBe("Refile Fine");
            expect(await artistOf("Refile Broken/Refile Breaks/01.flac")).toBe("Refile Cut");
        } finally {
            spy.mockRestore();
        }
    });

    it("changes nothing on a second run", async () => {
        const cut = await artist("Refile Cut");
        await artist("Refile Cut and Band", { mbid: FULL_ID });
        const a = await album(cut.id, "Refile Twice", { rgMbid: REAL_RG });
        await song(a.id, "Refile Cut and Band/Refile Twice/01.flac", { album: "Refile Twice", albumartist: "Refile Cut and Band", musicbrainz_albumartistid: [FULL_ID] });

        expect((await refileLibrary(musicDir)).albumsMoved).toBe(1);
        expect(await refileLibrary(musicDir)).toMatchObject({ albumsMoved: 0, albumsMerged: 0, keptEdited: 0, albumsFailed: 0 });
    });

    it("renames a name the old splitter cut when it holds the files' MusicBrainz id, folding the full-name row into it", async () => {
        mockGetArtist.mockResolvedValue({ kind: "answered", value: { name: "Refile Cut and Band", aliases: [] }, evidence: {} });
        const cut = await artist("Refile Cut", { mbid: FULL_ID });
        const full = await artist("Refile Cut and Band");
        const a = await album(cut.id, "Refile Under Cut", { rgMbid: REAL_RG });
        const both1 = await album(cut.id, "Refile Both");
        const b = await album(full.id, "Refile Under Full");
        const both2 = await album(full.id, "Refile Both");
        await own(cut.id, REAL_RG);
        const tagged = { albumartist: "REFILE CUT AND BAND", musicbrainz_albumartistid: [FULL_ID] };
        await song(a.id, "Refile Cut and Band/Refile Under Cut/01.flac", { album: "Refile Under Cut", ...tagged });
        await song(both1.id, "Refile Cut and Band/Refile Both/01.flac", { album: "Refile Both", ...tagged });
        await song(b.id, "Refile Cut and Band/Refile Under Full/01.flac", { album: "Refile Under Full", ...tagged });
        await song(both2.id, "Refile Cut and Band/Refile Both/02.flac", { album: "Refile Both", ...tagged });

        const result = await refileLibrary(musicDir);

        const renamed = await prisma.artist.findUnique({ where: { id: cut.id }, select: { name: true, mbid: true, identityKey: true } });
        expect(renamed).toEqual({ name: "Refile Cut and Band", mbid: FULL_ID, identityKey: "refilecutandband" });
        expect(await prisma.artist.count({ where: { id: full.id } })).toBe(0);
        for (const title of ["Refile Under Cut", "Refile Under Full"]) {
            expect((await filing(title)).map((f) => f.artist)).toEqual(["Refile Cut and Band"]);
        }
        expect(await filing("Refile Both")).toEqual([expect.objectContaining({ artist: "Refile Cut and Band", songs: 2 })]);
        expect(await prisma.ownedAlbum.findMany({ where: { rgMbid: REAL_RG }, select: { artistId: true } })).toEqual([{ artistId: cut.id }]);
        expect(result.artistsRenamed).toBe(1);
    });

    it("keeps an artist's name when the files' name differs in any other way", async () => {
        const named = await artist("Refile Kino", { mbid: FULL_ID });
        const a = await album(named.id, "Refile Gruppa");
        await song(a.id, "Refile Kino/Refile Gruppa/01.flac", { album: "Refile Gruppa", albumartist: "Refile Кино", musicbrainz_albumartistid: [FULL_ID] });

        const result = await refileLibrary(musicDir);

        expect(await prisma.artist.findUnique({ where: { id: named.id }, select: { name: true } })).toEqual({ name: "Refile Kino" });
        expect(await filing("Refile Gruppa")).toEqual([expect.objectContaining({ artist: "Refile Kino" })]);
        expect(result.artistsRenamed).toBe(0);
    });

    it("renames nothing unless MusicBrainz confirms the full name is that id's", async () => {
        // The files carry the id of the artist "Refile Cut" under the name "Refile Cut and Band": a wrong tag.
        const cut = await artist("Refile Cut", { mbid: FULL_ID });
        const a = await album(cut.id, "Refile Mistagged");
        await song(a.id, "Refile Cut and Band/Refile Mistagged/01.flac", { album: "Refile Mistagged", albumartist: "Refile Cut and Band", musicbrainz_albumartistid: [FULL_ID] });

        mockGetArtist.mockResolvedValue({ kind: "answered", value: { name: "Refile Cut", aliases: [] }, evidence: {} });
        expect((await refileLibrary(musicDir)).artistsRenamed).toBe(0);
        mockGetArtist.mockResolvedValue({ kind: "transient", error: { message: "down" } });
        expect((await refileLibrary(musicDir)).artistsRenamed).toBe(0);
        expect(await prisma.artist.findUnique({ where: { id: cut.id }, select: { name: true } })).toEqual({ name: "Refile Cut" });
    });

    it("renames nothing when the full-name row's copy of an album was edited or is Discover's", async () => {
        mockGetArtist.mockResolvedValue({ kind: "answered", value: { name: "Refile Cut and Band", aliases: [] }, evidence: {} });
        const cut = await artist("Refile Cut", { mbid: FULL_ID });
        const full = await artist("Refile Cut and Band");
        const held = await album(cut.id, "Refile Held", { hasUserOverrides: true });
        const twin = await album(full.id, "Refile Held");
        await song(held.id, "Refile Cut and Band/Refile Held/01.flac", { album: "Refile Held", albumartist: "Refile Cut and Band", musicbrainz_albumartistid: [FULL_ID] });
        await song(twin.id, "Refile Cut and Band/Refile Held/02.flac", { album: "Refile Held", albumartist: "Refile Cut and Band", musicbrainz_albumartistid: [FULL_ID] });

        const result = await refileLibrary(musicDir);

        expect(result.artistsRenamed).toBe(0);
        expect(await prisma.artist.findUnique({ where: { id: cut.id }, select: { name: true } })).toEqual({ name: "Refile Cut" });
        expect(await prisma.album.count({ where: { id: { in: [held.id, twin.id] } } })).toBe(2);
    });

    it("merges nothing into the id holder's Discover copy either", async () => {
        mockGetArtist.mockResolvedValue({ kind: "answered", value: { name: "Refile Cut and Band", aliases: [] }, evidence: {} });
        const cut = await artist("Refile Cut", { mbid: FULL_ID });
        const full = await artist("Refile Cut and Band");
        const held = await album(cut.id, "Refile Held", { location: "DISCOVER" });
        await song(held.id, "Refile Elsewhere/Refile Held/01.flac", null);
        const twin = await album(full.id, "Refile Held");
        await song(twin.id, "Refile Cut and Band/Refile Held/02.flac", { album: "Refile Held", albumartist: "Refile Cut and Band", musicbrainz_albumartistid: [FULL_ID] });

        await refileLibrary(musicDir);

        expect(await prisma.album.count({ where: { id: { in: [held.id, twin.id] } } })).toBe(2);
        expect(await prisma.track.count({ where: { albumId: held.id } })).toBe(1);
    });

    it("leaves an album under its lead artist when the files name a joint credit with no MusicBrainz id", async () => {
        const lead = await artist("Refile Lead", { mbid: FULL_ID });
        const a = await album(lead.id, "Refile Duet");
        await song(a.id, "Refile Lead/Refile Duet/01.flac", { album: "Refile Duet", albumartist: "Refile Lead & Refile Guest" });

        const result = await refileLibrary(musicDir);

        expect(await filing("Refile Duet")).toEqual([expect.objectContaining({ artist: "Refile Lead" })]);
        expect(await prisma.artist.count({ where: { name: "Refile Lead & Refile Guest" } })).toBe(0);
        expect(result.albumsMoved + result.albumsMerged).toBe(0);
    });

    it("keeps an album whose songs sit in several folders under the artist they name", async () => {
        const ein = await artist("Refile Einaudi", { mbid: FULL_ID });
        const traitors = await album(ein.id, "Refile Traitors", { rgMbid: REAL_RG });
        for (const folder of ["Refile Einaudi/Experience (2024)", "Refile Einaudi/Like A Breath (2023)", "Refile Einaudi/Music of Care (2023)"]) {
            await song(traitors.id, `${folder}/07.mp3`, {
                album: "Refile Traitors", albumartist: "Refile Einaudi", albumartists: ["Refile Einaudi"], artist: "Refile Einaudi", compilation: true,
            });
        }

        await refileLibrary(musicDir);

        expect(await filing("Refile Traitors")).toEqual([{ artist: "Refile Einaudi", rgMbid: REAL_RG, songs: 3 }]);
    });

    it("moves an album off an id-less artist row when another row holds the files' MusicBrainz id", async () => {
        const idless = await artist("Refile Dup");
        const holder = await artist("Refile Dup Alias", { mbid: FULL_ID });
        const a1 = await album(idless.id, "Refile Twin");
        const a2 = await album(holder.id, "Refile Twin");
        const credit = { album: "Refile Twin", albumartist: "Refile Dup", musicbrainz_albumartistid: [FULL_ID] };
        await song(a1.id, "Refile Dup/Refile Twin/01.flac", credit);
        await song(a1.id, "Refile Dup/Refile Twin/02.flac", credit);
        await song(a2.id, "Refile Dup/Refile Twin/03.flac", credit);

        await refileLibrary(musicDir);

        expect(await filing("Refile Twin")).toEqual([expect.objectContaining({ artist: "Refile Dup Alias", songs: 3 })]);
    });

    it("points an album's share link at the surviving album when the re-file merges the album row away", async () => {
        const cut = await artist("Refile Cut");
        const full = await artist("Refile Cut and Band", { mbid: FULL_ID });
        const stray = await album(cut.id, "Refile Share");
        const kept = await album(full.id, "Refile Share");
        await prisma.user.create({ data: { id: "refile-user", username: "refile-user", passwordHash: "x" } });
        await prisma.shareLink.create({ data: { token: "refile-tok", entityType: "album", entityId: stray.id, createdBy: "refile-user" } });
        const credit = { album: "Refile Share", albumartist: "Refile Cut and Band", musicbrainz_albumartistid: [FULL_ID] };
        await song(stray.id, "Refile Cut and Band/Refile Share/01.flac", credit);
        await song(kept.id, "Refile Cut and Band/Refile Share/02.flac", credit);

        await refileLibrary(musicDir);

        expect(await prisma.album.count({ where: { id: stray.id } })).toBe(0);
        expect((await prisma.shareLink.findUnique({ where: { token: "refile-tok" } }))!.entityId).toBe(kept.id);
    });

    it("breaks a vote tie by path order in code, whatever order the database sorts paths in", async () => {
        const x = await artist("Refile Tie Wrong");
        const a = await album(x.id, "Refile Tie");
        const credit = (name: string) => ({ album: "Refile Tie", albumartist: name });
        // In code (and the C collation) capitals sort before lowercase, so Refile Tie First is named first.
        for (const f of ["B1", "B2"]) await song(a.id, `Refile Tie/${f}.flac`, credit("Refile Tie First"));
        for (const f of ["a1", "a2"]) await song(a.id, `Refile Tie/${f}.flac`, credit("Refile Tie Second"));
        // A database collating like en_US hands the paths back as a1, a2, B1, B2.
        const real = prisma.track.findMany.bind(prisma.track) as (args: any) => Promise<any[]>;
        const spy = jest.spyOn(prisma.track, "findMany").mockImplementation(((args: any) =>
            real(args).then((rows) => (args?.where?.missingSince === null ? [...rows].sort((p, q) => p.filePath.localeCompare(q.filePath, "en")) : rows))) as any);
        try {
            await refileLibrary(musicDir);
        } finally {
            spy.mockRestore();
        }

        expect((await filing("Refile Tie")).map((r) => r.artist)).toEqual(["Refile Tie First"]);
    });

    it("keeps a one-artist album with a stray compilation flag and no album artist under its artist", async () => {
        const solo = await artist("Refile Solo");
        const a = await album(solo.id, "Refile Solo Album");
        for (const i of [1, 2, 3]) await song(a.id, `Refile Solo/Refile Solo Album/0${i}.flac`, { album: "Refile Solo Album", artist: "Refile Solo", compilation: true });

        await refileLibrary(musicDir);

        expect(await filing("Refile Solo Album")).toEqual([expect.objectContaining({ artist: "Refile Solo", songs: 3 })]);
    });
});

/**
 * What the shown-names work (ticket 94) left over, on the real routers and the suite database:
 * - getGenres counts a genre's albums and songs from the songs that play, as every other Subsonic list does, not from
 *   the artist's cached counts.
 * - getLyrics answers with the best match: a song that has lyrics first, then the exact title as shown, then id.
 * - A playlist import finds an artist by the name shown too.
 * - getLyrics finds a title apart from accents ("cafe" finds "Café"), as the rest of the import and the name keys fold.
 * - A playlist import's title and album checks fold case, accents and punctuation like the rest of the import.
 * - A playlist import reads the shown artist names once, however many songs it matches.
 * - getArtists' lastModified is when the library a client lists last changed: a person's edit of a shown name moves it;
 *   a Discover song or an analysis write does not; it never goes backwards. (A scan's part is in
 *   workers/processors/__tests__/scanProcessor.libraryChanged.test.ts.)
 */

import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import { searchRouter } from "../search";
import { libraryRouter } from "../library";
import { playbackRouter } from "../playback";
import enrichmentRouter from "../../enrichment";
import { spotifyImportService, mergeEditionTracks } from "../../../services/spotifyImport";
import { markLibraryChanged } from "../../../services/libraryChanged";
import { generateToken } from "../../../middleware/auth";
import { mountAsServer } from "../../__tests__/helpers/serverMount";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";

jest.setTimeout(120_000);

const P = "zzg98";
const USER = `${P}-user`;
const ADMIN = `${P}-admin`;

const app = express()
    .use((req: any, _res, next) => { req.user = { id: USER, username: USER, role: "user" }; next(); })
    .use("/", searchRouter, libraryRouter, playbackRouter);

const enrichmentApp = express();
enrichmentApp.use(express.json());
mountAsServer(enrichmentApp, "/enrichment", enrichmentRouter, "/api/enrichment");
const asAdmin = `Bearer ${generateToken({ id: ADMIN, username: ADMIN, role: "admin", tokenVersion: 0 })}`;

const ask = (view: string, query: Record<string, string>) =>
    request(app).get(`/${view}.view`).query({ f: "json", ...query }).expect(200).then((r) => r.body["subsonic-response"]);
const list = <T>(x: T | T[] | undefined): T[] => (x === undefined ? [] : [x].flat() as T[]);

interface SongSeed {
    id: string;
    title: string;
    shown?: string;
    lyrics?: string;
    missing?: boolean;
    corrupt?: boolean;
}

/** An artist with albums of songs, as given. */
async function seedArtist(o: {
    id: string; name: string; shown?: string; genres?: string[]; cached?: { albums: number; songs: number };
    albums: { id: string; discover?: boolean; songs: SongSeed[] }[];
}) {
    await prisma.artist.create({
        data: {
            id: o.id, name: o.name, displayName: o.shown ?? null, normalizedName: o.name.toLowerCase(), identityKey: `${o.id}-ik`,
            sortName: o.name.toLowerCase(), genres: o.genres ?? [],
            libraryAlbumCount: o.cached?.albums ?? 1, totalTrackCount: o.cached?.songs ?? 1,
        },
    });
    for (const album of o.albums) {
        await prisma.album.create({
            data: {
                id: album.id, rgMbid: `${album.id}-rg`, identityKey: album.id, artistId: o.id, title: `${P} album ${album.id}`,
                primaryType: "Album", location: album.discover ? "DISCOVER" : "LIBRARY", year: 2005,
            },
        });
        let n = 0;
        for (const s of album.songs) {
            await prisma.track.create({
                data: {
                    id: s.id, albumId: album.id, title: s.title, displayTitle: s.shown ?? null, trackNo: ++n, duration: 100,
                    filePath: `${s.id}.flac`, fileModified: new Date(), fileSize: 1, mime: "FLAC",
                    ...(s.missing ? { missingSince: new Date() } : {}),
                    corrupt: !!s.corrupt,
                },
            });
            if (s.lyrics) await prisma.trackLyrics.create({ data: { track_id: s.id, plain_lyrics: s.lyrics, source: "test" } });
        }
    }
}

async function cleanup() {
    await prisma.playlist.deleteMany({ where: { userId: USER } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: { in: [USER, ADMIN] } } });
}

beforeAll(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
    await prisma.user.create({ data: { id: ADMIN, username: ADMIN, passwordHash: "x", role: "admin", tokenVersion: 0 } });

    // Genre: the cached counts say 9 albums and 99 songs; what plays is 2 songs on 1 album. The Discover album, the
    // missing files and the corrupt file count for nothing. A second artist whose cache says none has one song.
    await seedArtist({
        id: `${P}-gen-a`, name: `${P} genreband a`, genres: [`${P} noir`], cached: { albums: 9, songs: 99 },
        albums: [
            { id: `${P}-gen-a1`, songs: [{ id: `${P}-gen-a1s1`, title: "one" }, { id: `${P}-gen-a1s2`, title: "two" }, { id: `${P}-gen-a1s3`, title: "gone", missing: true }, { id: `${P}-gen-a1s4`, title: "bad", corrupt: true }] },
            { id: `${P}-gen-a2`, songs: [{ id: `${P}-gen-a2s1`, title: "lost", missing: true }] },
            { id: `${P}-gen-a3`, discover: true, songs: [{ id: `${P}-gen-a3s1`, title: "suggested" }] },
        ],
    });
    await seedArtist({
        id: `${P}-gen-b`, name: `${P} genreband b`, genres: [`${P} noir`], cached: { albums: 0, songs: 0 },
        albums: [{ id: `${P}-gen-b1`, songs: [{ id: `${P}-gen-b1s1`, title: "three" }] }],
    });

    // Lyrics. Ids sort a0s < a1s < a2s and b0s < b1s. The longer title has the smaller id, so an order by id alone is wrong.
    await seedArtist({
        id: `${P}-lyr`, name: `${P} lyricband`, shown: `${P} lyricshown`,
        albums: [
            { id: `${P}-lyr-a0`, songs: [{ id: `${P}-lyr-a0s`, title: `${P} tune extended`, lyrics: "the extended lyrics" }] },
            { id: `${P}-lyr-a1`, songs: [{ id: `${P}-lyr-a1s`, title: `${P} tune` }] },
            { id: `${P}-lyr-a2`, songs: [{ id: `${P}-lyr-a2s`, title: `${P} tune`, lyrics: "the tune lyrics" }] },
            { id: `${P}-lyr-b0`, songs: [{ id: `${P}-lyr-b0s`, title: `${P} zeta shown extra`, lyrics: "the extra lyrics" }] },
            { id: `${P}-lyr-b1`, songs: [{ id: `${P}-lyr-b1s`, title: `${P} zeta file`, shown: `${P} zeta shown`, lyrics: "the shown lyrics" }] },
            { id: `${P}-lyr-c`, songs: [{ id: `${P}-lyr-cs`, title: `${P} mute` }] },
            // The exact title has the smaller id and no lyrics; the longer one holds the words.
            { id: `${P}-lyr-f`, songs: [{ id: `${P}-lyr-fs`, title: `${P} ballad` }] },
            { id: `${P}-lyr-g`, songs: [{ id: `${P}-lyr-gs`, title: `${P} ballad reprise`, lyrics: "the reprise lyrics" }] },
            { id: `${P}-lyr-d`, songs: [{ id: `${P}-lyr-ds`, title: `${P} Café Tune`, lyrics: "the café lyrics" }, { id: `${P}-lyr-es`, title: `${P} plain song`, lyrics: "the plain lyrics" }] },
        ],
    });
    // The artist is matched whole: this one's name holds the other's.
    await seedArtist({
        id: `${P}-lyr-long`, name: `${P} lyricband and friends`,
        albums: [{ id: `${P}-lyr-long1`, songs: [{ id: `${P}-lyr-long1s`, title: `${P} tune`, lyrics: "the friends lyrics" }] }],
    });

    // Import: one artist whose shown name and file name share no word, and a decoy with the same song title.
    await seedArtist({
        id: `${P}-imp-decoy`, name: `${P}decoy band`,
        albums: [{ id: `${P}-imp-decoy1`, songs: [{ id: `${P}-imp-decoy1s`, title: `${P} import song` }] }],
    });
    await seedArtist({
        id: `${P}-imp`, name: `${P}rawfile band`, shown: `Quillon Vesper Choir`,
        albums: [{ id: `${P}-imp-1`, songs: [{ id: `${P}-imp-1s`, title: `${P} import song` }, { id: `${P}-imp-1h`, title: "Hymn" }] }],
    });
});

afterAll(async () => {
    await cleanup();
    await closeEngineConnections();
    await prisma.$disconnect();
});

describe("getGenres counts what plays", () => {
    it("counts a genre's songs and albums from playable songs on library albums, whatever the cached counts say", async () => {
        const body = await ask("getGenres", {});
        const noir = list<any>(body.genres.genre).find((g) => g.value === `${P} noir`);
        expect(noir).toMatchObject({ songCount: 3, albumCount: 2 });
    });
});

describe("getLyrics picks the best match", () => {
    const lyricsOf = async (query: Record<string, string>) => (await ask("getLyrics", query)).lyrics;

    it("takes a song with lyrics, then the exact title over a longer one that holds it", async () => {
        // Four songs hold "tune": the longer title (smallest id, has lyrics), then two exact ones, the first with none.
        expect(await lyricsOf({ artist: `${P} lyricband`, title: `${P} tune` })).toMatchObject({ value: "the tune lyrics" });
    });

    it("counts the exact title as shown", async () => {
        // The song titled "zeta shown extra" has the smaller id; the one shown as "zeta shown" is the exact match.
        expect(await lyricsOf({ artist: `${P} lyricband`, title: `${P} zeta shown` })).toMatchObject({ value: "the shown lyrics" });
    });

    it("still answers with the longer title when it is the only match", async () => {
        expect(await lyricsOf({ artist: `${P} lyricband`, title: `${P} tune ext` })).toMatchObject({ value: "the extended lyrics" });
    });

    it("keeps matching the artist whole, by the file's name or the shown one", async () => {
        expect(await lyricsOf({ artist: `${P} lyricshown`, title: `${P} tune` })).toMatchObject({ value: "the tune lyrics" });
        expect(await lyricsOf({ artist: `${P} lyric`, title: `${P} tune` })).toEqual({});
        expect(await lyricsOf({ artist: `${P} lyricband and friends`, title: `${P} tune` })).toMatchObject({ value: "the friends lyrics" });
    });

    it("prefers a song that has lyrics over an exact title that has none", async () => {
        expect(await lyricsOf({ artist: `${P} lyricband`, title: `${P} ballad` })).toMatchObject({ value: "the reprise lyrics" });
    });

    it("answers empty when no song that holds the title has lyrics", async () => {
        expect(await lyricsOf({ artist: `${P} lyricband`, title: `${P} mute` })).toEqual({});
    });

    it("finds a title with accents when the app asks without them, in any case", async () => {
        expect(await lyricsOf({ artist: `${P} lyricband`, title: `${P} cafe tune` })).toMatchObject({ value: "the café lyrics" });
        expect(await lyricsOf({ artist: `${P} lyricband`, title: `${P} CAFE` })).toMatchObject({ value: "the café lyrics" });
    });

    it("still finds an accented title when asked with its accents, and a plain title when asked with accents it lacks", async () => {
        expect(await lyricsOf({ artist: `${P} lyricband`, title: `${P} café tune` })).toMatchObject({ value: "the café lyrics" });
        expect(await lyricsOf({ artist: `${P} lyricband`, title: `${P} pláin song` })).toMatchObject({ value: "the plain lyrics" });
    });
});

describe("a playlist import finds an artist by the name shown", () => {
    it("the matcher finds the song of the shown artist name, not a namesake title of another artist", async () => {
        const match = await (spotifyImportService as any).matchTrack({
            spotifyId: "x", title: `${P} import song`, artist: `Quillon Vesper Choir`, artistId: "", album: "Unknown Album", albumId: "",
            isrc: null, durationMs: 0, trackNumber: 1, previewUrl: null, coverUrl: null,
        });
        expect(match.localTrack?.id).toBe(`${P}-imp-1s`);
    });

    it("a later reconcile of a waiting song finds it by the shown artist name (a title too short to match without its artist)", async () => {
        const playlistId = `${P}-playlist-1`;
        await prisma.playlist.create({ data: { id: playlistId, userId: USER, name: playlistId } });
        await prisma.playlistPendingTrack.create({
            data: { playlistId, spotifyArtist: `Quillon Vesper Choir`, spotifyTitle: "Hymn", spotifyAlbum: "x", sort: 0, rank: "a0" },
        });
        await spotifyImportService.reconcilePendingTracks(playlistId);
        expect((await prisma.playlistItem.findMany({ where: { playlistId } })).map((i) => i.trackId)).toEqual([`${P}-imp-1h`]);
    });

    it("still finds it by the file's artist name", async () => {
        const match = await (spotifyImportService as any).matchTrack({
            spotifyId: "x", title: `${P} import song`, artist: `${P}rawfile band`, artistId: "", album: "Unknown Album", albumId: "",
            isrc: null, durationMs: 0, trackNumber: 1, previewUrl: null, coverUrl: null,
        });
        expect(match.localTrack?.id).toBe(`${P}-imp-1s`);
    });
});

describe("a playlist import's title checks fold like the rest of the import", () => {
    const song = (title: string, artist: string, spotifyId: string) =>
        ({ spotifyId, title, artist, artistId: "", album: "Unknown Album", albumId: "", isrc: null, durationMs: 0, trackNumber: 1, previewUrl: null, coverUrl: null });

    it("finds the album that needs a song when the title and artist differ by accents, case or an apostrophe", () => {
        const preview = {
            matchedTracks: [{ spotifyTrack: song("Don’t Stop", "Beyonce", "other-id"), localTrack: null }],
            albumsToDownload: [{
                spotifyAlbumId: "sp1", albumName: "An Album", artistName: "Beyoncé", artistMbid: "ar1", albumMbid: "rg1", coverUrl: null,
                trackCount: 1, tracksNeeded: [song("DON'T STOP", "Beyoncé", "needed-id")],
            }],
        };
        const [pending] = (spotifyImportService as any).buildPendingTracks(preview);
        expect(pending).toMatchObject({ albumMbid: "rg1", artistMbid: "ar1" });
    });

    it("does not take another song's album for it", () => {
        const preview = {
            matchedTracks: [{ spotifyTrack: song("Stop", "Beyonce", "other-id"), localTrack: null }],
            albumsToDownload: [{
                spotifyAlbumId: "sp1", albumName: "An Album", artistName: "Beyoncé", artistMbid: "ar1", albumMbid: "rg1", coverUrl: null,
                trackCount: 1, tracksNeeded: [song("Don't Stop", "Beyoncé", "needed-id")],
            }],
        };
        const [pending] = (spotifyImportService as any).buildPendingTracks(preview);
        expect(pending.albumMbid).toBeNull();
    });

    it("finds the album a song is on when the album names differ by accents or case", () => {
        const preview = {
            matchedTracks: [{ spotifyTrack: { ...song("Other", "Beyonce", "other-id"), album: "Cafe Del Mar" }, localTrack: null }],
            albumsToDownload: [{
                spotifyAlbumId: "sp1", albumName: "Café Del Mar", artistName: "Beyoncé", artistMbid: "ar1", albumMbid: "rg1", coverUrl: null,
                trackCount: 1, tracksNeeded: [song("Something Else", "Beyoncé", "needed-id")],
            }],
        };
        const [pending] = (spotifyImportService as any).buildPendingTracks(preview);
        expect(pending).toMatchObject({ albumMbid: "rg1", artistMbid: "ar1" });
    });

    it("does not take an album for a song whose album name has no letters or digits", () => {
        const preview = {
            matchedTracks: [{ spotifyTrack: { ...song("Other", "Beyonce", "other-id"), album: "???" }, localTrack: null }],
            albumsToDownload: [{
                spotifyAlbumId: "sp1", albumName: "Café Del Mar", artistName: "Beyoncé", artistMbid: "ar1", albumMbid: "rg1", coverUrl: null,
                trackCount: 1, tracksNeeded: [song("Something Else", "Beyoncé", "needed-id")],
            }],
        };
        const [pending] = (spotifyImportService as any).buildPendingTracks(preview);
        expect(pending.albumMbid).toBeNull();
    });

    it("merges the editions of one album without a song twice, whatever its case, accents or apostrophe", () => {
        const merged = mergeEditionTracks([
            song("Don't Stop", "A", "1"), song("Café", "A", "2"),
            song("DON’T STOP", "A", "3"), song("cafe", "A", "4"), song("Don't Stop (Live)", "A", "5"),
        ]);
        expect(merged.map((t) => t.spotifyId)).toEqual(["1", "2", "5"]);
    });
});

describe("a playlist import reads the shown artist names once", () => {
    it("reconciling several waiting songs makes one lookup of the shown names, not one per song", async () => {
        const playlistId = `${P}-playlist-2`;
        await prisma.playlist.create({ data: { id: playlistId, userId: USER, name: playlistId } });
        for (const [n, title] of ["Hymn", `${P} import song`, "Nothing Matches This"].entries()) {
            await prisma.playlistPendingTrack.create({
                data: { playlistId, spotifyArtist: "Quillon Vesper Choir", spotifyTitle: title, spotifyAlbum: "x", sort: n, rank: `a${n}` },
            });
        }
        const lookup = jest.spyOn(prisma.artist, "findMany");
        try {
            await spotifyImportService.reconcilePendingTracks(playlistId);
            const ofShownNames = lookup.mock.calls.filter(([args]) => JSON.stringify(args?.where ?? {}).includes('"displayName"'));
            expect(ofShownNames).toHaveLength(1);
        } finally {
            lookup.mockRestore();
        }
    });
});

describe("getArtists' lastModified follows the library a client lists", () => {
    const lastModified = async () => (await ask("getArtists", {})).artists.lastModified as number;
    const tick = () => new Promise((r) => setTimeout(r, 15));

    it("is the stored marker in milliseconds, and moves when the marker does", async () => {
        const marked = await markLibraryChanged();
        expect(await lastModified()).toBe(marked.getTime());
        await tick();
        const later = await markLibraryChanged();
        expect(later.getTime()).toBeGreaterThan(marked.getTime());
        expect(await lastModified()).toBe(later.getTime());
    });

    it("does not go backwards", async () => {
        const before = await markLibraryChanged();
        const again = await markLibraryChanged(new Date(before.getTime() - 60_000));
        expect(again.getTime()).toBe(before.getTime());
        expect(await lastModified()).toBe(before.getTime());
    });

    it("does not move for a song change, a Discover song or an analysis write", async () => {
        const before = await markLibraryChanged();
        await tick();
        await prisma.track.update({ where: { id: `${P}-gen-a3s1` }, data: { trackNo: 7 } });
        await prisma.track.update({ where: { id: `${P}-gen-a1s1` }, data: { analysisStatus: "completed" } });
        await prisma.artist.update({ where: { id: `${P}-gen-a` }, data: { lastSynced: new Date() } });
        expect(await lastModified()).toBe(before.getTime());
    });

    it("moves when a person edits an artist, album or song name, or resets one", async () => {
        const put = (path: string, body: object) => request(enrichmentApp).put(path).set("Authorization", asAdmin).send(body).expect(200);
        const post = (path: string) => request(enrichmentApp).post(path).set("Authorization", asAdmin).expect(200);
        const steps: [string, () => Promise<unknown>][] = [
            ["artist name", () => put(`/enrichment/artists/${P}-lyr/metadata`, { name: `${P} renamed` })],
            ["artist reset", () => post(`/enrichment/artists/${P}-lyr/reset`)],
            ["album title", () => put(`/enrichment/albums/${P}-lyr-a1/metadata`, { title: `${P} retitled` })],
            ["album reset", () => post(`/enrichment/albums/${P}-lyr-a1/reset`)],
            ["song title", () => put(`/enrichment/tracks/${P}-lyr-a1s/metadata`, { title: `${P} retitled song` })],
            ["song reset", () => post(`/enrichment/tracks/${P}-lyr-a1s/reset`)],
        ];
        for (const [what, edit] of steps) {
            const before = await lastModified();
            await tick();
            await edit();
            expect({ what, moved: (await lastModified()) > before }).toEqual({ what, moved: true });
        }
    });

    it("does not move for an edit that is not a name", async () => {
        const before = await lastModified();
        await tick();
        await request(enrichmentApp).put(`/enrichment/artists/${P}-lyr/metadata`).set("Authorization", asAdmin).send({ bio: "a bio" }).expect(200);
        await request(enrichmentApp).put(`/enrichment/tracks/${P}-lyr-a1s/metadata`).set("Authorization", asAdmin).send({ trackNo: 3 }).expect(200);
        expect(await lastModified()).toBe(before);
    });
});

/**
 * What a search reply shows and how it is ordered. Albums and artists sort by the name shown (an edited name, not the
 * file's), on every path: the ranked search (its ties, and its substring search for a query full-text search finds
 * nothing for) and the empty-query enumeration. search3 artists carry the edited name and the count of albums with a
 * playable song; search2 answers albums as Child entries (a folder: `isDir`, `parent`) where search3 answers AlbumID3.
 * Real router, real database.
 */

import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import { searchRouter } from "../search";

const P = "zzshapes";
const USER = `${P}-user`;

const app = express()
    .use((req: any, _res, next) => { req.user = { id: USER, username: USER, role: "user" }; next(); })
    .use("/", searchRouter);

const ask = (view: string, query: Record<string, string>) =>
    request(app).get(`/${view}.view`).query({ f: "json", ...query }).expect(200).then((r) => r.body["subsonic-response"]);

// Raw order and shown order are opposite: apple shows as zulu, mango as itself; aaa shows as zzz, bbb as itself.
const A = {
    edited: { id: `${P}-ar-edited`, name: "zzshartistapple", displayName: "zzshartistzulu" },
    // The "plain" rows carry a shown name too (a different word from the file's), so both rows of a pair hold two words
    // the query matches and the ranked search ties them: a row with only one matching word would rank below.
    plain: { id: `${P}-ar-plain`, name: "zzshartistmango", displayName: "zzshartistmangoz" },
    uniEdited: { id: `${P}-ar-unie`, name: "zzshunié apple", displayName: "zzshunié zulu" },
    uniPlain: { id: `${P}-ar-unip`, name: "zzshunié mango", displayName: null },
};
const L = {
    edited: { id: `${P}-al-edited`, title: "zzshalbumaaa", displayTitle: "zzshalbumzzz", artist: A.edited.id },
    plain: { id: `${P}-al-plain`, title: "zzshalbumbbb", displayTitle: "zzshalbumbbbx", artist: A.plain.id },
    gone: { id: `${P}-al-gone`, title: "zzshalbumgone", displayTitle: null, artist: A.edited.id },
    disc: { id: `${P}-al-disc`, title: "zzshalbumdisc", displayTitle: null, artist: A.edited.id },
    uniEdited: { id: `${P}-al-unie`, title: "zzshunié aaa", displayTitle: "zzshunié zzz", artist: A.uniEdited.id },
    uniPlain: { id: `${P}-al-unip`, title: "zzshunié bbb", displayTitle: null, artist: A.uniPlain.id },
    // Full-text search matches its words in any order; the substring search cannot find it by them.
    words: { id: `${P}-al-words`, title: "zzshquartz zzshmist", displayTitle: "zzshquartz zzshmist shown", artist: A.uniPlain.id },
};
const CREATED = new Date(Date.UTC(2032, 1, 3, 4, 5, 6, 0));

beforeAll(async () => {
    for (const a of Object.values(A)) {
        await prisma.artist.create({ data: { id: a.id, name: a.name, displayName: a.displayName, normalizedName: a.id, identityKey: `${a.id}-ik`, libraryAlbumCount: 1 } });
    }
    for (const [key, al] of Object.entries(L)) {
        await prisma.album.create({
            data: {
                id: al.id, rgMbid: `${al.id}-rg`, identityKey: al.id, artistId: al.artist, title: al.title, displayTitle: al.displayTitle,
                primaryType: "Album", location: key === "disc" ? "DISCOVER" : "LIBRARY", year: 2001, createdAt: CREATED,
            },
        });
        await prisma.track.create({
            data: {
                id: `${al.id}-t`, albumId: al.id, title: `${al.title} song`, trackNo: 1, duration: 60, filePath: `${al.id}.flac`,
                fileModified: new Date(), fileSize: 1, ...(key === "gone" ? { missingSince: new Date() } : {}),
            },
        });
    }
});

afterAll(async () => {
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
});

/** The ids of `rows` that are among `ids`, in the reply's order. */
const ours = (rows: { id: string }[] | { id: string } | undefined, ids: string[]) =>
    [rows ?? []].flat().filter((r) => ids.includes(r.id)).map((r) => r.id);

describe("albums sort by the title shown", () => {
    const both = [L.edited.id, L.plain.id];
    const shown = [L.plain.id, L.edited.id]; // bbb before zzz, though aaa < bbb by the file's title
    const uni = [L.uniEdited.id, L.uniPlain.id];
    const uniShown = [L.uniPlain.id, L.uniEdited.id];

    it("the empty-query enumeration", async () => {
        const body = await ask("search3", { query: "", albumCount: "500" });
        expect(ours(body.searchResult3.album, [...both, ...uni])).toEqual([...shown, ...uniShown]);
    });

    it("a ranked search's ties", async () => {
        const body = await ask("search3", { query: "zzshalbum", albumCount: "50" });
        expect(ours(body.searchResult3.album, both)).toEqual(shown);
    });

    it("the substring search a full-text miss falls back to", async () => {
        const body = await ask("search3", { query: "shalbum", albumCount: "50" });
        expect(ours(body.searchResult3.album, both)).toEqual(shown);
    });

    it("the substring search for a query that is not ASCII", async () => {
        const body = await ask("search3", { query: "hunié", albumCount: "50" });
        expect(ours(body.searchResult3.album, uni)).toEqual(uniShown);
    });
});

describe("artists sort by the name shown", () => {
    const both = [A.edited.id, A.plain.id];
    const shown = [A.plain.id, A.edited.id]; // mango before zulu, though apple < mango by the file's name
    const uni = [A.uniEdited.id, A.uniPlain.id];
    const uniShown = [A.uniPlain.id, A.uniEdited.id];

    it("the empty-query enumeration", async () => {
        const body = await ask("search3", { query: "", artistCount: "500" });
        expect(ours(body.searchResult3.artist, [...both, ...uni])).toEqual([...shown, ...uniShown]);
    });

    it("a ranked search's ties", async () => {
        const body = await ask("search3", { query: "zzshartist", artistCount: "50" });
        expect(ours(body.searchResult3.artist, both)).toEqual(shown);
    });

    it("the substring search a full-text miss falls back to", async () => {
        const body = await ask("search3", { query: "shartist", artistCount: "50" });
        expect(ours(body.searchResult3.artist, both)).toEqual(shown);
    });

    it("the substring search for a query that is not ASCII", async () => {
        const body = await ask("search3", { query: "hunié", artistCount: "50" });
        expect(ours(body.searchResult3.artist, uni)).toEqual(uniShown);
    });
});

describe("search3 artists are full entries", () => {
    const entry = (body: any, id: string) => [body.searchResult3.artist ?? []].flat().find((a: any) => a.id === id);

    it("carry the edited name and the albums with a playable song, on both paths", async () => {
        for (const query of ["", "zzshartist"]) {
            const body = await ask("search3", { query, artistCount: "500" });
            // The edited artist has three albums here: one playable, one whose only song is missing, one in Discover.
            expect(entry(body, A.edited.id)).toMatchObject({ name: A.edited.displayName, albumCount: 1, coverArt: `ar-${A.edited.id}` });
            expect(entry(body, A.plain.id)).toMatchObject({ name: A.plain.displayName, albumCount: 1 });
        }
    });
});

describe("search2 answers albums as Child entries", () => {
    it("a folder whose parent is its artist, titled as shown, on both paths", async () => {
        for (const query of ["", "zzshalbum"]) {
            const body = await ask("search2", { query, albumCount: "500" });
            const album = [body.searchResult2.album ?? []].flat().find((a: any) => a.id === L.edited.id);
            expect(album).toMatchObject({
                isDir: true, parent: A.edited.id, title: L.edited.displayTitle, album: L.edited.displayTitle,
                artist: A.edited.displayName, artistId: A.edited.id, coverArt: L.edited.id,
            });
            expect(album.name).toBeUndefined();
        }
    });

    it("search3 still answers AlbumID3", async () => {
        const body = await ask("search3", { query: "", albumCount: "500" });
        const album = [body.searchResult3.album ?? []].flat().find((a: any) => a.id === L.edited.id);
        expect(album).toMatchObject({ name: L.edited.displayTitle, artistId: A.edited.id, songCount: 1 });
        expect(album.isDir).toBeUndefined();
    });

    it("search2 artists are the same full entries as search3's", async () => {
        const body = await ask("search2", { query: "zzshartistmango", artistCount: "5" });
        expect([body.searchResult2.artist].flat().find((a: any) => a.id === A.plain.id)).toMatchObject({ name: A.plain.displayName, albumCount: 1 });
    });
});

describe("the ranked search itself", () => {
    it("gives an album the same fields as the enumeration does", async () => {
        // Words in the reverse of the title's order: only full-text search finds it, the substring search does not.
        const ranked = await ask("search3", { query: "zzshmist zzshquartz", albumCount: "50" });
        const enumerated = await ask("search3", { query: "", albumCount: "500" });
        const pick = (body: any) => [body.searchResult3.album ?? []].flat().find((a: any) => a.id === L.words.id);

        expect(ours(ranked.searchResult3.album, Object.values(L).map((l) => l.id))).toEqual([L.words.id]);
        expect(pick(ranked)).toMatchObject({
            name: L.words.displayTitle, artist: A.uniPlain.name, artistId: A.uniPlain.id,
            songCount: 1, duration: 60, year: 2001, created: CREATED.toISOString(),
        });
        expect(pick(ranked)).toEqual(pick(enumerated));
    });
});

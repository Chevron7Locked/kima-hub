// What a share holds, asked through shareContents only: the page a stranger sees, the song a link plays, the covers it
// shows, the songs it lists for Subsonic, and whether a song or album can be shared at all. Real database.
// Each page reply is compared whole, with the expected keys written out, so a field that is not listed fails the test.

import { prisma } from "../../utils/db";
import { loadPublicShare, shareHoldsCover, shareTargetExists, songOfShare, songsOfShare } from "../shareContents";

const TAG = "zz-share-contents";

let userId: string;
let artistId: string;
let albumId: string;
let discoverAlbumId: string;
let deadAlbumId: string;
let firstTrack: string;
let secondTrack: string;
let missingTrack: string;
let corruptTrack: string;
let suggestedTrack: string;
let deadTrack: string;
let playlistId: string;
let firstItem: string;
let secondItem: string;

const share = (entityType: string, entityId: string) => ({ entityType, entityId });

const album = { title: "The Album", coverUrl: "native:albums/share-contents-cover.jpg", artist: { name: "The Artist" } };
const firstReply = () => ({ id: firstTrack, title: "First", duration: 180, trackNo: 1, discNumber: 1, discSubtitle: "Side A", album });
const secondReply = () => ({ id: secondTrack, title: "Second", duration: 200, trackNo: 2, discNumber: 1, discSubtitle: null, album });
// An album share lists its tracks without the album, which the share already names once.
const inAlbum = <T extends { album: unknown }>({ album: _album, ...track }: T) => track;

const makeAlbum = (suffix: string, location: "LIBRARY" | "DISCOVER", coverUrl: string | null = null) =>
    prisma.album
        .create({ data: { rgMbid: `${TAG}-${suffix}`, identityKey: `${TAG}-${suffix}`, artistId, title: suffix, primaryType: "Album", location, coverUrl } })
        .then((a) => a.id);

const makeTrack = (forAlbum: string, n: number, data: object = {}) =>
    prisma.track
        .create({
            data: {
                albumId: forAlbum,
                title: `Song ${n}`,
                duration: 100,
                trackNo: n,
                discNumber: 1,
                filePath: `/secret/server/path/${forAlbum}-${n}.flac`,
                fileModified: new Date(),
                fileSize: 7654321,
                analysisStatus: "failed",
                analysisError: "a private analysis error",
                ...data,
            },
        })
        .then((t) => t.id);

const playlistOf = async (name: string, trackIds: string[]) => {
    const id = (await prisma.playlist.create({ data: { userId, name, isPublic: false } })).id;
    for (const [i, trackId] of trackIds.entries()) {
        await prisma.playlistItem.create({ data: { playlistId: id, trackId, sort: trackIds.length - i, rank: `${name}-${String(i).padStart(3, "0")}` } });
    }
    return id;
};

beforeAll(async () => {
    userId = (await prisma.user.create({ data: { username: TAG, passwordHash: "x" } })).id;
    artistId = (await prisma.artist.create({ data: { name: "The Artist", normalizedName: TAG, identityKey: TAG } })).id;
    albumId = (
        await prisma.album.create({
            data: { rgMbid: TAG, identityKey: TAG, artistId, title: "The Album", primaryType: "Album", coverUrl: album.coverUrl, location: "LIBRARY" },
        })
    ).id;
    firstTrack = await makeTrack(albumId, 1, { title: "First", duration: 180, discSubtitle: "Side A" });
    secondTrack = await makeTrack(albumId, 2, { title: "Second", duration: 200 });
    missingTrack = await makeTrack(albumId, 3, { missingSince: new Date() });
    corruptTrack = await makeTrack(albumId, 4, { corrupt: true });
    discoverAlbumId = await makeAlbum("discover", "DISCOVER", "native:albums/share-contents-cover-discover.jpg");
    suggestedTrack = await makeTrack(discoverAlbumId, 1);
    deadAlbumId = await makeAlbum("dead", "LIBRARY", "native:albums/share-contents-cover-dead.jpg");
    deadTrack = await makeTrack(deadAlbumId, 1, { corrupt: true });
    // `sort` runs the other way from `rank`, so only following `rank` gives first-then-second.
    playlistId = (await prisma.playlist.create({ data: { userId, name: "The Playlist", isPublic: false } })).id;
    firstItem = (await prisma.playlistItem.create({ data: { playlistId, trackId: firstTrack, sort: 1, rank: "a" } })).id;
    secondItem = (await prisma.playlistItem.create({ data: { playlistId, trackId: secondTrack, sort: 0, rank: "b" } })).id;
});

afterAll(async () => {
    await prisma.playlist.deleteMany({ where: { userId } });
    await prisma.artist.deleteMany({ where: { id: artistId } });
    await prisma.user.deleteMany({ where: { id: userId } });
});

describe("the public page of a share", () => {
    it("a track share has only the listed fields", async () => {
        expect(await loadPublicShare(share("track", firstTrack))).toEqual(firstReply());
    });

    it("an album share has only the listed fields, its playable songs in disc and track order", async () => {
        expect(await loadPublicShare(share("album", albumId))).toEqual({
            id: albumId,
            title: "The Album",
            coverUrl: album.coverUrl,
            artist: { name: "The Artist" },
            tracks: [inAlbum(firstReply()), inAlbum(secondReply())],
        });
    });

    it("a playlist share has only the listed fields, in the app's order (rank)", async () => {
        expect(await loadPublicShare(share("playlist", playlistId))).toEqual({
            id: playlistId,
            name: "The Playlist",
            items: [
                { id: firstItem, sort: 1, track: firstReply() },
                { id: secondItem, sort: 0, track: secondReply() },
            ],
        });
    });

    it("no page carries a private value, anywhere in it", async () => {
        for (const [type, id] of [["track", firstTrack], ["album", albumId], ["playlist", playlistId]] as const) {
            const text = JSON.stringify(await loadPublicShare(share(type, id)));
            for (const secret of ["/secret/server/path", "a private analysis error", userId, TAG, "LIBRARY", "7654321", "filePath", "userId", "username"]) {
                expect([type, secret, text.includes(secret)]).toEqual([type, secret, false]);
            }
        }
    });

    it("shows the title and artist name a person edited, on every page", async () => {
        await prisma.track.update({ where: { id: firstTrack }, data: { displayTitle: "First, edited" } });
        await prisma.album.update({ where: { id: albumId }, data: { displayTitle: "The Album, edited" } });
        await prisma.artist.update({ where: { id: artistId }, data: { displayName: "The Artist, edited" } });
        try {
            const track = (await loadPublicShare(share("track", firstTrack))) as ReturnType<typeof firstReply>;
            expect([track.title, track.album.title, track.album.artist]).toEqual(["First, edited", "The Album, edited", { name: "The Artist, edited" }]);

            const albumPage = (await loadPublicShare(share("album", albumId))) as { title: string; artist: unknown; tracks: { title: string }[] };
            expect([albumPage.title, albumPage.artist, albumPage.tracks.map((t) => t.title)]).toEqual([
                "The Album, edited",
                { name: "The Artist, edited" },
                ["First, edited", "Second"],
            ]);

            const list = (await loadPublicShare(share("playlist", playlistId))) as { items: { track: ReturnType<typeof firstReply> }[] };
            expect(list.items.map((i) => [i.track.title, i.track.album.artist])).toEqual([
                ["First, edited", { name: "The Artist, edited" }],
                ["Second", { name: "The Artist, edited" }],
            ]);
        } finally {
            await prisma.track.update({ where: { id: firstTrack }, data: { displayTitle: null } });
            await prisma.album.update({ where: { id: albumId }, data: { displayTitle: null } });
            await prisma.artist.update({ where: { id: artistId }, data: { displayName: null } });
        }
    });

    it.each(["missing", "corrupt", "suggested"])("a track share of the %s song has no page, as for a deleted one", async (kind) => {
        const id = { missing: missingTrack, corrupt: corruptTrack, suggested: suggestedTrack }[kind as "missing"];
        expect(await loadPublicShare(share("track", id))).toBeNull();
    });

    it("a share of a song that does not exist, or of a type it does not know, has no page", async () => {
        expect(await loadPublicShare(share("track", `${TAG}-no-such-track`))).toBeNull();
        expect(await loadPublicShare(share("album", `${TAG}-no-such-album`))).toBeNull();
        expect(await loadPublicShare(share("playlist", `${TAG}-no-such-playlist`))).toBeNull();
        expect(await loadPublicShare(share("artist", albumId))).toBeNull();
    });

    it("an album share lists only its playable songs", async () => {
        const page = (await loadPublicShare(share("album", albumId))) as { tracks: { id: string }[] };
        expect(page.tracks.map((t) => t.id)).toEqual([firstTrack, secondTrack]);
    });

    it.each(["dead", "discover"])("an album share of an album with nothing to play (%s) has no page", async (kind) => {
        expect(await loadPublicShare(share("album", kind === "dead" ? deadAlbumId : discoverAlbumId))).toBeNull();
    });

    it("a playlist share lists only its playable songs, and shows an empty list when none plays", async () => {
        const mixed = await playlistOf("mixed", [suggestedTrack, secondTrack, missingTrack, corruptTrack, firstTrack]);
        const page = (await loadPublicShare(share("playlist", mixed))) as { items: { track: { id: string } }[] };
        expect(page.items.map((i) => i.track.id)).toEqual([secondTrack, firstTrack]);

        const nothing = await playlistOf("nothing", [suggestedTrack, missingTrack, corruptTrack, deadTrack]);
        expect(await loadPublicShare(share("playlist", nothing))).toEqual({ id: nothing, name: "nothing", items: [] });
    });
});

describe("the song a share plays", () => {
    it("gives the file of a playable song the share holds, whatever the share is of", async () => {
        const filePath = `/secret/server/path/${albumId}-1.flac`;
        for (const link of [share("track", firstTrack), share("album", albumId), share("playlist", playlistId)]) {
            expect([link.entityType, await songOfShare(link, firstTrack)]).toEqual([link.entityType, { filePath }]);
        }
    });

    it.each(["missing", "corrupt", "suggested"])("says the %s song is not playable when the share holds it", async (kind) => {
        const id = { missing: missingTrack, corrupt: corruptTrack, suggested: suggestedTrack }[kind as "missing"];
        const mixed = await playlistOf(`holds-${kind}`, [id]);
        const links = [share("track", id), share("playlist", mixed)];
        if (kind !== "suggested") links.push(share("album", albumId));
        for (const link of links) {
            expect([link.entityType, await songOfShare(link, id)]).toEqual([link.entityType, "not-playable"]);
        }
    });

    it("says a song the share does not hold is not covered, even one that does not exist", async () => {
        expect(await songOfShare(share("track", firstTrack), secondTrack)).toBe("not-covered");
        expect(await songOfShare(share("album", albumId), suggestedTrack)).toBe("not-covered");
        expect(await songOfShare(share("playlist", playlistId), suggestedTrack)).toBe("not-covered");
        expect(await songOfShare(share("album", albumId), "no-such-song")).toBe("not-covered");
        expect(await songOfShare(share("playlist", playlistId), "no-such-song")).toBe("not-covered");
        expect(await songOfShare(share("artist", albumId), firstTrack)).toBe("not-covered");
    });

    // A query count is the only way to see this: the answer is the same either way. A song that plays is the usual request,
    // and it is made once for each range a listener's player asks for.
    it("finds a song that plays with one lookup, whatever the share is of", async () => {
        const tracks = jest.spyOn(prisma.track, "findFirst");
        const items = jest.spyOn(prisma.playlistItem, "findFirst");
        try {
            for (const link of [share("track", firstTrack), share("album", albumId), share("playlist", playlistId)]) {
                tracks.mockClear();
                items.mockClear();
                expect(await songOfShare(link, firstTrack)).not.toBe("not-covered");
                expect([link.entityType, tracks.mock.calls.length, items.mock.calls.length]).toEqual([link.entityType, 1, 0]);
            }
        } finally {
            tracks.mockRestore();
            items.mockRestore();
        }
    });
});

describe("the covers a share shows", () => {
    const coverOfDead = "albums/share-contents-cover-dead.jpg";

    it("holds the cover of the song's album, the shared album, and an album of a playable song in the shared playlist", async () => {
        for (const link of [share("track", firstTrack), share("album", albumId), share("playlist", playlistId)]) {
            expect([link.entityType, await shareHoldsCover(link, "albums/share-contents-cover.jpg")]).toEqual([link.entityType, true]);
        }
    });

    it("holds a cover whatever version its stored address carries", async () => {
        await prisma.album.update({ where: { id: albumId }, data: { coverUrl: "native:albums/share-contents-cover.jpg?v=1111111111" } });
        try {
            expect(await shareHoldsCover(share("album", albumId), "albums/share-contents-cover.jpg")).toBe(true);
        } finally {
            await prisma.album.update({ where: { id: albumId }, data: { coverUrl: album.coverUrl } });
        }
    });

    it("does not hold the cover of another album, or one nobody stores", async () => {
        for (const link of [share("track", firstTrack), share("album", albumId), share("playlist", playlistId)]) {
            expect([link.entityType, await shareHoldsCover(link, coverOfDead)]).toEqual([link.entityType, false]);
            expect([link.entityType, await shareHoldsCover(link, "albums/nobody-has-this.jpg")]).toEqual([link.entityType, false]);
        }
    });

    it("does not hold the cover of an album with nothing to play, or of a Discover album", async () => {
        const inList = await playlistOf("covers", [deadTrack, suggestedTrack]);
        expect(await shareHoldsCover(share("album", deadAlbumId), coverOfDead)).toBe(false);
        expect(await shareHoldsCover(share("track", deadTrack), coverOfDead)).toBe(false);
        expect(await shareHoldsCover(share("playlist", inList), coverOfDead)).toBe(false);
        expect(await shareHoldsCover(share("playlist", inList), "albums/share-contents-cover-discover.jpg")).toBe(false);
        expect(await shareHoldsCover(share("album", discoverAlbumId), "albums/share-contents-cover-discover.jpg")).toBe(false);
    });

    it("holds nothing for a share of a type it does not know", async () => {
        expect(await shareHoldsCover(share("artist", albumId), "albums/share-contents-cover.jpg")).toBe(false);
    });
});

describe("the songs of a share, for Subsonic", () => {
    const ids = async (link: { entityType: string; entityId: string }) => (await songsOfShare(link, {})).map((t) => t.id);

    it("lists a song itself, an album in disc and track order, and a playlist by rank, playable songs only", async () => {
        expect(await ids(share("track", firstTrack))).toEqual([firstTrack]);
        expect(await ids(share("album", albumId))).toEqual([firstTrack, secondTrack]);
        expect(await ids(share("playlist", playlistId))).toEqual([firstTrack, secondTrack]);

        const mixed = await playlistOf("songs-mixed", [suggestedTrack, secondTrack, missingTrack, corruptTrack, firstTrack]);
        expect(await ids(share("playlist", mixed))).toEqual([secondTrack, firstTrack]);
    });

    it("lists nothing for a song that does not play, an album with nothing to play, or a type it does not know", async () => {
        expect(await ids(share("track", missingTrack))).toEqual([]);
        expect(await ids(share("track", suggestedTrack))).toEqual([]);
        expect(await ids(share("album", deadAlbumId))).toEqual([]);
        expect(await ids(share("album", discoverAlbumId))).toEqual([]);
        expect(await ids(share("artist", albumId))).toEqual([]);
    });

    it("gives each song with the relations the caller asks for", async () => {
        const [song] = await songsOfShare(share("track", firstTrack), { album: { include: { artist: true } } });
        expect([song.title, song.album.title, song.album.artist.name]).toEqual(["First", "The Album", "The Artist"]);
    });
});

describe("whether a song or album can be shared", () => {
    it("a track or album with something to play can; a missing, corrupt, Discover or unknown one cannot", async () => {
        expect(await shareTargetExists(share("track", firstTrack))).toBe(true);
        expect(await shareTargetExists(share("album", albumId))).toBe(true);
        for (const id of [missingTrack, corruptTrack, suggestedTrack, "no-such-song"]) {
            expect([id, await shareTargetExists(share("track", id))]).toEqual([id, false]);
        }
        for (const id of [deadAlbumId, discoverAlbumId, "no-such-album"]) {
            expect([id, await shareTargetExists(share("album", id))]).toEqual([id, false]);
        }
    });

    it("a playlist can whenever it exists, even with nothing in it", async () => {
        const empty = await playlistOf("empty", []);
        expect(await shareTargetExists(share("playlist", playlistId))).toBe(true);
        expect(await shareTargetExists(share("playlist", empty))).toBe(true);
        expect(await shareTargetExists(share("playlist", "no-such-playlist"))).toBe(false);
    });

    it("a type it does not know cannot", async () => {
        expect(await shareTargetExists(share("artist", albumId))).toBe(false);
    });
});

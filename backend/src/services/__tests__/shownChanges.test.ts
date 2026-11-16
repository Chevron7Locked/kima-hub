/**
 * A found picture, year or genre list that replaces the one a client shows moves the library-changed marker once per window,
 * and only when a listed artist or album's shown value really changed. Real database and the real marker.
 */
import { prisma } from "../../utils/db";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { failMarkerWrites, markerMoves, watchMarkerWrites } from "../../__tests__/helpers/libraryMarker";
import { expectLog } from "../../__tests__/helpers/expectedLogs";
import * as libraryChanged from "../libraryChanged";
import {
    SHOWN_CHANGE_WINDOW_MS,
    albumShownChange,
    artistShownChange,
    flushShownChanges,
    noteGenresChange,
    notePictureChange,
    noteYearChange,
    rewritePictureColumn,
    shownPicture,
    songTitleChanged,
} from "../shownChanges";

jest.setTimeout(60_000);

const P = "spc_";
const pic = (name: string) => `https://pictures.example/${name}.jpg`;

type Kind = "playable" | "discover" | "missing" | "corrupt";

async function seed(key: string, kind: Kind) {
    const artist = await prisma.artist.create({
        data: { id: `${P}art_${key}`, name: `${P}artist ${key}`, normalizedName: `${P}artist ${key}`, identityKey: `${P}ik_${key}` },
    });
    const album = await prisma.album.create({
        data: {
            id: `${P}alb_${key}`, rgMbid: `${P}rg_${key}`, artistId: artist.id, identityKey: `${P}ak_${key}`, title: `${P}album ${key}`, primaryType: "Album",
            location: kind === "discover" ? "DISCOVER" : "LIBRARY",
        },
    });
    await prisma.track.create({
        data: {
            id: `${P}t_${key}`, albumId: album.id, title: `${P}song ${key}`, trackNo: 1, duration: 100, filePath: `${P}/${key}/01.flac`, fileModified: new Date(), fileSize: 1,
            ...(kind === "missing" ? { missingSince: new Date() } : {}), ...(kind === "corrupt" ? { corrupt: true } : {}),
        },
    });
    return { artist: artist.id, album: album.id };
}

async function cleanup() {
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

beforeEach(async () => {
    await flushShownChanges();
    await cleanup();
});
afterEach(async () => {
    jest.restoreAllMocks();
    await flushShownChanges();
});
afterAll(async () => {
    await cleanup();
    await closeEngineConnections();
    await prisma.$disconnect();
});

/** Whether the marker moved when the notes made by `note` were flushed. */
const flushedMoves = (note: () => void) =>
    markerMoves(async () => {
        note();
        await flushShownChanges();
    });

describe("a found picture that changes what is shown", () => {
    it("moves the marker for a listed artist and a listed album", async () => {
        const s = await seed("a", "playable");
        expect(await flushedMoves(() => notePictureChange("artist", s.artist, { was: null, now: pic("a") }))).toBe(true);
        expect(await flushedMoves(() => notePictureChange("album", s.album, { was: pic("old"), now: pic("new") }))).toBe(true);
    });

    it.each(["discover", "missing", "corrupt"] as const)("leaves the marker when no client lists the item (%s)", async (kind) => {
        const s = await seed(`u${kind}`, kind);
        expect(await flushedMoves(() => notePictureChange("artist", s.artist, { was: null, now: pic("a") }))).toBe(false);
        expect(await flushedMoves(() => notePictureChange("album", s.album, { was: null, now: pic("a") }))).toBe(false);
    });

    it("leaves the marker when the same picture is stored again, or when the person's own picture shows either way", async () => {
        const s = await seed("same", "playable");
        expect(await flushedMoves(() => notePictureChange("artist", s.artist, { was: pic("a"), now: pic("a") }))).toBe(false);
        expect(await flushedMoves(() => notePictureChange("album", s.album, { was: null, now: null }))).toBe(false);
        expect(await flushedMoves(() => notePictureChange("album", s.album, { was: "", now: null }))).toBe(false);
        expect(await flushedMoves(() => notePictureChange("artist", s.artist, { was: pic("a"), now: pic("b"), own: pic("mine") }))).toBe(false);
        expect(await flushedMoves(() => notePictureChange("album", s.album, { was: null, now: pic("b"), own: pic("mine") }))).toBe(false);
    });

    it("leaves the marker when a picture changed and changed back inside the window", async () => {
        const s = await seed("back", "playable");
        expect(
            await flushedMoves(() => {
                notePictureChange("artist", s.artist, { was: pic("a"), now: pic("b") });
                notePictureChange("artist", s.artist, { was: pic("b"), now: pic("a") });
            }),
        ).toBe(false);
    });

    it("moves the marker once for many pictures, and only one of them has to be listed", async () => {
        const listed = await seed("many1", "playable");
        const hidden = await seed("many2", "discover");
        const writes = watchMarkerWrites();
        expect(
            await flushedMoves(() => {
                writes.reset();
                notePictureChange("artist", hidden.artist, { was: null, now: pic("h") });
                notePictureChange("album", hidden.album, { was: null, now: pic("h") });
                notePictureChange("album", listed.album, { was: null, now: pic("l") });
                notePictureChange("artist", listed.artist, { was: null, now: pic("l") });
            }),
        ).toBe(true);
        expect(writes.count()).toBe(1);
    });

    it("holds a note until the window ends, without keeping the process alive, and then moves the marker by itself", async () => {
        const s = await seed("timer", "playable");
        const scheduled = jest.spyOn(global, "setTimeout");
        const moved = await markerMoves(async () => {
            notePictureChange("artist", s.artist, { was: null, now: pic("t") });
            // Nothing yet: the marker moves when the window ends.
            expect(await libraryChanged.libraryChangedAt()).toBeLessThanOrEqual(Date.now());
            const call = scheduled.mock.calls.find((c) => c[1] === SHOWN_CHANGE_WINDOW_MS);
            expect(call).toBeDefined();
            const handle = scheduled.mock.results[scheduled.mock.calls.indexOf(call!)].value as NodeJS.Timeout;
            expect(handle.hasRef()).toBe(false);
            const marker = await libraryChanged.libraryChangedAt();
            const before = marker;
            (call![0] as () => void)();
            for (let i = 0; i < 100 && (await libraryChanged.libraryChangedAt()) === before; i++) await new Promise((r) => setTimeout(r, 20));
        });
        expect(moved).toBe(true);
    });
});

describe("a year that changes what is shown", () => {
    it("moves the marker for a listed album whose shown year changed", async () => {
        const s = await seed("y1", "playable");
        expect(await flushedMoves(() => noteYearChange(s.album, { was: { year: null }, now: { year: 1999 } }))).toBe(true);
        expect(await flushedMoves(() => noteYearChange(s.album, { was: { year: 2005 }, now: { year: 2006 } }))).toBe(true);
    });

    it.each(["discover", "missing", "corrupt"] as const)("leaves the marker when no client lists the album (%s)", async (kind) => {
        const s = await seed(`yu${kind}`, kind);
        expect(await flushedMoves(() => noteYearChange(s.album, { was: { year: null }, now: { year: 1999 } }))).toBe(false);
    });

    it("judges the year shown: an original or the person's year hides a change of the file's", async () => {
        const s = await seed("y2", "playable");
        expect(await flushedMoves(() => noteYearChange(s.album, { was: { year: null, originalYear: 1990 }, now: { year: 2005, originalYear: 1990 } }))).toBe(false);
        expect(await flushedMoves(() => noteYearChange(s.album, { was: { year: null, displayYear: 1975 }, now: { year: 2005, displayYear: 1975 } }))).toBe(false);
        expect(await flushedMoves(() => noteYearChange(s.album, { was: { year: 2005 }, now: { year: 2005 } }))).toBe(false);
        // An original year found under a file's year shows a different one.
        expect(await flushedMoves(() => noteYearChange(s.album, { was: { year: 2005 }, now: { year: 2005, originalYear: 1990 } }))).toBe(true);
    });

    it("leaves the marker when a year changed and changed back inside the window", async () => {
        const s = await seed("y3", "playable");
        expect(
            await flushedMoves(() => {
                noteYearChange(s.album, { was: { year: 2000 }, now: { year: 2001 } });
                noteYearChange(s.album, { was: { year: 2001 }, now: { year: 2000 } });
            }),
        ).toBe(false);
    });

    it("keeps a picture note and a year note of one album apart", async () => {
        const s = await seed("y4", "playable");
        // The year goes there and back; the picture, noted on the same album, still changed.
        expect(
            await flushedMoves(() => {
                noteYearChange(s.album, { was: { year: 2000 }, now: { year: 2001 } });
                notePictureChange("album", s.album, { was: null, now: pic("p") });
                noteYearChange(s.album, { was: { year: 2001 }, now: { year: 2000 } });
            }),
        ).toBe(true);
    });
});

describe("genres that change what is shown", () => {
    it("moves the marker for a listed artist or album whose merged genres changed", async () => {
        const s = await seed("g1", "playable");
        expect(await flushedMoves(() => noteGenresChange("artist", s.artist, { was: { genres: null }, now: { genres: ["rock"] } }))).toBe(true);
        expect(await flushedMoves(() => noteGenresChange("album", s.album, { was: { genres: ["rock"] }, now: { genres: ["rock", "pop"] } }))).toBe(true);
        expect(await flushedMoves(() => noteGenresChange("artist", s.artist, { was: { genres: ["rock", "pop"] }, now: { genres: ["pop", "rock"] } }))).toBe(true);
    });

    it("leaves the marker when the list shown stays the same, or the person's own list shows either way", async () => {
        const s = await seed("g2", "playable");
        expect(await flushedMoves(() => noteGenresChange("artist", s.artist, { was: { genres: ["rock"] }, now: { genres: ["rock"] } }))).toBe(false);
        expect(await flushedMoves(() => noteGenresChange("artist", s.artist, { was: { genres: null }, now: { genres: [] } }))).toBe(false);
        expect(await flushedMoves(() => noteGenresChange("artist", s.artist, { was: { genres: ["a"], userGenres: ["mine"] }, now: { genres: ["b"], userGenres: ["mine"] } }))).toBe(false);
    });

    it.each(["discover", "missing", "corrupt"] as const)("leaves the marker when no client lists the artist or album (%s)", async (kind) => {
        const s = await seed(`gu${kind}`, kind);
        expect(await flushedMoves(() => noteGenresChange("artist", s.artist, { was: { genres: null }, now: { genres: ["rock"] } }))).toBe(false);
        expect(await flushedMoves(() => noteGenresChange("album", s.album, { was: { genres: null }, now: { genres: ["rock"] } }))).toBe(false);
    });
});

describe("rewritePictureColumn", () => {
    it("writes the new address and notes a row whose shown picture changed", async () => {
        const s = await seed("rw", "playable");
        await prisma.artist.update({ where: { id: s.artist }, data: { heroUrl: "native:artists/x.jpg" } });
        await prisma.album.update({ where: { id: s.album }, data: { coverUrl: "native:albums/x.jpg", userCoverUrl: "native:albums/x.jpg" } });

        expect(await markerMoves(async () => {
            expect(await rewritePictureColumn("artist", "heroUrl", "native:artists/x.jpg", "native:artists/x.jpg?v=0123456789")).toBe(1);
            await flushShownChanges();
        })).toBe(true);
        expect((await prisma.artist.findUniqueOrThrow({ where: { id: s.artist } })).heroUrl).toBe("native:artists/x.jpg?v=0123456789");

        // The found cover rewritten under a person's own cover shows no change; the own cover itself does.
        expect(await markerMoves(async () => {
            await rewritePictureColumn("album", "coverUrl", "native:albums/x.jpg", "native:albums/x.jpg?v=0123456789");
            await flushShownChanges();
        })).toBe(false);
        expect(await markerMoves(async () => {
            await rewritePictureColumn("album", "userCoverUrl", "native:albums/x.jpg", "native:albums/x.jpg?v=0123456789");
            await flushShownChanges();
        })).toBe(true);
    });
});

describe("rewritePictureColumn against a concurrent edit", () => {
    it("notes what the rows held when they were written, not what they held when first read", async () => {
        const s = await seed("rwrace", "playable");
        await prisma.artist.update({ where: { id: s.artist }, data: { heroUrl: "native:artists/x.jpg" } });

        // A person sets their own picture and holds the row while the rewrite queues behind them: the artist shows
        // their picture before and after, so nothing a client shows changed.
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        let locked!: () => void;
        const isLocked = new Promise<void>((resolve) => { locked = resolve; });
        const editing = prisma.$transaction(async (tx) => {
            await tx.artist.update({ where: { id: s.artist }, data: { userHeroUrl: pic("mine") } });
            locked();
            await held;
        });
        await isLocked;

        const moved = await markerMoves(async () => {
            const rewriting = rewritePictureColumn("artist", "heroUrl", "native:artists/x.jpg", "native:artists/x.jpg?v=0123456789");
            await new Promise((resolve) => setTimeout(resolve, 300));
            release();
            await editing;
            expect(await rewriting).toBe(1);
            await flushShownChanges();
        });

        expect(moved).toBe(false);
    });
});

describe("shownPicture", () => {
    it("is the person's own picture, else the found one, else null", () => {
        expect(shownPicture(pic("f"), pic("o"))).toBe(pic("o"));
        expect(shownPicture(pic("f"), null)).toBe(pic("f"));
        expect(shownPicture(pic("f"), "")).toBe(pic("f"));
        expect(shownPicture(undefined, undefined)).toBeNull();
    });
});

describe("what a person's edit or reset changed in what is shown", () => {
    const artist = { name: "Cult", displayName: null, heroUrl: pic("f"), userHeroUrl: null, genres: ["rock"], userGenres: [] };
    const album = {
        title: "Live", displayTitle: null, coverUrl: pic("f"), userCoverUrl: null,
        year: 1999, originalYear: null, displayYear: null, genres: ["rock"], userGenres: [],
    };

    it("an artist: the first of name, picture, genres that shows differently, else null", () => {
        expect(artistShownChange(artist, { ...artist })).toBeNull();
        expect(artistShownChange(artist, { ...artist, displayName: "The Cult", userHeroUrl: pic("o") })).toBe("name");
        expect(artistShownChange(artist, { ...artist, userHeroUrl: pic("o"), userGenres: ["goth"] })).toBe("picture");
        expect(artistShownChange(artist, { ...artist, userGenres: ["goth"] })).toBe("genres");
        // an own name equal to the stored one shows nothing new; an own picture under the same address likewise
        expect(artistShownChange(artist, { ...artist, displayName: "Cult", userHeroUrl: pic("f") })).toBeNull();
        // a found genre under the person's own list changes nothing shown
        expect(artistShownChange({ ...artist, userGenres: ["goth"] }, { ...artist, userGenres: ["goth"], genres: ["punk"] })).toBeNull();
    });

    it("an album: title, cover, year (displayYear ?? originalYear ?? year), genres", () => {
        expect(albumShownChange(album, { ...album })).toBeNull();
        expect(albumShownChange(album, { ...album, displayTitle: "Live!" })).toBe("title");
        expect(albumShownChange(album, { ...album, userCoverUrl: pic("o") })).toBe("cover");
        expect(albumShownChange(album, { ...album, displayYear: 2001 })).toBe("year");
        expect(albumShownChange(album, { ...album, originalYear: 1999 })).toBeNull();
        expect(albumShownChange(album, { ...album, userGenres: ["goth"] })).toBe("genres");
        // a reset that clears an own year back to the stored one shows nothing new
        expect(albumShownChange({ ...album, displayYear: 1999 }, album)).toBeNull();
    });

    it("a song: only its title", () => {
        expect(songTitleChanged({ title: "A", displayTitle: null }, { title: "A", displayTitle: "A" })).toBe(false);
        expect(songTitleChanged({ title: "A", displayTitle: null }, { title: "A", displayTitle: "B" })).toBe(true);
        expect(songTitleChanged({ title: "A", displayTitle: "B" }, { title: "A", displayTitle: null })).toBe(true);
    });
});

describe("a marker that cannot be written", () => {
    it("is logged and does not fail the writer", async () => {
        const s = await seed("fail", "playable");
        const logged = expectLog("error");
        failMarkerWrites(new Error("settings went away"));
        notePictureChange("artist", s.artist, { was: null, now: pic("f") });
        await expect(flushShownChanges()).resolves.toBeUndefined();
        expect(logged).toHaveBeenCalled();
    });
});

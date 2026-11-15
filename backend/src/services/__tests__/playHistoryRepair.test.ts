/**
 * listensOf groups play rows into listens. Every case has an unambiguous answer.
 */

import { listensOf, collapseCandidates, auditFalseStarts, collapseDuplicateRows, removeFalseStarts } from "../playHistoryRepair";
import { prisma } from "../../utils/db";
import { lockPlayHistory, recordPlay } from "../playRecording";

// Nothing here may reach ListenBrainz.
jest.mock("../listenBrainz", () => ({ listenBrainzService: { submitListens: jest.fn().mockResolvedValue(false) } }));

const P = "zz-playRepair-";
const USER = `${P}u1`;

const T0 = new Date("2026-03-01T12:00:00Z").getTime();

/** A play `atSeconds` into the session, of a track `duration` long. */
function play(id: string, atSeconds: number, duration: number, trackId = "t1", heard = false, album = "alb") {
    return { id: `${P}${id}`, trackId: `${P}${trackId}`, playedAt: new Date(T0 + atSeconds * 1000), heard, duration, album };
}

/** Stores the plays, and the songs they are of (a song is as long as its first play says). */
async function given(rows: ReturnType<typeof play>[]) {
    const songs = new Map<string, { duration: number; album: string }>();
    for (const r of rows) if (!songs.has(r.trackId)) songs.set(r.trackId, { duration: r.duration, album: r.album });
    for (const [trackId, { duration, album }] of songs) {
        await prisma.track.create({
            data: {
                id: trackId, albumId: `${P}${album}`, title: trackId, trackNo: 1, duration,
                filePath: `/tmp/${trackId}.flac`, fileModified: new Date(), fileSize: 1000,
            },
        });
    }
    await prisma.play.createMany({
        data: rows.map((r) => ({ id: r.id, userId: USER, trackId: r.trackId, playedAt: r.playedAt, heard: r.heard })),
    });
}
/** The ids a listen or a candidate list carries, without the file prefix. */
const bare = (playIds: string[]) => playIds.map((id) => id.slice(P.length));

async function wipe() {
    await prisma.user.deleteMany({ where: { id: USER } }); // plays go with the user
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

beforeAll(wipe);
afterAll(wipe);
beforeEach(async () => {
    await wipe();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x" } });
    await prisma.artist.create({ data: { id: `${P}art`, name: "An Artist", identityKey: `${P}art` } });
    await prisma.album.create({
        data: { id: `${P}alb`, artistId: `${P}art`, title: "An Album", identityKey: `${P}alb`, rgMbid: `${P}alb`, primaryType: "Album" },
    });
    await prisma.album.create({
        data: {
            id: `${P}disc`, artistId: `${P}art`, title: "A Discover Album", identityKey: `${P}disc`, rgMbid: `${P}disc`,
            primaryType: "Album", location: "DISCOVER",
        },
    });
});

describe("listensOf", () => {
    it("folds the rows written while a track was still playing into one listen", async () => {
        // The pre-1.10.1 streaming endpoint wrote a row every half minute or so.
        await given([play("a", 0, 200), play("b", 44, 200), play("c", 126, 200), play("d", 173, 200)]);
        const listens = await listensOf(USER);
        expect(listens).toHaveLength(1);
        expect(listens[0].rows).toBe(4);
    });

    it("measures the window from where the listen began, not from the previous row", async () => {
        // A 214s track with rows at +0, +44, +126, +173, +230: the last starts
        // after the track ended, so it is a replay.
        await given([
            play("a", 0, 214), play("b", 44, 214), play("c", 126, 214),
            play("d", 173, 214), play("e", 230, 214),
        ]);
        const listens = await listensOf(USER);
        expect(listens).toHaveLength(2);
        expect(listens[1].startedAt.getTime()).toBe(T0 + 230_000);
    });

    it("opens a new listen at exactly one track length, where the track has ended", async () => {
        // The boundary all three places have to agree on: recording treats this
        // instant as a genuine replay rather than a duplicate, so the audit and
        // the stats walk must too.
        await given([play("a", 0, 100), play("b", 100, 100)]);
        expect(await listensOf(USER)).toHaveLength(2);
    });

    it("keeps a row one second inside the window in the same listen", async () => {
        await given([play("a", 0, 100), play("b", 99, 100)]);
        expect(await listensOf(USER)).toHaveLength(1);
    });

    it("uses a thirty second floor, so a very short track is not split by every row", async () => {
        await given([play("a", 0, 5), play("b", 10, 5), play("c", 40, 5)]);
        const listens = await listensOf(USER);
        expect(listens).toHaveLength(2);
    });

    it("groups per track, so two tracks interleaved do not merge", async () => {
        await given([
            play("a", 0, 300, "t1"), play("b", 5, 300, "t2"),
            play("c", 10, 300, "t1"), play("d", 15, 300, "t2"),
        ]);
        const listens = await listensOf(USER);
        expect(listens).toHaveLength(2);
        expect(listens.every((l) => l.rows === 2)).toBe(true);
    });

    it("says nothing about an empty history", async () => {
        await given([]);
        expect(await listensOf(USER)).toEqual([]);
    });
});

describe("collapseCandidates", () => {
    it("keeps the first and last row of a listen, so its span survives", async () => {
        // The span is the distance from a listen's first row to its last, and
        // "heard" is span >= required. Keeping only the first row set every
        // span to zero, which lost every proven-heard verdict and made at least
        // one listen newly deletable.
        await given([play("a", 0, 200), play("b", 44, 200), play("c", 126, 200), play("d", 173, 200)]);
        const listens = await listensOf(USER);
        expect(bare(collapseCandidates(listens))).toEqual(["b", "c"]);
    });

    it("removes nothing from a listen of two rows, which is the span itself", async () => {
        await given([play("a", 0, 200), play("b", 44, 200)]);
        expect(collapseCandidates(await listensOf(USER))).toEqual([]);
    });

    it("removes nothing from a single-row listen", async () => {
        await given([play("a", 0, 200)]);
        expect(collapseCandidates(await listensOf(USER))).toEqual([]);
    });
});

describe("plays recorded under the listen rule", () => {
    it("are never judged skipped, however soon the next play follows", async () => {
        // A 240s track counted after 120s heard, then the next track counted 90s later.
        await given([play("a", 0, 240, "t1", true), play("b", 90, 180, "t2", true)]);
        const [first] = await listensOf(USER);
        expect(first.verdict).toBe("heard");
    });

    it("leave an older row with the same gaps judged as before", async () => {
        await given([play("a", 0, 240, "t1"), play("b", 90, 180, "t2")]);
        const [first] = await listensOf(USER);
        expect(first.verdict).toBe("skipped");
    });
});

describe("Discover plays", () => {
    // A library song left after 10 seconds, a second library song, 90 seconds later a Discover song left after 10
    // seconds, then a heard library song much later.
    const history = () => [
        play("l1", 0, 200, "lib1"),
        play("l2", 10, 200, "lib2"),
        play("d1", 100, 200, "disc1", false, "disc"),
        play("d2", 110, 200, "disc2", false, "disc"),
        play("l3", 1000, 200, "lib3", true),
    ];

    it("are never reported by the false-start audit, nor counted in its totals", async () => {
        await given(history());
        const audit = await auditFalseStarts(USER);
        expect(audit.tracks.map((t) => t.trackId).sort()).toEqual([`${P}lib1`, `${P}lib2`]);
        expect(audit.totalRows).toBe(3);
        expect(audit.totalListens).toBe(3);
    });

    it("still end the gap after a library play: a Discover play after a library skip proves the skip", async () => {
        await given(history());
        // lib2 was left 90 seconds before the Discover play started; that is under the 100 seconds it needed.
        const lib2 = (await listensOf(USER)).find((l) => l.trackId === `${P}lib2`);
        expect(lib2).toMatchObject({ gapAfterSeconds: 90, verdict: "skipped" });
    });

    it("proves a skip removed with the library plays only, and leaves the Discover rows alone", async () => {
        await given(history());
        expect(await removeFalseStarts(USER, [`${P}lib1`, `${P}lib2`, `${P}disc1`, `${P}disc2`])).toEqual({ removed: 2, tracks: 2 });
        const left = await prisma.play.findMany({ where: { userId: USER }, select: { id: true }, orderBy: { playedAt: "asc" } });
        expect(bare(left.map((r) => r.id))).toEqual(["d1", "d2", "l3"]);
    });

    it("are never collapsed or removed by the audit's actions", async () => {
        await given([
            play("d1", 0, 200, "disc1", false, "disc"),
            play("d2", 40, 200, "disc1", false, "disc"),
            play("d3", 80, 200, "disc1", false, "disc"),
            play("d4", 120, 200, "disc2", false, "disc"),
        ]);
        expect(await collapseDuplicateRows(USER)).toEqual({ removed: 0 });
        expect(await removeFalseStarts(USER, [`${P}disc1`])).toEqual({ removed: 0, tracks: 0 });
        expect(await prisma.play.count({ where: { userId: USER } })).toBe(4);
    });
});

describe("the ignored list", () => {
    it("lists ignored library songs only, not Discover ones", async () => {
        await given([play("l1", 0, 200, "lib1"), play("d1", 10, 200, "disc1", false, "disc")]);
        await prisma.playAuditIgnore.createMany({
            data: [
                { userId: USER, trackId: `${P}lib1` },
                { userId: USER, trackId: `${P}disc1` },
            ],
        });
        const audit = await auditFalseStarts(USER);
        expect(audit.ignored.map((r) => r.trackId)).toEqual([`${P}lib1`]);
    });
});

describe("reading the history in pages", () => {
    /** A history with listens that span pages, Discover plays between library ones, and rows sharing one instant. */
    const mixed = () => {
        const rows: ReturnType<typeof play>[] = [];
        for (let i = 0; i < 12; i++) {
            const t = i * 400;
            const song = `s${i % 4}`;
            rows.push(play(`a${i}`, t, 200, song), play(`b${i}`, t + 10, 200, song), play(`c${i}`, t + 20, 200, song));
            if (i % 2 === 0) {
                // A Discover play 40 seconds after the last row: a library skip, proven only by the Discover play ending it.
                rows.push(play(`d${i}`, t + 60, 200, `d${i % 4}`, false, "disc"));
            } else {
                // A fourth row, and a Discover play too late to prove anything: unclear, with two rows a collapse may drop.
                rows.push(play(`e${i}`, t + 30, 200, song), play(`d${i}`, t + 150, 200, `d${i % 4}`, false, "disc"));
            }
        }
        rows.push(play("tie1", 5000, 200, "s5", true), play("tie2", 5000, 200, "s6", true), play("tie3", 5000, 200, "d9", false, "disc"));
        rows.push(play("z", 9000, 200, "s7"));
        return rows;
    };

    it("gives the same audit whatever the page size, with listens spanning page boundaries", async () => {
        await given(mixed());
        const whole = await auditFalseStarts(USER, { pageSize: 10_000 });
        expect(whole.totalListens).toBeGreaterThan(5);
        expect(whole.collapsibleRows).toBeGreaterThan(0);
        expect(whole.skipped).toBeGreaterThan(0);
        for (const pageSize of [1, 2, 3, 5, 7, 11]) {
            expect(await auditFalseStarts(USER, { pageSize })).toEqual(whole);
        }
    });

    it("gives the same listens whatever the page size, in the order they began", async () => {
        await given(mixed());
        const whole = await listensOf(USER, { pageSize: 10_000 });
        expect(await listensOf(USER, { pageSize: 3 })).toEqual(whole);
        expect(whole.map((l) => l.startedAt.getTime())).toEqual([...whole.map((l) => l.startedAt.getTime())].sort((x, y) => x - y));
    });

    it("collapses and removes the same rows whatever the page size", async () => {
        await given(mixed());
        const audit = await auditFalseStarts(USER);
        expect(audit.collapsibleRows).toBeGreaterThan(0);
        expect(audit.skipped).toBeGreaterThan(0);
        expect(await collapseDuplicateRows(USER, { pageSize: 3 })).toEqual({ removed: audit.collapsibleRows });
        // A collapse keeps each listen's first and last rows, so no verdict moved: each skipped listen has two rows left.
        const tracks = Array.from({ length: 4 }, (_, i) => `${P}s${i}`);
        expect(await removeFalseStarts(USER, tracks, { pageSize: 3 })).toEqual({ removed: audit.skipped * 2, tracks: audit.tracks.length });
        expect(await collapseDuplicateRows(USER, { pageSize: 3 })).toEqual({ removed: 0 });
        // Discover rows were never touched.
        expect(await prisma.play.count({ where: { userId: USER, id: { startsWith: `${P}d` } } })).toBe(12);
    });

    it("never asks for more than a page at a time, and takes several to read a longer history", async () => {
        await given(mixed());
        const spy = jest.spyOn(prisma.play, "findMany");
        await auditFalseStarts(USER, { pageSize: 10 });
        const asked = spy.mock.calls.map(([args]) => args?.take);
        spy.mockRestore();
        expect(asked.length).toBeGreaterThan(3);
        expect(asked.every((take) => take === 10)).toBe(true);
    });
});

describe("a play landing while the audit reads and deletes", () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    /** What a recordPlay in flight looks like: holding the shared lock with its row written but not committed. */
    async function recordingInFlight(write: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<void>) {
        let release!: () => void;
        const released = new Promise<void>((resolve) => (release = resolve));
        let locked!: () => void;
        const holding = new Promise<void>((resolve) => (locked = resolve));
        const tx = prisma.$transaction(
            async (t) => {
                await lockPlayHistory(t, USER);
                await write(t);
                locked();
                await released;
            },
            { timeout: 20_000 },
        );
        await holding;
        return { release, done: tx };
    }

    it("is seen by the removal: the read and the delete wait for it, so a verdict is never judged without it", async () => {
        // lib1 was left after 20 seconds (a skip); a heard row of it lands inside its window while the removal starts.
        await given([play("l1", 0, 200, "lib1"), play("l2", 30, 200, "lib2"), play("l3", 1000, 200, "lib3", true)]);
        const flight = await recordingInFlight(async (tx) => {
            await tx.play.create({ data: { id: `${P}late`, userId: USER, trackId: `${P}lib1`, playedAt: new Date(T0 + 20_000), heard: true } });
        });
        const removal = removeFalseStarts(USER, [`${P}lib1`]);
        await sleep(400); // long enough for an unguarded read to have finished
        flight.release();
        await flight.done;
        expect(await removal).toEqual({ removed: 0, tracks: 0 });
        expect(await prisma.play.count({ where: { userId: USER, trackId: `${P}lib1` } })).toBe(2);
    });

    it("is seen by the collapse in the same way", async () => {
        // Three rows of one listen: the middle one would be collapsed. A fourth row lands, and the collapse must judge four.
        await given([play("a", 0, 200), play("b", 40, 200), play("c", 80, 200)]);
        const flight = await recordingInFlight(async (tx) => {
            await tx.play.create({ data: { id: `${P}late`, userId: USER, trackId: `${P}t1`, playedAt: new Date(T0 + 60_000) } });
        });
        const collapse = collapseDuplicateRows(USER);
        await sleep(400);
        flight.release();
        await flight.done;
        expect(await collapse).toEqual({ removed: 2 });
        expect((await prisma.play.findMany({ where: { userId: USER } })).map((r) => r.id).sort()).toEqual([`${P}a`, `${P}c`]);
    });

    it("waits for a removal in progress: a play is recorded after it, never in the middle of it", async () => {
        await given([play("l1", 0, 200, "lib1")]);
        let release!: () => void;
        const released = new Promise<void>((resolve) => (release = resolve));
        let locked!: () => void;
        const holding = new Promise<void>((resolve) => (locked = resolve));
        const audit = prisma.$transaction(
            async (t) => {
                await lockPlayHistory(t, USER, { exclusive: true });
                locked();
                await released;
            },
            { timeout: 20_000 },
        );
        await holding;
        let recorded = false;
        const recording = recordPlay({ userId: USER, trackId: `${P}lib1`, secondsListened: 150, playedAt: new Date(T0 + 5000_000) }).then((o) => {
            recorded = true;
            return o;
        });
        await sleep(400);
        expect(recorded).toBe(false);
        release();
        await audit;
        expect(await recording).toMatchObject({ recorded: true });
    });
});


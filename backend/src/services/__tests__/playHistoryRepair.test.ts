/**
 * listensOf groups play rows into listens. Every case has an unambiguous answer.
 */

import { listensOf, collapseCandidates } from "../playHistoryRepair";
import { playHistory } from "../stats/listens";

jest.mock("../../utils/db", () => ({
    prisma: { play: { deleteMany: jest.fn() } },
}));

jest.mock("../stats/listens", () => ({
    ...jest.requireActual("../stats/listens"),
    playHistory: jest.fn(),
}));

const T0 = new Date("2026-03-01T12:00:00Z").getTime();

/** A play `atSeconds` into the session, of a track `duration` long. */
function play(id: string, atSeconds: number, duration: number, trackId = "t1", heard = false) {
    return {
        id,
        trackId,
        playedAt: new Date(T0 + atSeconds * 1000),
        heard,
        track: {
            title: id,
            displayTitle: null,
            duration,
            album: { artist: { name: "An Artist", displayName: null } },
        },
    };
}

const given = (rows: ReturnType<typeof play>[]) => (playHistory as jest.Mock).mockResolvedValue(rows);

beforeEach(() => jest.clearAllMocks());

describe("listensOf", () => {
    it("folds the rows written while a track was still playing into one listen", async () => {
        // The pre-1.10.1 streaming endpoint wrote a row every half minute or so.
        given([play("a", 0, 200), play("b", 44, 200), play("c", 126, 200), play("d", 173, 200)]);
        const listens = await listensOf("u1");
        expect(listens).toHaveLength(1);
        expect(listens[0].rows).toBe(4);
    });

    it("measures the window from where the listen began, not from the previous row", async () => {
        // A 214s track with rows at +0, +44, +126, +173, +230: the last starts
        // after the track ended, so it is a replay.
        given([
            play("a", 0, 214), play("b", 44, 214), play("c", 126, 214),
            play("d", 173, 214), play("e", 230, 214),
        ]);
        const listens = await listensOf("u1");
        expect(listens).toHaveLength(2);
        expect(listens[1].startedAt.getTime()).toBe(T0 + 230_000);
    });

    it("opens a new listen at exactly one track length, where the track has ended", async () => {
        // The boundary all three places have to agree on: recording treats this
        // instant as a genuine replay rather than a duplicate, so the audit and
        // the stats walk must too.
        given([play("a", 0, 100), play("b", 100, 100)]);
        expect(await listensOf("u1")).toHaveLength(2);
    });

    it("keeps a row one second inside the window in the same listen", async () => {
        given([play("a", 0, 100), play("b", 99, 100)]);
        expect(await listensOf("u1")).toHaveLength(1);
    });

    it("uses a thirty second floor, so a very short track is not split by every row", async () => {
        given([play("a", 0, 5), play("b", 10, 5), play("c", 40, 5)]);
        const listens = await listensOf("u1");
        expect(listens).toHaveLength(2);
    });

    it("groups per track, so two tracks interleaved do not merge", async () => {
        given([
            play("a", 0, 300, "t1"), play("b", 5, 300, "t2"),
            play("c", 10, 300, "t1"), play("d", 15, 300, "t2"),
        ]);
        const listens = await listensOf("u1");
        expect(listens).toHaveLength(2);
        expect(listens.every((l) => l.rows === 2)).toBe(true);
    });

    it("says nothing about an empty history", async () => {
        given([]);
        expect(await listensOf("u1")).toEqual([]);
    });
});

describe("collapseCandidates", () => {
    it("keeps the first and last row of a listen, so its span survives", async () => {
        // The span is the distance from a listen's first row to its last, and
        // "heard" is span >= required. Keeping only the first row set every
        // span to zero, which lost every proven-heard verdict and made at least
        // one listen newly deletable.
        given([play("a", 0, 200), play("b", 44, 200), play("c", 126, 200), play("d", 173, 200)]);
        const listens = await listensOf("u1");
        expect(collapseCandidates(listens)).toEqual(["b", "c"]);
    });

    it("removes nothing from a listen of two rows, which is the span itself", async () => {
        given([play("a", 0, 200), play("b", 44, 200)]);
        expect(collapseCandidates(await listensOf("u1"))).toEqual([]);
    });

    it("removes nothing from a single-row listen", async () => {
        given([play("a", 0, 200)]);
        expect(collapseCandidates(await listensOf("u1"))).toEqual([]);
    });
});

describe("plays recorded under the listen rule", () => {
    it("are never judged skipped, however soon the next play follows", async () => {
        // A 240s track counted after 120s heard, then the next track counted 90s later.
        given([play("a", 0, 240, "t1", true), play("b", 90, 180, "t2", true)]);
        const [first] = await listensOf("u1");
        expect(first.verdict).toBe("heard");
    });

    it("leave an older row with the same gaps judged as before", async () => {
        given([play("a", 0, 240, "t1"), play("b", 90, 180, "t2")]);
        const [first] = await listensOf("u1");
        expect(first.verdict).toBe("skipped");
    });
});

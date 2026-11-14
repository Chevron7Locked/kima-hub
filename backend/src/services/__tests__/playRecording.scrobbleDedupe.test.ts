/**
 * Play dedupe on the real database: simultaneous reports of one play store one
 * row, and a late scrobble is kept even when the track was played since.
 */

import { ListenSource } from "@prisma/client";
import { prisma } from "../../utils/db";
import { dedupWindowMs, recordPlay } from "../playRecording";
import { createTrackChain, deleteFixtures } from "./helpers/trackChainFixture";

jest.mock("../../utils/logger", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

// Nothing here may reach ListenBrainz. With no token configured the real
// service self-skips, but a token saved in SystemSettings would make these
// tests hit the network — pin the service instead.
jest.mock("../listenBrainz", () => ({
    listenBrainzService: { submitListens: jest.fn() },
}));

 
const { listenBrainzService } = require("../listenBrainz");

/** Every row this file creates is keyed off this prefix so cleanup is exact. */
const PREFIX = "s6-dedupe";

function cleanup() {
    return deleteFixtures(PREFIX);
}

/**
 * A user, an artist/album/track chain, and nothing else. `duration` is 200 s by
 * default, so the dedupe window is 200 s and a play dated a day earlier sits far
 * outside it: the late-sync case.
 */
async function fixture(label: string, duration = 200) {
    const { track, user } = await createTrackChain(PREFIX, label, { duration });
    return { track, user };
}

/** A Subsonic-shaped report: the client attests the play, no seconds measured. */
function scrobble(
    fx: { track: { id: string }; user: { id: string } },
    playedAt: Date,
) {
    return recordPlay({
        userId: fx.user.id,
        trackId: fx.track.id,
        source: ListenSource.SUBSONIC,
        playedAt,
        clientAttestedComplete: true,
    });
}

describe("playRecording against the real database", () => {
    beforeAll(cleanup);
    afterAll(cleanup);

    beforeEach(() => {
        jest.clearAllMocks();
        listenBrainzService.submitListens.mockResolvedValue(false);
    });

    it("stores one row when the same play is reported in parallel", async () => {
        // Twenty-four concurrent reports of one play, each a millisecond apart.
        const fx = await fixture("parallel");
        const t0 = Date.now();

        const reports = await Promise.all(
            Array.from({ length: 24 }, (_, i) => scrobble(fx, new Date(t0 + i))),
        );

        const rows = await prisma.play.count({
            where: { userId: fx.user.id, trackId: fx.track.id },
        });
        expect(rows).toBe(1);

        // Exactly one caller may be told "recorded"; the rest must be told
        // "duplicate", or the audit trail and the ListenBrainz mirror both
        // double-count the listen.
        expect(reports.filter((r) => r.recorded)).toHaveLength(1);
        expect(reports.filter((r) => !r.recorded)).toEqual(
            Array.from({ length: 23 }, () => ({ recorded: false, reason: "duplicate" })),
        );
    });

    it("stores one row for reports 7 ms apart", async () => {
        // The web-player shape: two reports a few milliseconds apart, so no
        // unique index on (userId, trackId, playedAt) could catch it even if
        // one existed. Both fall inside the track's own window, so the second
        // is the same listen described twice.
        const fx = await fixture("seven-ms");
        const t0 = Date.now();

        const reports = await Promise.all([
            scrobble(fx, new Date(t0)),
            scrobble(fx, new Date(t0 + 7)),
        ]);

        const rows = await prisma.play.count({
            where: { userId: fx.user.id, trackId: fx.track.id },
        });
        expect(rows).toBe(1);
        expect(reports.filter((r) => r.recorded)).toHaveLength(1);
    });

    it("keeps a scrobble that arrives 24 hours late", async () => {
        // A device back-fills yesterday's plays: the window is centred on the
        // play, so a newer row does not veto it.
        const fx = await fixture("late-sync");
        const now = new Date("2026-09-25T12:00:00.000Z");
        const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

        const first = await scrobble(fx, now);
        const late = await scrobble(fx, dayAgo);

        expect(first).toEqual({ recorded: true, playId: expect.any(String) });
        expect(late).toEqual({ recorded: true, playId: expect.any(String) });

        const rows = await prisma.play.findMany({
            where: { userId: fx.user.id, trackId: fx.track.id },
            select: { playedAt: true },
        });
        expect(rows).toHaveLength(2);
    });

    it("records plays that land exactly on either edge of the window", async () => {
        // Both edges are strict. A 200 s track played at 12:00 and again at
        // 12:03:20 is two listens — by then the song could have finished — and
        // the same holds in the past direction for a back-filled report.
        const fx = await fixture("window-edges");
        const anchor = new Date("2026-09-25T12:00:00.000Z");
        const window = dedupWindowMs(fx.track.duration);
        expect(window).toBe(fx.track.duration * 1000);

        expect(await scrobble(fx, anchor)).toEqual({
            recorded: true,
            playId: expect.any(String),
        });
        expect(await scrobble(fx, new Date(anchor.getTime() + window))).toEqual({
            recorded: true,
            playId: expect.any(String),
        });
        expect(await scrobble(fx, new Date(anchor.getTime() - window))).toEqual({
            recorded: true,
            playId: expect.any(String),
        });

        const rows = await prisma.play.count({
            where: { userId: fx.user.id, trackId: fx.track.id },
        });
        expect(rows).toBe(3);
    });

    it("treats a play anywhere inside the window as the same listen", async () => {
        // Same track, one second short of either edge — before and after. The
        // song could not have finished, so it is one listen described twice.
        const fx = await fixture("inside-window");
        const anchor = new Date("2026-09-25T12:00:00.000Z");
        const window = dedupWindowMs(fx.track.duration);

        expect(await scrobble(fx, anchor)).toEqual({
            recorded: true,
            playId: expect.any(String),
        });
        expect(await scrobble(fx, new Date(anchor.getTime() + window - 1000))).toEqual({
            recorded: false,
            reason: "duplicate",
        });
        expect(await scrobble(fx, new Date(anchor.getTime() - window + 1000))).toEqual({
            recorded: false,
            reason: "duplicate",
        });

        const rows = await prisma.play.count({
            where: { userId: fx.user.id, trackId: fx.track.id },
        });
        expect(rows).toBe(1);
    });
});
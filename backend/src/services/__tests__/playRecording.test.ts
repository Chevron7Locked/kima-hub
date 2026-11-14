/**
 * A play is recorded by the Last.fm rule, not by hitting the stream endpoint.
 * Real database: the song, the user and the plays are rows. ListenBrainz is stubbed.
 */

import { ListenSource } from "@prisma/client";
import {
    MAX_REQUIRED_SECONDS,
    MIN_TRACK_DURATION_SECONDS,
    recordPlay,
    requiredListenSeconds,
} from "../playRecording";
import { prisma } from "../../utils/db";

// The ListenBrainz mirror must never hit the network from tests. Pin the
// service; each test decides whether it resolves or rejects.
jest.mock("../listenBrainz", () => ({
    listenBrainzService: {
        submitListens: jest.fn(),
        getUserToken: jest.fn(),
    },
}));

const { listenBrainzService } = require("../listenBrainz");

const P = "zz-playRecording-";
const USER = `${P}u1`;
const TRACK = `${P}t1`;

async function wipe() {
    await prisma.user.deleteMany({ where: { id: USER } }); // plays go with the user
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}
/** The song a play is of, `duration` seconds long. */
async function seedTrack(duration: number, title = "Windowless Pane") {
    await prisma.track.create({
        data: {
            id: TRACK, albumId: `${P}alb`, title, trackNo: 1, duration,
            filePath: `/tmp/${TRACK}.flac`, fileModified: new Date(), fileSize: 1000,
        },
    });
}
const plays = () => prisma.play.findMany({ where: { userId: USER }, orderBy: { playedAt: "asc" } });
/** A report of the song, with the user and track filled in. */
const report = (rest: Record<string, unknown>) => recordPlay({ userId: USER, trackId: TRACK, ...rest } as never);
const earlierPlay = () =>
    prisma.play.create({ data: { userId: USER, trackId: TRACK, playedAt: new Date(Date.now() - 60_000) } });

beforeAll(wipe);
afterAll(wipe);

beforeEach(async () => {
    jest.clearAllMocks();
    await wipe();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x" } });
    await prisma.artist.create({ data: { id: `${P}art`, name: "The Glazier", identityKey: `${P}art` } });
    await prisma.album.create({
        data: { id: `${P}alb`, artistId: `${P}art`, title: "Glass Works", identityKey: `${P}alb`, rgMbid: `${P}alb`, primaryType: "Album" },
    });
    // Default: no token configured — the real service skips and resolves
    // false. Individual tests override when they want a submit to happen.
    listenBrainzService.submitListens.mockResolvedValue(false);
});

describe("requiredListenSeconds", () => {
    it("refuses a track at or under 30 seconds outright", () => {
        // Not "needs a lot of listening" -- can never qualify, at any amount.
        expect(requiredListenSeconds(30)).toBeNull();
        expect(requiredListenSeconds(12)).toBeNull();
    });

    it("asks for half the length just past the floor", () => {
        expect(requiredListenSeconds(31)).toBeCloseTo(15.5);
        expect(requiredListenSeconds(200)).toBe(100);
    });

    it("never asks for more than four minutes, however long the track", () => {
        expect(requiredListenSeconds(600)).toBe(MAX_REQUIRED_SECONDS);
        expect(requiredListenSeconds(60 * 60)).toBe(MAX_REQUIRED_SECONDS);
    });

    it("demands the four-minute bound when the length is unknown", () => {
        // duration is a non-null Int, so an unscanned track arrives as 0. If that
        // were treated as "eligible immediately", never scanning a file would be
        // the cheapest way to log a play.
        expect(requiredListenSeconds(0)).toBe(MAX_REQUIRED_SECONDS);
        expect(requiredListenSeconds(null)).toBe(MAX_REQUIRED_SECONDS);
        expect(requiredListenSeconds(undefined)).toBe(MAX_REQUIRED_SECONDS);
        expect(requiredListenSeconds(Number.NaN)).toBe(MAX_REQUIRED_SECONDS);
        expect(requiredListenSeconds(-5)).toBe(MAX_REQUIRED_SECONDS);
    });

    it("puts the floor on the track, not on the listening", () => {
        // A 40s track needs 20s. Clamping the requirement up to 30 would make
        // three quarters of a short track worth less than half a long one.
        expect(requiredListenSeconds(40)).toBe(20);
        expect(requiredListenSeconds(40)).toBeLessThan(MIN_TRACK_DURATION_SECONDS);
    });
});

describe("recordPlay", () => {
    it("writes a row once the listening earns it", async () => {
        await seedTrack(200);
        const out = await report({ secondsListened: 100 });
        const rows = await plays();
        expect(rows).toHaveLength(1);
        expect(out).toEqual({ recorded: true, playId: rows[0].id });
        expect(rows[0]).toMatchObject({ trackId: TRACK, source: ListenSource.LIBRARY, heard: true });
    });

    it("writes nothing when the track was barely played", async () => {
        await seedTrack(200);
        const out = await report({ secondsListened: 5 });
        expect(out).toEqual({ recorded: false, reason: "not-enough-listened" });
        expect(await plays()).toHaveLength(0);
    });

    it("rejects listening just under the required amount, and nonsense values", async () => {
        await seedTrack(200);
        const short = await report({ secondsListened: 99.9 });
        expect(short).toEqual({ recorded: false, reason: "not-enough-listened" });
        for (const secondsListened of [Number.NaN, -10]) {
            const out = await report({ secondsListened });
            expect(out).toEqual({ recorded: false, reason: "not-enough-listened" });
        }
        expect(await plays()).toHaveLength(0);
    });

    it("writes nothing for a track under the 30-second floor", async () => {
        await seedTrack(20);
        const out = await report({ secondsListened: 20 });
        expect(out).toEqual({ recorded: false, reason: "too-short" });
        expect(await plays()).toHaveLength(0);
    });

    it("makes an unscanned track the hardest to scrobble, not the easiest", async () => {
        await seedTrack(0);
        expect(await report({ secondsListened: 239 })).toEqual({ recorded: false, reason: "not-enough-listened" });
        expect(await report({ secondsListened: 240 })).toMatchObject({ recorded: true });
    });

    it("collapses a repeat inside the dedup window to one row", async () => {
        await seedTrack(200);
        await earlierPlay();
        const out = await report({ secondsListened: 150 });
        expect(out).toEqual({ recorded: false, reason: "duplicate" });
        expect(await plays()).toHaveLength(1);
    });

    it("pins the duplicate window to ±one duration around the reported play, edges excluded", async () => {
        // Both edges: a one-sided window lets any newer play veto a late-synced scrobble as a duplicate,
        // and exactly one duration away the song has finished, so that play is a genuine replay.
        await seedTrack(200);
        const at = new Date("2026-09-25T12:00:00.000Z");
        await prisma.play.create({ data: { userId: USER, trackId: TRACK, playedAt: at } });

        for (const offset of [-199_999, 199_999]) {
            const inside = await report({ playedAt: new Date(at.getTime() + offset), clientAttestedComplete: true });
            expect(inside).toEqual({ recorded: false, reason: "duplicate" });
        }
        for (const offset of [-200_000, 200_000]) {
            const when = new Date(at.getTime() + offset);
            expect((await report({ playedAt: when, clientAttestedComplete: true })).recorded).toBe(true);
            await prisma.play.deleteMany({ where: { userId: USER, playedAt: when } });
        }
    });

    it("lets a late-synced play through when a newer play of the track is already stored", async () => {
        await seedTrack(200);
        await prisma.play.create({ data: { userId: USER, trackId: TRACK, playedAt: new Date() } });
        const out = await report({ playedAt: new Date(Date.now() - 5 * 3600_000), clientAttestedComplete: true });
        expect(out.recorded).toBe(true);
        expect(await plays()).toHaveLength(2);
    });

    it("writes one row when the same play is reported several times at once", async () => {
        // The lock: the duplicate check and the insert are one decision, so concurrent reports cannot both write.
        await seedTrack(200);
        const outcomes = await Promise.all([1, 2, 3, 4].map(() => report({ secondsListened: 150 })));
        expect(outcomes.filter((o) => o.recorded)).toHaveLength(1);
        expect(outcomes.filter((o) => !o.recorded)).toEqual(Array(3).fill({ recorded: false, reason: "duplicate" }));
        expect(await plays()).toHaveLength(1);
    });

    it("reads the duration from the database, never from the caller", async () => {
        // A client claiming a 3-second jingle is an hour long must not be able to
        // scrobble it on two seconds of audio.
        await seedTrack(3);
        const out = await report({ secondsListened: 2, source: ListenSource.SUBSONIC });
        expect(out).toEqual({ recorded: false, reason: "too-short" });
    });

    it("reports an unknown track rather than inventing one", async () => {
        const out = await recordPlay({ userId: USER, trackId: `${P}nope`, secondsListened: 999 });
        expect(out).toEqual({ recorded: false, reason: "unknown-track" });
        expect(await plays()).toHaveLength(0);
    });

    it("carries the source through, so the cutover stays auditable", async () => {
        await seedTrack(200);
        await report({ secondsListened: 150, source: ListenSource.SUBSONIC });
        expect((await plays())[0].source).toBe(ListenSource.SUBSONIC);
    });

    it("stores the play at the time it is reported for", async () => {
        await seedTrack(200);
        const playedAt = new Date("2026-05-01T08:30:00.000Z");
        await report({ secondsListened: 150, playedAt });
        expect((await plays())[0].playedAt).toEqual(playedAt);
    });
});

describe("recordPlay with a client-attested play (Subsonic scrobble)", () => {
    it("records a scrobble the client says was played, with no seconds reported", async () => {
        // The play is attested, not timed: it must not be dropped by the
        // finite-seconds guard.
        await seedTrack(200);
        const out = await report({ clientAttestedComplete: true, source: ListenSource.SUBSONIC });
        expect(out.recorded).toBe(true);
        expect(await plays()).toHaveLength(1);
    });

    it("still refuses a track under the 30-second floor, whatever the client claims", async () => {
        await seedTrack(20);
        const out = await report({ clientAttestedComplete: true });
        expect(out).toEqual({ recorded: false, reason: "too-short" });
        expect(await plays()).toHaveLength(0);
    });

    it("still collapses a repeat inside the dedup window", async () => {
        await seedTrack(200);
        await earlierPlay();
        const out = await report({ clientAttestedComplete: true });
        expect(out).toEqual({ recorded: false, reason: "duplicate" });
        expect(await plays()).toHaveLength(1);
    });

    it("does not let a measured caller pass Infinity to skip the listening rule", async () => {
        await seedTrack(200);
        const out = await report({ secondsListened: Number.POSITIVE_INFINITY });
        expect(out).toEqual({ recorded: false, reason: "not-enough-listened" });
    });
});

describe("ListenBrainz mirror", () => {
    /** Let the fire-and-forget submit settle before asserting. */
    const flush = () => new Promise((r) => setTimeout(r, 0));

    it("records the play even when no token is configured (submit self-skips)", async () => {
        // The service's documented no-token path: resolves false, never
        // throws. The play log must not care either way.
        await seedTrack(200);
        const out = await report({ secondsListened: 150 });
        expect(out.recorded).toBe(true);
        await flush();
    });

    it("mirrors a recorded play with artist, track and release", async () => {
        await seedTrack(200);
        listenBrainzService.submitListens.mockResolvedValue(true);
        const out = await report({ secondsListened: 150 });
        expect(out.recorded).toBe(true);
        await flush();
        expect(listenBrainzService.submitListens).toHaveBeenCalledTimes(1);
        expect(listenBrainzService.submitListens).toHaveBeenCalledWith(USER, [
            expect.objectContaining({
                artist: "The Glazier",
                track: "Windowless Pane",
                release: "Glass Works",
            }),
        ]);
    });

    it("a dead or rejecting ListenBrainz never fails the play", async () => {
        await seedTrack(200);
        listenBrainzService.submitListens.mockRejectedValue(new Error("LB down"));
        const out = await report({ secondsListened: 150 });
        expect(out.recorded).toBe(true);
        await flush(); // let the rejection land in the swallow, not in jest
        expect(await plays()).toHaveLength(1);
    });

    it("does not mirror a play that was not recorded", async () => {
        await seedTrack(200);
        await earlierPlay();
        const out = await report({ secondsListened: 150 });
        expect(out).toEqual({ recorded: false, reason: "duplicate" });
        await flush();
        expect(listenBrainzService.submitListens).not.toHaveBeenCalled();
    });

    it("does not mirror when the song has no title", async () => {
        // A song scanned without a title has nothing to name to ListenBrainz: the mirror skips,
        // the play still counts.
        await seedTrack(200, "");
        const out = await report({ secondsListened: 150 });
        expect(out.recorded).toBe(true);
        await flush();
        expect(listenBrainzService.submitListens).not.toHaveBeenCalled();
    });
});

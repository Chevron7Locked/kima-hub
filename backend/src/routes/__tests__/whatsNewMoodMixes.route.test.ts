/**
 * The release window's mood-mix choice (rebuild, keep, save as playlist): nothing
 * is wiped before the user chooses, every endpoint is safe to repeat, and a bad
 * mix id is 404. Real database; auth and Redis are stubbed.
 */

jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: any, _res: any, next: any) => {
        req.user = { id: req.headers["x-test-user"], username: "t", role: "user" };
        next();
    },
}));

jest.mock("../../utils/redis", () => ({
    redisClient: { del: jest.fn().mockResolvedValue(1) },
}));

import express from "express";
import request from "supertest";
import whatsNewRoutes from "../whatsNew";
import { prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";
import { eventBus, type SSEEvent } from "../../services/eventBus";

const PREFIX = "whatsnew-moodmix-test";
const GENERATED_AT = new Date("2026-09-01T12:00:00.000Z");
const MIX_ID = `your-mood-mix-${GENERATED_AT.getTime()}`;

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use("/whats-new", whatsNewRoutes);
    return app;
}

async function cleanup() {
    await prisma.user.deleteMany({ where: { username: { startsWith: PREFIX } } });
    await prisma.artist.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

/** A user with three real tracks and a saved Upbeat mix over them (plus one dangling id). */
async function fixture(opts: { withMix?: boolean; mood?: string } = {}) {
    const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const user = await prisma.user.create({
        data: { username: `${PREFIX}-${tag}`, passwordHash: "x", role: "user" },
    });
    const artist = await prisma.artist.create({
        data: { name: `${PREFIX}-${tag}-artist`, identityKey: `${PREFIX}-${tag}` },
    });
    const album = await prisma.album.create({
        data: {
            artistId: artist.id,
            rgMbid: `${PREFIX}-${tag}-mbid`,
            title: `${PREFIX}-${tag}-album`,
            primaryType: "Album",
            location: "LIBRARY",
        },
    });
    const tracks = [];
    for (let i = 0; i < 3; i++) {
        tracks.push(
            await prisma.track.create({
                data: {
                    albumId: album.id,
                    title: `${PREFIX}-${tag}-t${i}`,
                    trackNo: i + 1,
                    duration: 200,
                    filePath: `/tmp/${PREFIX}-${tag}-${i}.flac`,
                    fileModified: new Date(),
                    fileSize: 1000,
                },
            }),
        );
    }
    // Deliberately not library order, so the test can see mix order is kept.
    const trackIds = [tracks[2].id, tracks[0].id, tracks[1].id];
    if (opts.withMix !== false) {
        await prisma.userMoodMix.create({
            data: {
                userId: user.id,
                mood: opts.mood ?? "happy",
                trackIds: [...trackIds, "no-such-track"],
                coverUrls: [],
                generatedAt: GENERATED_AT,
            },
        });
    }
    return { userId: user.id, trackIds };
}

const app = makeApp();
const as = (userId: string) => ({
    get: (path: string) => request(app).get(path).set("x-test-user", userId),
    post: (path: string, body?: object) =>
        request(app).post(path).set("x-test-user", userId).send(body ?? {}),
});

beforeAll(cleanup);
afterAll(cleanup);
beforeEach(() => jest.clearAllMocks());

describe("GET /whats-new/pending — who is asked", () => {
    const has = (releases: any[]) =>
        releases.some((r) => r.items.some((i: any) => i.key === "moods.mixes"));

    it("asks a user who has a saved mood mix", async () => {
        const { userId } = await fixture();
        const res = await as(userId).get("/whats-new/pending");
        expect(res.status).toBe(200);
        expect(has(res.body.releases)).toBe(true);
    });

    it("does not ask a user with no mood mix, and keeps the rest of the release", async () => {
        const { userId } = await fixture({ withMix: false });
        const res = await as(userId).get("/whats-new/pending");
        expect(res.status).toBe(200);
        expect(has(res.body.releases)).toBe(false);
        const r111 = res.body.releases.find((r: any) => r.version === "1.11.0");
        expect(r111.items.map((i: any) => i.key)).toContain("stats.page");
    });

    it("asks a user whose mix is under a removed mood the save/remove question instead", async () => {
        const { userId } = await fixture({ mood: "focus" });
        const res = await as(userId).get("/whats-new/pending");
        const keys = res.body.releases.flatMap((r: any) => r.items.map((i: any) => i.key));
        expect(keys).toContain("moods.mixes.retired");
        expect(keys).not.toContain("moods.mixes");
    });
});

describe("GET /whats-new/mood-mixes", () => {
    it("describes the saved mix before anything is decided", async () => {
        const { userId } = await fixture();
        const res = await as(userId).get("/whats-new/mood-mixes");
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            mix: { id: MIX_ID, name: "Your Upbeat Mix", mood: "happy", trackCount: 4, retired: false },
            decision: null,
            playlist: null,
        });
    });
});

describe("keep", () => {
    it("records the answer and touches nothing, however often it is sent", async () => {
        const { userId } = await fixture();
        for (let i = 0; i < 2; i++) {
            const res = await as(userId).post("/whats-new/mood-mixes/decision", { decision: "keep" });
            expect(res.status).toBe(200);
            expect(res.body).toEqual({ decision: "keep", removed: 0 });
        }
        expect(await prisma.userMoodMix.count({ where: { userId } })).toBe(1);
        const choice = await prisma.releaseChoice.findMany({ where: { userId } });
        expect(choice).toHaveLength(1);
        expect(choice[0]).toMatchObject({ key: "moods.mixes.rebuild", enabled: false, decidedBy: "EXPLICIT", version: "1.11.0" });
        expect(redisClient.del).not.toHaveBeenCalled();
        expect((await as(userId).get("/whats-new/mood-mixes")).body.decision).toBe("keep");
    });
});

describe("rebuild", () => {
    it("clears the saved mix and the cached mix list; a repeat is a 200 that removes nothing", async () => {
        const { userId } = await fixture();

        const first = await as(userId).post("/whats-new/mood-mixes/decision", { decision: "rebuild" });
        expect(first.status).toBe(200);
        expect(first.body).toEqual({ decision: "rebuild", removed: 1 });
        expect(await prisma.userMoodMix.count({ where: { userId } })).toBe(0);
        expect(redisClient.del).toHaveBeenCalledWith(`mixes:${userId}`);

        const again = await as(userId).post("/whats-new/mood-mixes/decision", { decision: "rebuild" });
        expect(again.status).toBe(200);
        expect(again.body).toEqual({ decision: "rebuild", removed: 0 });

        const state = await as(userId).get("/whats-new/mood-mixes");
        expect(state.body).toEqual({ mix: null, decision: "rebuild", playlist: null });
        expect(
            await prisma.releaseChoice.count({ where: { userId, key: "moods.mixes.rebuild", enabled: true } }),
        ).toBe(1);
    });

    it("only clears the asking user's mix", async () => {
        const a = await fixture();
        const b = await fixture();
        await as(a.userId).post("/whats-new/mood-mixes/decision", { decision: "rebuild" });
        expect(await prisma.userMoodMix.count({ where: { userId: b.userId } })).toBe(1);
    });

    it("rejects an unknown decision with 400 and changes nothing", async () => {
        const { userId } = await fixture();
        const res = await as(userId).post("/whats-new/mood-mixes/decision", { decision: "wipe" });
        expect(res.status).toBe(400);
        expect(await prisma.userMoodMix.count({ where: { userId } })).toBe(1);
        expect(await prisma.releaseChoice.count({ where: { userId } })).toBe(0);
    });
});

describe("save as playlist", () => {
    async function items(playlistId: string) {
        return prisma.playlistItem.findMany({ where: { playlistId }, orderBy: { rank: "asc" } });
    }

    it("makes an ordinary playlist in the mix's order, with lexoRank ranks, dropping tracks that are gone", async () => {
        const { userId, trackIds } = await fixture();
        const res = await as(userId).post("/whats-new/mood-mixes/save", { mixId: MIX_ID });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ name: "Your Upbeat Mix", trackCount: 3, created: true });

        const rows = await items(res.body.id);
        expect(rows.map((r) => r.trackId)).toEqual(trackIds);
        expect(new Set(rows.map((r) => r.rank)).size).toBe(3);
        expect(rows.every((r) => r.rank !== "")).toBe(true);

        const playlist = await prisma.playlist.findUniqueOrThrow({ where: { id: res.body.id } });
        expect(playlist).toMatchObject({ userId, mixId: MIX_ID, isPublic: false });
        // Saving does not decide anything about the mix itself.
        expect(await prisma.userMoodMix.count({ where: { userId } })).toBe(1);
        expect((await as(userId).get("/whats-new/mood-mixes")).body.playlist).toEqual({
            id: res.body.id,
            name: "Your Upbeat Mix",
        });
    });

    it("saving twice returns the same playlist and adds nothing", async () => {
        const { userId } = await fixture();
        const heard: SSEEvent[] = [];
        const stop = eventBus.subscribe(userId, { send: (event) => (heard.push(event), true) });
        try {
            const first = await as(userId).post("/whats-new/mood-mixes/save", { mixId: MIX_ID });
            // The new playlist reaches the saver's other devices; the second save changes nothing, so it is quiet.
            expect(heard.map((e) => e.payload)).toEqual([{ playlistId: first.body.id, deleted: false }]);
            const second = await as(userId).post("/whats-new/mood-mixes/save", { mixId: MIX_ID });
            expect(second.status).toBe(200);
            expect(second.body).toMatchObject({ id: first.body.id, trackCount: 3, created: false });
            expect(heard).toHaveLength(1);
            expect(await prisma.playlist.count({ where: { userId } })).toBe(1);
            expect(await items(first.body.id)).toHaveLength(3);
        } finally {
            stop();
        }
    });

    it("save then rebuild: the playlist survives, the mix is gone, and a later save is a 404", async () => {
        const { userId, trackIds } = await fixture();
        const saved = await as(userId).post("/whats-new/mood-mixes/save", { mixId: MIX_ID });
        expect(saved.status).toBe(200);

        const rebuilt = await as(userId).post("/whats-new/mood-mixes/decision", { decision: "rebuild" });
        expect(rebuilt.body).toEqual({ decision: "rebuild", removed: 1 });

        expect(await prisma.userMoodMix.count({ where: { userId } })).toBe(0);
        expect((await items(saved.body.id)).map((r) => r.trackId)).toEqual(trackIds);

        const late = await as(userId).post("/whats-new/mood-mixes/save", { mixId: MIX_ID });
        expect(late.status).toBe(404);
    });

    it("an unknown mix id is a 404 and creates nothing", async () => {
        const { userId } = await fixture();
        const res = await as(userId).post("/whats-new/mood-mixes/save", { mixId: "your-mood-mix-1" });
        expect(res.status).toBe(404);
        expect(await prisma.playlist.count({ where: { userId } })).toBe(0);
    });

    it("another user's mix id is a 404", async () => {
        const owner = await fixture();
        const other = await fixture({ withMix: false });
        const res = await as(other.userId).post("/whats-new/mood-mixes/save", { mixId: MIX_ID });
        expect(res.status).toBe(404);
        expect(await prisma.playlist.count({ where: { userId: { in: [owner.userId, other.userId] } } })).toBe(0);
    });

    it("a missing or non-string mix id is a 400", async () => {
        const { userId } = await fixture();
        expect((await as(userId).post("/whats-new/mood-mixes/save", {})).status).toBe(400);
        expect((await as(userId).post("/whats-new/mood-mixes/save", { mixId: 42 })).status).toBe(400);
    });
});

describe("a mix under a mood 1.11 removed", () => {
    const pendingKeys = async (userId: string) =>
        (await as(userId).get("/whats-new/pending")).body.releases.map((r: any) => ({
            version: r.version,
            keys: r.items.map((i: any) => i.key),
        }));

    it("is described with its old mood's name and marked retired", async () => {
        const { userId } = await fixture({ mood: "melancholy" });
        const res = await as(userId).get("/whats-new/mood-mixes");
        expect(res.body.mix).toEqual({
            id: MIX_ID,
            name: "Your Deep Feels Mix",
            mood: "melancholy",
            trackCount: 4,
            retired: true,
        });
    });

    it("names a mood nobody listed from its id", async () => {
        const { userId } = await fixture({ mood: "late-night" });
        expect((await as(userId).get("/whats-new/mood-mixes")).body.mix.name).toBe("Your Late Night Mix");
    });

    it("can be saved as a playlist, in order, named after the old mood; a repeat adds nothing", async () => {
        const { userId, trackIds } = await fixture({ mood: "focus" });
        const first = await as(userId).post("/whats-new/mood-mixes/save", { mixId: MIX_ID });
        expect(first.status).toBe(200);
        expect(first.body).toMatchObject({ name: "Your Focus Mode Mix", trackCount: 3, created: true });
        const rows = await prisma.playlistItem.findMany({
            where: { playlistId: first.body.id },
            orderBy: { rank: "asc" },
        });
        expect(rows.map((r) => r.trackId)).toEqual(trackIds);

        const again = await as(userId).post("/whats-new/mood-mixes/save", { mixId: MIX_ID });
        expect(again.body).toMatchObject({ id: first.body.id, trackCount: 3, created: false });
        expect(await prisma.playlist.count({ where: { userId } })).toBe(1);
    });

    it("can be removed; a repeat is a 200 that removes nothing", async () => {
        const { userId } = await fixture({ mood: "energetic" });
        const first = await as(userId).post("/whats-new/mood-mixes/decision", { decision: "remove" });
        expect(first.status).toBe(200);
        expect(first.body).toEqual({ decision: "remove", removed: 1 });
        expect(await prisma.userMoodMix.count({ where: { userId } })).toBe(0);
        const again = await as(userId).post("/whats-new/mood-mixes/decision", { decision: "remove" });
        expect(again.status).toBe(200);
        expect(again.body).toEqual({ decision: "remove", removed: 0 });
    });

    it("cannot be kept: 400, and nothing is recorded or deleted", async () => {
        const { userId } = await fixture({ mood: "acoustic" });
        const res = await as(userId).post("/whats-new/mood-mixes/decision", { decision: "keep" });
        expect(res.status).toBe(400);
        expect(await prisma.userMoodMix.count({ where: { userId } })).toBe(1);
        expect(await prisma.releaseChoice.count({ where: { userId } })).toBe(0);
    });

    it("survives closing the window, and is asked about again until saved", async () => {
        const { userId } = await fixture({ mood: "focus" });
        expect((await as(userId).post("/whats-new/1.11.0/dismiss")).status).toBe(200);
        expect(await prisma.userMoodMix.count({ where: { userId } })).toBe(1);

        const next = (await pendingKeys(userId)).find((r: any) => r.version === "1.11.0");
        expect(next).toEqual({ version: "1.11.0", keys: ["moods.mixes.retired"] });

        // Closing the re-ask changes nothing either.
        await as(userId).post("/whats-new/1.11.0/dismiss");
        expect(await prisma.userMoodMix.count({ where: { userId } })).toBe(1);

        await as(userId).post("/whats-new/mood-mixes/save", { mixId: MIX_ID });
        expect((await pendingKeys(userId)).find((r: any) => r.version === "1.11.0")).toBeUndefined();
    });

    it("is not asked again once removed", async () => {
        const { userId } = await fixture({ mood: "focus" });
        await as(userId).post("/whats-new/1.11.0/dismiss");
        await as(userId).post("/whats-new/mood-mixes/decision", { decision: "remove" });
        expect((await pendingKeys(userId)).find((r: any) => r.version === "1.11.0")).toBeUndefined();
    });
});

describe("a current mix after the window is closed", () => {
    it("is kept, and not asked about again", async () => {
        const { userId } = await fixture();
        await as(userId).post("/whats-new/1.11.0/dismiss");
        expect(await prisma.userMoodMix.count({ where: { userId } })).toBe(1);
        const res = await as(userId).get("/whats-new/pending");
        expect(res.body.releases.find((r: any) => r.version === "1.11.0")).toBeUndefined();
    });
});

describe("POST /whats-new/:version/choice — only what the window asked", () => {
    const choice = (userId: string, version: string, key: string, enabled: boolean) =>
        as(userId).post(`/whats-new/${version}/choice`, { key, enabled });

    it("refuses the retired-mix bypass: 400, nothing recorded, the question comes back", async () => {
        const { userId } = await fixture({ mood: "melancholy" });
        expect((await as(userId).post("/whats-new/1.11.0/dismiss")).status).toBe(200);

        // The real keep endpoint refuses a retired mix; one hand-made request
        // through /choice must not answer for the user instead.
        const res = await choice(userId, "1.11.0", "moods.mixes.rebuild", false);
        expect(res.status).toBe(400);
        expect(await prisma.releaseChoice.count({ where: { userId } })).toBe(0);
        expect(await prisma.userMoodMix.count({ where: { userId } })).toBe(1);
        const next = (await as(userId).get("/whats-new/pending")).body.releases.find(
            (r: any) => r.version === "1.11.0",
        );
        expect(next.items.map((i: any) => i.key)).toEqual(["moods.mixes.retired"]);
    });

    it("refuses a key nobody asked about", async () => {
        const { userId } = await fixture();
        const res = await choice(userId, "1.11.0", "no.such.key", true);
        expect(res.status).toBe(400);
        expect(await prisma.releaseChoice.count({ where: { userId } })).toBe(0);
    });

    it("refuses a phantom rebuild: a mix that was never asked about is untouched", async () => {
        const { userId } = await fixture();
        const res = await choice(userId, "1.11.0", "moods.mixes.rebuild", true);
        expect(res.status).toBe(400);
        expect(await prisma.releaseChoice.count({ where: { userId } })).toBe(0);
        expect(await prisma.userMoodMix.count({ where: { userId } })).toBe(1);
        expect((await as(userId).get("/whats-new/mood-mixes")).body.decision).toBe(null);
    });

    it("refuses real catalog keys that are not choices", async () => {
        const { userId } = await fixture();
        for (const key of ["stats.page", "clap.reembed"]) {
            expect((await choice(userId, "1.11.0", key, true)).status).toBe(400);
        }
        expect(await prisma.releaseChoice.count({ where: { userId } })).toBe(0);
    });

    it("answers 404 for an unknown version", async () => {
        const { userId } = await fixture();
        const res = await choice(userId, "0.0.0", "stats.page", true);
        expect(res.status).toBe(404);
        expect(await prisma.releaseChoice.count({ where: { userId } })).toBe(0);
    });
});

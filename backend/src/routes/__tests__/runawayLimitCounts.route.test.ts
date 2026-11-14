// The runaway limit counts each request once: audiobook routes carry the mount's limit and no second one, and the
// album cover search carries its image limit and not the general one. Streams carry no runaway limit, and a path
// that only starts like an exempt one is not exempt. Through the real mounts, on the real database.

import express from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import { generateToken } from "../../middleware/auth";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { mountApi } from "../mounts";
import { musicBrainzService } from "../../services/musicbrainz";

jest.mock("../../services/artwork", () => ({
    ...jest.requireActual("../../services/artwork"),
    findAlbumArtwork: async () => null,
}));

const MEMBER = "zz-runaway-member";
const auth = `Bearer ${generateToken({ id: MEMBER, username: MEMBER, role: "user", tokenVersion: 0 })}`;

const app = () => {
    const server = express();
    server.use(express.json());
    mountApi(server, { health: (_req, res) => void res.json({}), publicVibe: false });
    return server;
};

/** What the general runaway limit has left after this request. */
const remaining = async (server: express.Express, path: string, method: "get" | "post" | "delete" = "get") => {
    const res = await request(server)[method](path).set("Authorization", auth);
    return Number(res.headers["ratelimit-remaining"]);
};

beforeAll(async () => {
    await prisma.user.create({ data: { id: MEMBER, username: MEMBER, passwordHash: "x", role: "user", tokenVersion: 0 } });
    jest.spyOn(musicBrainzService, "getReleaseGroup").mockResolvedValue({ kind: "unavailable" } as never);
});

afterAll(async () => {
    jest.restoreAllMocks();
    await prisma.user.deleteMany({ where: { id: MEMBER } });
    await closeEngineConnections();
});

describe("audiobook requests count once", () => {
    it.each([
        ["get", "/api/audiobooks"],
        ["get", "/api/audiobooks/search?q=a"],
        ["get", "/api/audiobooks/continue-listening"],
        ["get", "/api/audiobooks/series/none"],
        ["get", "/api/audiobooks/none"],
        ["post", "/api/audiobooks/sync"],
        ["post", "/api/audiobooks/none/progress"],
        ["delete", "/api/audiobooks/none/progress"],
    ] as const)("%s %s", async (method, path) => {
        const server = app();
        const first = await remaining(server, path, method);
        const second = await remaining(server, path, method);
        expect(second).toBe(first - 1);
    });
});

describe("the album cover search counts against its image limit only", () => {
    it("leaves the general limit as it was", async () => {
        const server = app();
        const before = await remaining(server, "/api/library/genres");
        const cover = await request(server).get("/api/library/album-cover/not-a-real-mbid").set("Authorization", auth);
        expect(cover.status).toBe(204);
        const after = await remaining(server, "/api/library/genres");
        // Only the two genre reads are counted.
        expect(after).toBe(before - 1);
    });
});

describe("streams are not counted", () => {
    it.each([
        "/api/audiobooks/none/stream",
        "/api/podcasts/1/episodes/none/stream",
        "/api/library/tracks/none/stream",
    ])("%s", async (path) => {
        const server = app();
        const before = await remaining(server, "/api/stats/hour");
        await request(server).get(path).set("Authorization", auth);
        await request(server).get(path).set("Authorization", auth);
        const after = await remaining(server, "/api/stats/hour");
        // Only the two reads of the stats are counted.
        expect(after).toBe(before - 1);
    });
});

describe("a refused request is counted, even on an exempt path", () => {
    const remainingFor = async (server: express.Express, path: string, header?: string) => {
        const req = request(server).get(path);
        const res = await (header ? req.set("Authorization", header) : req);
        return { status: res.status, remaining: Number(res.headers["ratelimit-remaining"]) };
    };

    it.each([
        "/api/audiobooks/none/stream",
        "/api/podcasts/1/episodes/none/stream",
        "/api/library/tracks/none/stream",
        "/api/soulseek/search/abc-123",
        "/api/spotify/import/job1/status",
    ])("a stranger's %s", async (path) => {
        const server = app();
        const first = await remainingFor(server, path);
        const second = await remainingFor(server, path);
        expect(first.status).toBe(401);
        expect(second.status).toBe(401);
        expect(first.remaining).toBeGreaterThan(0);
        expect(second.remaining).toBe(first.remaining - 1);
    });

    it("a bad token on a stream is counted too", async () => {
        const server = app();
        const first = await remainingFor(server, "/api/library/tracks/none/stream?token=not-a-token");
        const second = await remainingFor(server, "/api/library/tracks/none/stream?token=not-a-token");
        expect(first.status).toBe(401);
        expect(first.remaining).toBeGreaterThan(0);
        expect(second.remaining).toBe(first.remaining - 1);
    });

    it("a signed-in person's stream stays uncounted", async () => {
        const server = app();
        const before = await remaining(server, "/api/stats/hour");
        const streamed = await remainingFor(server, "/api/library/tracks/none/stream", auth);
        expect(streamed.status).not.toBe(401);
        expect(streamed.remaining).toBeNaN();
        expect(await remaining(server, "/api/stats/hour")).toBe(before - 1);
    });
});

describe("a path that only starts like an exempt one is counted", () => {
    it.each(["/api/library/album-coverX/a", "/api/library/cover-artX/a"])("%s", async (path) => {
        const server = app();
        const before = await remaining(server, "/api/library/genres");
        await request(server).get(path).set("Authorization", auth);
        const after = await remaining(server, "/api/library/genres");
        // The two genre reads and the request in between.
        expect(after).toBe(before - 2);
    });
});

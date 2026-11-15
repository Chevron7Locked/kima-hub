// A request that does not parse is answered with a plain 400 and nothing about the schema: no field names, no rules.
// The issues go to the server log. Every route that parses a body, query or parameter with zod is listed here, mounted
// as the server mounts it, on the real database with real tokens.

import express from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import { generateToken } from "../../middleware/auth";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { expectLog } from "../../__tests__/helpers/expectedLogs";
import { mountApi } from "../mounts";

jest.setTimeout(60_000);

const P = "zz-invalid-req";
const ADMIN = `${P}-admin`;
const bearer = `Bearer ${generateToken({ id: ADMIN, username: ADMIN, role: "admin", tokenVersion: 0 })}`;
const health = (_req: express.Request, res: express.Response) => {
    res.json({ status: "ok" });
};

const app = express();
app.use(express.json());
mountApi(app, { health, publicVibe: false });

let playlistId = "";

beforeAll(async () => {
    await prisma.user.create({ data: { id: ADMIN, username: ADMIN, passwordHash: "x", role: "admin", tokenVersion: 0 } });
    playlistId = (await prisma.playlist.create({ data: { userId: ADMIN, name: `${P}-playlist` } })).id;
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: ADMIN } });
    await closeEngineConnections();
});

type Row = [name: string, method: "get" | "post" | "put" | "patch", path: () => string, body?: unknown];

/** One bad request per place a route parses what it was sent with zod. */
const ROUTES: Row[] = [
    ["plays: a track id that is a number", "post", () => "/api/plays", { trackId: 5 }],
    ["plays: nothing", "post", () => "/api/plays", {}],
    ["settings: a quality that does not exist", "post", () => "/api/settings", { playbackQuality: "loud" }],
    ["system settings: a url that is a number", "post", () => "/api/system-settings", { lidarrUrl: 5 }],
    ["playlists: a create with no name", "post", () => "/api/playlists", {}],
    ["playlists: a read in an order that does not exist", "get", () => `/api/playlists/${playlistId}?order=sideways`, undefined],
    ["playlists: an edit with an empty name", "put", () => `/api/playlists/${playlistId}`, { name: "" }],
    ["playlists: an edit with an empty name (patch)", "patch", () => `/api/playlists/${playlistId}`, { name: "" }],
    ["playlists: items with neither one song nor a list", "post", () => `/api/playlists/${playlistId}/items`, {}],
    ["playlists: a batch of no songs", "post", () => `/api/playlists/${playlistId}/items/batch`, { trackIds: [] }],
    ["playlists: a move after a number", "patch", () => `/api/playlists/${playlistId}/items/someitem/move`, { afterItemId: 5 }],
    ["releases: a download with no artist or title", "post", () => "/api/releases/download/some-mbid", {}],
    ["onboarding: a register with no password", "post", () => "/api/onboarding/register", { username: "x" }],
    ["onboarding: lidarr with no on-switch", "post", () => "/api/onboarding/lidarr", {}],
    ["onboarding: audiobookshelf with a bad url", "post", () => "/api/onboarding/audiobookshelf", { enabled: true, url: "not a url" }],
    ["onboarding: soulseek with no on-switch", "post", () => "/api/onboarding/soulseek", {}],
    ["whats new: a mood mix decision that does not exist", "post", () => "/api/whats-new/mood-mixes/decision", { decision: "burn" }],
    ["whats new: saving a mix with no id", "post", () => "/api/whats-new/mood-mixes/save", {}],
    ["whats new: a choice with no answer", "post", () => "/api/whats-new/1.11.0/choice", { key: "x" }],
    ["spotify: a preview with a url that is a number", "post", () => "/api/spotify/preview/start", { url: 42 }],
    ["spotify: a quick import with no url", "post", () => "/api/spotify/import/quick", {}],
    ["spotify: an import with no url", "post", () => "/api/spotify/import", { playlistName: "Mix" }],
    ["stats: removing false starts with no songs", "post", () => "/api/stats/false-starts/remove", {}],
    ["stats: ignoring false starts with no songs", "post", () => "/api/stats/false-starts/ignore", {}],
    ["stats: restoring false starts with no songs", "post", () => "/api/stats/false-starts/restore", {}],
    ["system settings: a gpu switch with neither toggle", "post", () => "/api/system-settings/gpu", {}],
    ["notifications: a type that does not exist", "post", () => "/api/notifications", { type: "bogus", title: "x" }],
    ["podcasts: progress with no time", "post", () => "/api/podcasts/some-show/episodes/some-episode/progress", {}],
    ["podcasts: a chart with too long a page", "get", () => "/api/podcasts/charts?limit=999", undefined],
    ["podcasts: a chart for a category that is not a number", "get", () => "/api/podcasts/charts?category=abc", undefined],
    ["podcasts: a genre chart for a genre that is not a number", "get", () => "/api/podcasts/discover/genre/abc", undefined],
    ["auth: a sign-in with nothing", "post", () => "/api/auth/login", {}],
    ["auth: 2fa enable with no code", "post", () => "/api/auth/2fa/enable", {}],
    ["auth: 2fa disable with no code", "post", () => "/api/auth/2fa/disable", { password: "x" }],
    ["auth: new recovery codes with no password", "post", () => "/api/auth/2fa/recovery-codes", { token: "123456" }],
];

describe("a request that does not parse", () => {
    it.each(ROUTES)("is answered with a plain 400 and no schema details: %s", async (_name, method, path, body) => {
        expectLog("warn");
        const call = request(app)[method](path()).set("Authorization", bearer);

        const res = await (body === undefined ? call : call.send(body as object));

        expect([res.status, res.body]).toEqual([400, { error: "Invalid request" }]);
    });

    it("is logged with the field and the rule, for the person running the server", async () => {
        const logged = expectLog("warn");

        await request(app).post("/api/plays").set("Authorization", bearer).send({ trackId: 5 }).expect(400);

        const lines = logged.mock.calls.map((call) => String(call[0]));
        expect(lines.some((line) => line.includes("/plays") && line.includes("trackId"))).toBe(true);
    });

    it("keeps what was sent out of the log: only the field and the rule", async () => {
        const logged = expectLog("warn");

        await request(app)
            .post("/api/onboarding/audiobookshelf")
            .set("Authorization", bearer)
            .send({ enabled: true, url: "not a url hunter2-secret-value" })
            .expect(400);

        const lines = logged.mock.calls.map((call) => String(call[0]));
        expect(lines.some((line) => line.includes("url"))).toBe(true);
        expect(lines.some((line) => line.includes("hunter2-secret-value"))).toBe(false);
    });

    it("cuts a long list of issues to a few, on one line", async () => {
        const logged = expectLog("warn");

        await request(app)
            .post("/api/playlists/" + playlistId + "/items")
            .set("Authorization", bearer)
            .send({ trackIds: Array.from({ length: 400 }, () => 7) })
            .expect(400);

        const line = logged.mock.calls.map((call) => String(call[0])).find((l) => l.includes("[InvalidRequest]"))!;
        expect(line).toContain("more)");
        expect(line.length).toBeLessThan(700);
        expect(line).not.toContain("\n");
    });
});

// A request that does not parse is answered with a plain 400 and nothing about the schema: no field names, no rules.
// The issues go to the server log. Every route that parses a body, query or parameter with zod, and every route that
// checks one by hand and refuses it as malformed, is listed here, mounted as the server mounts it, on the real
// database with real tokens. A refusal a person reads and acts on (a code that expired, Lidarr not set up, a mix with
// too few songs) is a domain answer, keeps its own words, and is not here.

import express from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import { generateToken } from "../../middleware/auth";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { expectLog } from "../../__tests__/helpers/expectedLogs";
import { internalSecret } from "../../utils/internalSecret";
import { mountApi } from "../mounts";
import { FULL_LINK_MESSAGE } from "../../services/musicLink";

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

const CUID = "c" + "a".repeat(24);
const MBID = "5b11f4ce-a62d-471e-81fc-a69a8278c7da";

let playlistId = "";

beforeAll(async () => {
    await prisma.user.create({ data: { id: ADMIN, username: ADMIN, passwordHash: "x", role: "admin", tokenVersion: 0 } });
    playlistId = (await prisma.playlist.create({ data: { userId: ADMIN, name: `${P}-playlist` } })).id;
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: ADMIN } });
    await closeEngineConnections();
});

type Row = [name: string, method: "get" | "post" | "put" | "patch" | "delete", path: () => string, body?: unknown];

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
    ["podcasts: a chart for an empty category", "get", () => "/api/podcasts/charts?category=", undefined],
    ["podcasts: a chart for a blank category", "get", () => "/api/podcasts/charts?category=%20%20", undefined],
    ["podcasts: subscribe with neither a feed nor an iTunes id", "post", () => "/api/podcasts/subscribe", {}],
    ["podcasts: genres with none given", "get", () => "/api/podcasts/discover/genres", undefined],
    ["podcasts: genres with an empty entry", "get", () => "/api/podcasts/discover/genres?genres=1,,2", undefined],
    ["podcasts: genres that are only a comma", "get", () => "/api/podcasts/discover/genres?genres=,", undefined],
    ["podcasts: genres that are not numbers", "get", () => "/api/podcasts/discover/genres?genres=a,b", undefined],
    ["stats: an hour on a day that does not exist", "get", () => "/api/stats/hour?dow=9&hour=1", undefined],
    ["stats: tracks of a slice that does not exist", "get", () => "/api/stats/tracks?of=bogus", undefined],
    ["stats: plays of a track with too long an id", "get", () => `/api/stats/track/${"x".repeat(65)}/plays`, undefined],
    ["stats: an hour left blank", "get", () => "/api/stats/hour?dow=&hour=", undefined],
    ["stats: a region off the grid", "get", () => "/api/stats/region?x=0&y=99", undefined],
    ["vibe: a path with no tracks", "post", () => "/api/vibe/path", {}],
    ["vibe: a path with ids that are not ids", "post", () => "/api/vibe/path", { startTrackId: "a", endTrackId: "b" }],
    ["vibe: a path from a track to itself", "post", () => "/api/vibe/path", { startTrackId: CUID, endTrackId: CUID }],
    ["vibe: a blend with nothing to add", "post", () => "/api/vibe/alchemy", {}],
    ["vibe: a blend of too many", "post", () => "/api/vibe/alchemy", { add: Array.from({ length: 11 }, () => CUID) }],
    ["vibe: a blend to subtract that is not a list", "post", () => "/api/vibe/alchemy", { add: [CUID], subtract: "x" }],
    ["vibe: a blend to subtract that is zero", "post", () => "/api/vibe/alchemy", { add: [CUID], subtract: 0 }],
    ["vibe: a blend to subtract that is empty text", "post", () => "/api/vibe/alchemy", { add: [CUID], subtract: "" }],
    ["vibe: a blend to subtract that is null", "post", () => "/api/vibe/alchemy", { add: [CUID], subtract: null }],
    ["vibe: a blend to subtract that is false", "post", () => "/api/vibe/alchemy", { add: [CUID], subtract: false }],
    ["vibe: a blend to add that are not ids", "post", () => "/api/vibe/alchemy", { add: ["nope"] }],
    ["vibe: a blend to subtract that are not ids", "post", () => "/api/vibe/alchemy", { add: [CUID], subtract: ["nope"] }],
    ["vibe: a search that is one letter", "post", () => "/api/vibe/search", { query: "a" }],
    ["vibe: a search that is far too long", "post", () => "/api/vibe/search", { query: "a".repeat(501) }],
    ["mixes: a mood that does not exist", "get", () => "/api/mixes/mood/buckets/nope", undefined],
    ["mixes: saving a mood that does not exist", "post", () => "/api/mixes/mood/buckets/nope/save", {}],
    ["mixes: saving songs that are not a list", "post", () => "/api/mixes/mood/buckets/happy/save", { trackIds: "x" }],
    ["mixes: saving songs that are not text", "post", () => "/api/mixes/mood/buckets/happy/save", { trackIds: [5] }],
    ["mixes: saving too many songs", "post", () => "/api/mixes/mood/buckets/happy/save", { trackIds: Array.from({ length: 16 }, () => "x") }],
    ["discover: liking with no album", "post", () => "/api/discover/like", {}],
    ["discover: unliking with no album", "delete", () => "/api/discover/unlike", {}],
    ["discover: a playlist size off the steps", "patch", () => "/api/discover/config", { playlistSize: 7 }],
    ["discover: retry attempts out of range", "patch", () => "/api/discover/config", { maxRetryAttempts: 99 }],
    ["discover: exclusion months out of range", "patch", () => "/api/discover/config", { exclusionMonths: 99 }],
    ["discover: a download ratio out of range", "patch", () => "/api/discover/config", { downloadRatio: 9 }],
    ["discover: a playlist size with trailing text", "patch", () => "/api/discover/config", { playlistSize: "10abc" }],
    ["discover: a playlist size that is not whole", "patch", () => "/api/discover/config", { playlistSize: 10.5 }],
    ["discover: retry attempts with trailing text", "patch", () => "/api/discover/config", { maxRetryAttempts: "2x" }],
    ["discover: exclusion months with trailing text", "patch", () => "/api/discover/config", { exclusionMonths: "3x" }],
    ["discover: a download ratio with trailing text", "patch", () => "/api/discover/config", { downloadRatio: "1.5x" }],
    ["discover: an on-switch that is not a boolean", "patch", () => "/api/discover/config", { enabled: "yes" }],
    ["analysis: a worker count that is not a number", "put", () => "/api/analysis/workers", { workers: "many" }],
    ["analysis: a clap worker count out of range", "put", () => "/api/analysis/clap-workers", { workers: 0 }],
    ["analysis: together that is not a boolean", "put", () => "/api/analysis/together", {}],
    ["enrichment: a rerun of a step that does not exist", "post", () => "/api/enrichment/rerun", { step: "bogus" }],
    ["enrichment: failures of a type that does not exist", "get", () => "/api/enrichment/failures?entityType=bogus", undefined],
    ["enrichment: a retry with no ids", "post", () => "/api/enrichment/retry", {}],
    ["enrichment: an album year that is not a number", "put", () => "/api/enrichment/albums/none/metadata", { year: "abc" }],
    ["enrichment: an album year with trailing text", "put", () => "/api/enrichment/albums/none/metadata", { year: "2020abc" }],
    ["enrichment: an album year below 1000", "put", () => "/api/enrichment/albums/none/metadata", { year: 999 }],
    ["enrichment: an album year above 9999", "put", () => "/api/enrichment/albums/none/metadata", { year: 10000 }],
    ["enrichment: an album year too big for the database", "put", () => "/api/enrichment/albums/none/metadata", { year: "99999999999" }],
    ["enrichment: a track number of zero", "put", () => "/api/enrichment/tracks/none/metadata", { trackNo: 0 }],
    ["enrichment: a negative track number", "put", () => "/api/enrichment/tracks/none/metadata", { trackNo: -1 }],
    ["enrichment: a track number above 9999", "put", () => "/api/enrichment/tracks/none/metadata", { trackNo: 10000 }],
    ["enrichment: a track number too big for the database", "put", () => "/api/enrichment/tracks/none/metadata", { trackNo: 99999999999 }],
    ["enrichment: a track number with trailing text", "put", () => "/api/enrichment/tracks/none/metadata", { trackNo: "3x" }],
    ["enrichment: a track number that is not a number", "put", () => "/api/enrichment/tracks/none/metadata", { trackNo: "abc" }],
    ["enrichment: an album title that is a number", "put", () => "/api/enrichment/albums/none/metadata", { title: 5 }],
    ["enrichment: an album title that is an object", "put", () => "/api/enrichment/albums/none/metadata", { title: { a: 1 } }],
    ["enrichment: an album title with a null character", "put", () => "/api/enrichment/albums/none/metadata", { title: "a\u0000b" }],
    ["enrichment: album genres that are text", "put", () => "/api/enrichment/albums/none/metadata", { genres: "rock" }],
    ["enrichment: album genres with a number in them", "put", () => "/api/enrichment/albums/none/metadata", { genres: ["rock", 1] }],
    ["enrichment: album genres that are an object", "put", () => "/api/enrichment/albums/none/metadata", { genres: { a: 1 } }],
    ["enrichment: album genres with a null character", "put", () => "/api/enrichment/albums/none/metadata", { genres: ["a\u0000b"] }],
    ["enrichment: an album cover address that is a number", "put", () => "/api/enrichment/albums/none/metadata", { coverUrl: 5 }],
    ["enrichment: an album cover address that is a list", "put", () => "/api/enrichment/albums/none/metadata", { coverUrl: ["https://a.example/c.jpg"] }],
    ["enrichment: an album cover address with a null character", "put", () => "/api/enrichment/albums/none/metadata", { coverUrl: "https://a.example/\u0000" }],
    ["enrichment: an album cover address that is not http or https", "put", () => "/api/enrichment/albums/none/metadata", { coverUrl: "file:///etc/passwd" }],
    ["enrichment: an album cover address with no scheme", "put", () => "/api/enrichment/albums/none/metadata", { coverUrl: "img.example/c.jpg" }],
    ["enrichment: an album cover address that leaves the covers folder", "put", () => "/api/enrichment/albums/none/metadata", { coverUrl: "native:../../etc/passwd" }],
    ["enrichment: an album MusicBrainz id that is a number", "put", () => "/api/enrichment/albums/none/metadata", { rgMbid: 5 }],
    ["enrichment: an album MusicBrainz id that is an object", "put", () => "/api/enrichment/albums/none/metadata", { rgMbid: { a: 1 } }],
    ["enrichment: an album MusicBrainz id that is not an id", "put", () => "/api/enrichment/albums/none/metadata", { rgMbid: "not-an-id" }],
    ["enrichment: a track title that is a number", "put", () => "/api/enrichment/tracks/none/metadata", { title: 5 }],
    ["enrichment: a track title that is a list", "put", () => "/api/enrichment/tracks/none/metadata", { title: ["a"] }],
    ["enrichment: a track title with a null character", "put", () => "/api/enrichment/tracks/none/metadata", { title: "a\u0000b" }],
    ["enrichment: an artist name that is a number", "put", () => "/api/enrichment/artists/none/metadata", { name: 5 }],
    ["enrichment: an artist name that is an object", "put", () => "/api/enrichment/artists/none/metadata", { name: { a: 1 } }],
    ["enrichment: an artist name with a null character", "put", () => "/api/enrichment/artists/none/metadata", { name: "a\u0000b" }],
    ["enrichment: an artist bio that is a list", "put", () => "/api/enrichment/artists/none/metadata", { bio: ["a"] }],
    ["enrichment: an artist bio with a null character", "put", () => "/api/enrichment/artists/none/metadata", { bio: "a\u0000b" }],
    ["enrichment: artist genres that are text", "put", () => "/api/enrichment/artists/none/metadata", { genres: "rock" }],
    ["enrichment: artist genres with a number in them", "put", () => "/api/enrichment/artists/none/metadata", { genres: ["rock", 1] }],
    ["enrichment: artist genres with a null character", "put", () => "/api/enrichment/artists/none/metadata", { genres: ["a\u0000b"] }],
    ["enrichment: an artist hero address that is a number", "put", () => "/api/enrichment/artists/none/metadata", { heroUrl: 5 }],
    ["enrichment: an artist hero address with a null character", "put", () => "/api/enrichment/artists/none/metadata", { heroUrl: "https://a.example/\u0000" }],
    ["enrichment: an artist hero address that is not http or https", "put", () => "/api/enrichment/artists/none/metadata", { heroUrl: "javascript:alert(1)" }],
    ["enrichment: an artist hero address with no scheme", "put", () => "/api/enrichment/artists/none/metadata", { heroUrl: "img.example/a.jpg" }],
    ["enrichment: an artist hero address that leaves the covers folder", "put", () => "/api/enrichment/artists/none/metadata", { heroUrl: "native:../../etc/passwd" }],
    ["enrichment: an artist MusicBrainz id that is a number", "put", () => "/api/enrichment/artists/none/metadata", { mbid: 5 }],
    ["enrichment: an artist MusicBrainz id that is not an id", "put", () => "/api/enrichment/artists/none/metadata", { mbid: "not-an-id" }],
    ["enrichment: a concurrency that is not a number", "put", () => "/api/enrichment/concurrency", {}],
    ["cover art: an id that is not a cover id", "get", () => "/api/library/cover-art/not-a-cover-id", undefined],
    ["cover art: nothing to look up", "get", () => "/api/library/cover-art", undefined],
    ["tracks: an album given twice", "get", () => "/api/library/tracks?albumId=a&albumId=b", undefined],
    ["radio: a row of a scope that does not exist", "get", () => "/api/library/radio/row?scope=moon", undefined],
    ["radio: a station of no type", "get", () => "/api/library/radio", undefined],
    ["stream: a quality that does not exist", "get", () => "/api/library/tracks/none/stream?quality=loud", undefined],
    ["prewarm: a quality that does not exist", "post", () => "/api/library/tracks/none/prewarm?quality=loud", {}],
    ["downloads: a request with nothing in it", "post", () => "/api/downloads", {}],
    ["downloads: a request with an id that is not a musicbrainz id", "post", () => "/api/downloads", { type: "album", mbid: "x", subject: "y" }],
    ["downloads: a request for a type that does not exist", "post", () => "/api/downloads", { type: "song", mbid: MBID, subject: "y" }],
    ["downloads: clearing jobs of a status that does not exist", "delete", () => "/api/downloads/clear-all?status=bogus", undefined],
    ["browse: a search that is one letter", "get", () => "/api/browse/playlists/search?q=a", undefined],
    ["browse: a link that is not given", "post", () => "/api/browse/playlists/parse", {}],
    ["device link: a verify with no code", "post", () => "/api/device-link/verify", {}],
    ["api keys: a key with no device name", "post", () => "/api/api-keys", {}],
    ["api keys: a key with a device name that is a number", "post", () => "/api/api-keys", { deviceName: 5 }],
    ["auth: a sign-in with nothing", "post", () => "/api/auth/login", {}],
    ["auth: a refresh with no token", "post", () => "/api/auth/refresh", {}],
    ["share: a share with nothing to share", "post", () => "/api/share", {}],
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

    it("is answered in plain words when a person typing a form reads them, and is still logged", async () => {
        const logged = expectLog("warn");
        const cases: [string, "post", string, unknown, string][] = [
            ["auth: create user with nothing", "post", "/api/auth/create-user", {}, "Username and password are required"],
            ["auth: create user with a role that does not exist", "post", "/api/auth/create-user", { username: "x", password: "abcdef", role: "root" }, "Invalid role"],
            ["auth: change password with nothing", "post", "/api/auth/change-password", {}, "Current and new password are required"],
            ["onboarding: soulseek on with no login", "post", "/api/onboarding/soulseek", { enabled: true }, "Soulseek username and password are required"],
            ["system settings: test lidarr with nothing", "post", "/api/system-settings/test-lidarr", {}, "URL and API key are required"],
            ["system settings: test audiobookshelf with nothing", "post", "/api/system-settings/test-audiobookshelf", {}, "URL and API key are required"],
            ["system settings: test fanart with nothing", "post", "/api/system-settings/test-fanart", {}, "API key is required"],
            ["spotify: a quick import of an address with no scheme", "post", "/api/spotify/import/quick", { url: "open.spotify.com/playlist/abc" }, FULL_LINK_MESSAGE],
            ["browse: a link with no scheme", "post", "/api/browse/playlists/parse", { url: "open.spotify.com/playlist/abc" }, FULL_LINK_MESSAGE],
            ["browse: a full address that is not a music site", "post", "/api/browse/playlists/parse", { url: "https://example.com/x" }, "Invalid or unsupported URL. Please provide a Spotify, Deezer, or YouTube playlist URL."],
            ["spotify: an m3u import with no file", "post", "/api/spotify/import/m3u", {}, "No file uploaded"],
            ["whats new: a choice no release has", "post", "/api/whats-new/1.11.0/choice", { key: "no-such-choice", enabled: true }, "Unknown choice"],
        ];
        for (const [name, method, path, body, answer] of cases) {
            const res = await request(app)[method](path).set("Authorization", bearer).send(body as object);
            expect([name, res.status, res.body]).toEqual([name, 400, { error: answer }]);
        }
        const lines = logged.mock.calls.map((call) => String(call[0]));
        expect(lines.filter((line) => line.includes("[InvalidRequest]")).length).toBeGreaterThanOrEqual(cases.length);
    });

    it("takes the edges of a year and a track number, and a clear, past the range check", async () => {
        // None of these ids exist, so a value the range accepts is answered not-found, never 400.
        const answers: [string, string, object][] = [
            ["year 1000", "/api/enrichment/albums/none/metadata", { year: 1000 }],
            ["year 9999", "/api/enrichment/albums/none/metadata", { year: "9999" }],
            ["year cleared with null", "/api/enrichment/albums/none/metadata", { year: null }],
            ["year cleared with empty text", "/api/enrichment/albums/none/metadata", { year: "" }],
            ["track number 1", "/api/enrichment/tracks/none/metadata", { trackNo: 1 }],
            ["track number 9999", "/api/enrichment/tracks/none/metadata", { trackNo: "9999" }],
            ["track number cleared with null", "/api/enrichment/tracks/none/metadata", { trackNo: null }],
        ];
        for (const [name, path, body] of answers) {
            const res = await request(app).put(path).set("Authorization", bearer).send(body);
            expect([name, res.status]).toEqual([name, 404]);
        }
    });

    it("refuses a float, a boolean and a list as a year or track number", async () => {
        expectLog("warn");
        const bad: [string, object][] = [
            ["/api/enrichment/albums/none/metadata", { year: 1999.5 }],
            ["/api/enrichment/albums/none/metadata", { year: true }],
            ["/api/enrichment/albums/none/metadata", { year: [1999] }],
            ["/api/enrichment/tracks/none/metadata", { trackNo: 1.5 }],
            ["/api/enrichment/tracks/none/metadata", { trackNo: false }],
        ];
        for (const [path, body] of bad) {
            const res = await request(app).put(path).set("Authorization", bearer).send(body);
            expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 400]);
        }
    });

    it("refuses a playlist name sent twice in an m3u upload with 400, not a server fault", async () => {
        expectLog("warn");

        const res = await request(app)
            .post("/api/spotify/import/m3u")
            .set("Authorization", bearer)
            .attach("file", Buffer.from("/music/a.mp3\n"), "list.m3u")
            .field("playlistName", "one")
            .field("playlistName", "two");

        expect([res.status, res.body]).toEqual([400, { error: "playlistName is required (1-200 chars)" }]);
    });

    it("refuses an idempotency key that is too long to store, in a plain 400", async () => {
        expectLog("warn");

        const res = await request(app)
            .post("/api/playlists")
            .set("Authorization", bearer)
            .set("Idempotency-Key", "k".repeat(500))
            .send({ name: `${P}-keyed` });

        expect([res.status, res.body]).toEqual([400, { error: "Invalid request" }]);
    });

    it("is logged with the field and the rule, for the person running the server", async () => {
        const logged = expectLog("warn");

        await request(app).post("/api/plays").set("Authorization", bearer).send({ trackId: 5 }).expect(400);

        const lines = logged.mock.calls.map((call) => String(call[0]));
        expect(lines.some((line) => line.includes("/plays") && line.includes("trackId"))).toBe(true);
    });

    it("is logged by a route that checks by hand, with the rule it broke", async () => {
        const logged = expectLog("warn");

        await request(app).get("/api/mixes/mood/buckets/hunter2-secret-mood").set("Authorization", bearer).expect(400);

        const lines = logged.mock.calls.map((call) => String(call[0]));
        expect(lines.some((line) => line.includes("[InvalidRequest]") && line.includes("/mixes/mood/buckets"))).toBe(true);
        expect(lines.some((line) => line.includes("mood: not one of the known moods"))).toBe(true);
    });

    it("is answered the same by the analyzer's own report, which has no signed-in person", async () => {
        const logged = expectLog("warn");

        const res = await request(app)
            .post("/api/analysis/vibe/failure")
            .set("x-internal-secret", await internalSecret())
            .send({});

        expect([res.status, res.body]).toEqual([400, { error: "Invalid request" }]);
        expect(logged.mock.calls.map((call) => String(call[0])).some((line) => line.includes("trackId"))).toBe(true);
    });

    it("leaves the answers a person reads and acts on in their own words", async () => {
        expectLog("warn");
        const stays = await request(app).post("/api/vibe/alchemy").set("Authorization", bearer).send({ add: [CUID] });
        // Unknown track: the similarity step has not seen it. The iOS app reads this text.
        expect(stays.status).toBe(400);
        expect(String(stays.body.error)).toContain("similarity step");

        const link = await request(app)
            .post("/api/browse/playlists/parse")
            .set("Authorization", bearer)
            .send({ url: "spotify:playlist:abc" });
        expect(link.status).toBe(400);
        expect(String(link.body.error)).not.toBe("Invalid request");

        const expired = await request(app).post("/api/device-link/verify").set("Authorization", bearer).send({ code: "ZZZZZZ" });
        expect(expired.body.error).not.toBe("Invalid request");
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

/**
 * searchTracksByText end to end: the Redis round trip to the analyzer, riding
 * out a dead analyzer, and the embedding ranking the songs in the real database.
 * Redis is mocked (the analyzer is not running); the pub/sub code is real.
 */

const duplicateMock = jest.fn();
jest.mock("../../utils/redis", () => ({
    __esModule: true,
    redisClient: {
        duplicate: (...a: unknown[]) => duplicateMock(...a),
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { searchTracksByText } from "../textEmbeddingBridge";
import { prisma } from "../../utils/db";
import { insertEmbeddings, seedEmbedding, unitVectorAt, unitVectorValues } from "../../__tests__/helpers/embeddingFixtures";

const RESPONSE_PREFIX = "audio:text:embed:response:";

const P = "zz-textEmbed-";
const id = (name: string) => `${P}${name}`;
/** What the analyzer answers for the query text: the unit vector along axis 0, so a song's distance is 1 minus its `cos`. */
const QUERY_EMBEDDING = unitVectorValues(1, 1);

async function wipe() {
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } }); // sound vectors go with the song
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

/** A song on an album of its own, with a sound vector at `cos` to the query. Playable unless asked otherwise. */
async function seedSong(
    name: string,
    cos: number,
    opts: { corrupt?: boolean; location?: "LIBRARY" | "DISCOVER"; missing?: boolean; model?: string } = {},
) {
    await prisma.album.create({
        data: {
            id: id(`alb-${name}`), artistId: id("art"), title: `Album ${name}`, identityKey: id(`alb-${name}`),
            rgMbid: id(`alb-${name}`), primaryType: "Album", location: opts.location ?? "LIBRARY",
        },
    });
    await prisma.track.create({
        data: {
            id: id(name), albumId: id(`alb-${name}`), title: `Song ${name}`, trackNo: 1, duration: 200,
            filePath: `/tmp/${P}${name}.flac`, fileModified: new Date(), fileSize: 1000,
            corrupt: opts.corrupt ?? false, missingSince: opts.missing ? new Date() : null,
        },
    });
    const vector = unitVectorAt(cos, 2 + (Number.parseInt(name.replace(/\D/g, ""), 10) || 0));
    if (opts.model) await insertEmbeddings([{ trackId: id(name), vector }], { model: opts.model });
    else await seedEmbedding(id(name), vector);
}

// The bridge's pmessage handler, captured when the shared subscriber wires up.
let onPMessage: ((pattern: string, channel: string, message: string) => void) | undefined;
let lastRequest: { requestId: string; text: string } | undefined;

function makeConn() {
    const conn: any = {
        status: "ready",
        on: jest.fn((event: string, handler: (...args: unknown[]) => void) => {
            if (event === "pmessage") onPMessage = handler as typeof onPMessage;
            return conn;
        }),
        publish: jest.fn(async (_channel: string, message: string) => {
            lastRequest = JSON.parse(message);
            return 1;
        }),
        psubscribe: jest.fn(async () => undefined),
        disconnect: jest.fn(),
    };
    return conn;
}

function deliverResponse(request: { requestId: string }, payload: unknown) {
    onPMessage?.("audio:text:embed*", `${RESPONSE_PREFIX}${request.requestId}`, JSON.stringify(payload));
}

// Flush pending microtasks (the bridge awaits between subscribe and publish).
async function flush(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Ask the bridge a question and have the analyzer answer it with `embedding`. */
async function search(text: string, limit: number, embedding: number[] = QUERY_EMBEDDING) {
    const pending = searchTracksByText(text, limit);
    await flush();
    expect(lastRequest!.text).toBe(text);
    deliverResponse(lastRequest!, { success: true, embedding });
    return pending;
}

beforeAll(wipe);
afterAll(wipe);

beforeEach(async () => {
    duplicateMock.mockReset().mockImplementation(() => makeConn());
    lastRequest = undefined;
    await wipe();
    await prisma.artist.create({ data: { id: id("art"), name: "Vibe Artist", identityKey: id("art") } });
});

describe("searchTracksByText", () => {
    it("round-trips the query into the ranking and returns the nearest songs, best first", async () => {
        await seedSong("far", 0.1);
        await seedSong("near", 0.9);
        await seedSong("mid", 0.5);

        const rows = await search("solo piano", 2);

        // Soft duplicate options: the shared client is strict/fail-fast, but
        // pub/sub must ride out a cold Redis.
        expect(duplicateMock).toHaveBeenCalledWith({
            enableOfflineQueue: true,
            maxRetriesPerRequest: null,
        });
        expect(rows.map((r) => r.id)).toEqual([id("near"), id("mid")]);
        expect(rows[0]).toMatchObject({
            title: "Song near", albumId: id("alb-near"), albumTitle: "Album near", albumCoverUrl: null,
            artistId: id("art"), artistName: "Vibe Artist", duration: 200, trackNo: 1,
        });
        expect(rows[0].distance).toBeCloseTo(0.1, 5);
        expect(rows[1].distance).toBeCloseTo(0.5, 5);
    });

    it("keeps a weak match behind the better ones: there is no similarity cut-off", async () => {
        await seedSong("good", 0.95);
        await seedSong("poor", 0.1);

        const rows = await search("solo piano", 2);

        expect(rows.map((r) => r.id)).toEqual([id("good"), id("poor")]);
        expect(rows[1].distance).toBeCloseTo(0.9, 5);
    });

    it("answers with fewer songs than asked when the library holds fewer", async () => {
        await seedSong("only", 0.5);

        expect((await search("solo piano", 10)).map((r) => r.id)).toEqual([id("only")]);
    });

    it("offers only playable songs, and still fills the page when the nearest vectors belong to others", async () => {
        // The nearest vectors are a corrupt, a missing and a Discover song, then one from another model;
        // the page still holds the two playable songs that follow.
        await seedSong("bad", 0.99, { corrupt: true });
        await seedSong("gone", 0.98, { missing: true });
        await seedSong("disc", 0.97, { location: "DISCOVER" });
        await seedSong("other", 0.96, { model: "some-other-model" });
        await seedSong("ok1", 0.5);
        await seedSong("ok2", 0.3);

        const rows = await search("solo piano", 2);

        expect(rows.map((r) => r.id)).toEqual([id("ok1"), id("ok2")]);
    });

    it("rejects when the analyzer reports failure", async () => {
        await seedSong("a", 0.5);
        const pending = searchTracksByText("synth pop", 10);
        await flush();
        deliverResponse(lastRequest!, { success: false, embedding: null });

        await expect(pending).rejects.toThrow("Analyzer failed to produce embedding");
    });

    it("rejects on a reply that is not JSON", async () => {
        const pending = searchTracksByText("synth pop", 10);
        await flush();
        onPMessage?.("audio:text:embed*", `${RESPONSE_PREFIX}${lastRequest!.requestId}`, "not json");

        await expect(pending).rejects.toThrow("Invalid response from analyzer");
    });

    it("rejects on timeout, ignores the late reply, and lets the next request succeed", async () => {
        await seedSong("a", 0.5);
        // Only the timers are faked, while the database is not in use: it is read after the clock is real again.
        jest.useFakeTimers();
        let deadRequest: typeof lastRequest;
        try {
            const pending = searchTracksByText("quiet piano", 10);
            await flush();
            deadRequest = lastRequest;

            const timedOut = expect(pending).rejects.toThrow("Text embedding request timed out");
            await jest.advanceTimersByTimeAsync(15_001);
            await timedOut;
        } finally {
            jest.useRealTimers();
        }

        // The analyzer's answer arrives after the listener was torn down:
        // it must be dropped, not delivered to the wrong request.
        deliverResponse(deadRequest!, { success: true, embedding: unitVectorValues(1, 5) });

        expect((await search("loud piano", 1)).map((r) => r.id)).toEqual([id("a")]);
    });
});

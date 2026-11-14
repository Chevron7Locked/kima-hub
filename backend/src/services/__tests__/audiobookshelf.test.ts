jest.mock("../../utils/logger", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(),
}));

import { audiobookshelfService } from "../audiobookshelf";
import { logger } from "../../utils/logger";

const multiTrackBook = {
    media: {
        tracks: [
            { index: 2, startOffset: 1200, duration: 1200, contentUrl: "/abs/t2" },
            { index: 3, startOffset: 2400, duration: 1200, contentUrl: "/abs/t3" },
            { index: 1, startOffset: 0, duration: 1200, contentUrl: "/abs/t1" },
        ],
        numTracks: 3,
    },
};

function setupClient(response: object = { data: "stream-data", headers: {}, status: 200 }) {
    (audiobookshelfService as any).client = {
        get: jest.fn().mockResolvedValue(response),
    };
    return (audiobookshelfService as any).client;
}

beforeEach(() => {
    jest.spyOn(audiobookshelfService as any, "ensureInitialized").mockResolvedValue(undefined);
    // Clear the track cache so each test starts cold.
    (audiobookshelfService as any).trackCache.clear();
});

afterEach(() => jest.restoreAllMocks());

// ── Track resolution (1-based index) ──────────────────────────────────────────

describe("streamAudiobook track resolution", () => {
    beforeEach(() => {
        jest.spyOn(audiobookshelfService as any, "getAudiobook").mockResolvedValue(multiTrackBook);
        setupClient();
    });

    it("resolves trackIndex=1 to the track with index 1, not array position 1", async () => {
        const client = setupClient();
        await audiobookshelfService.streamAudiobook("book-1", undefined, 1);
        expect(client.get).toHaveBeenCalledWith("/abs/t1", expect.any(Object));
    });

    it("resolves trackIndex=3 to the track with index 3", async () => {
        const client = setupClient();
        await audiobookshelfService.streamAudiobook("book-1", undefined, 3);
        expect(client.get).toHaveBeenCalledWith("/abs/t3", expect.any(Object));
    });

    it("falls back to first track and warns when supplied trackIndex is not found", async () => {
        const client = setupClient();
        const warnSpy = logger.warn as jest.Mock;
        await audiobookshelfService.streamAudiobook("book-1", undefined, 99);
        expect(client.get).toHaveBeenCalledWith("/abs/t1", expect.any(Object));
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("trackIndex=99"));
    });

    it("resolves first track without warning when trackIndex is not supplied", async () => {
        const client = setupClient();
        const warnSpy = logger.warn as jest.Mock;
        await audiobookshelfService.streamAudiobook("book-1", undefined, undefined);
        expect(client.get).toHaveBeenCalledWith("/abs/t1", expect.any(Object));
        expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("trackIndex"));
    });
});

// ── Track resolution cache: one getAudiobook call per TTL window ──────────────

describe("streamAudiobook track resolution cache", () => {
    it("calls getAudiobook once per book per TTL window across multiple seeks", async () => {
        const getAudiobookSpy = jest
            .spyOn(audiobookshelfService as any, "getAudiobook")
            .mockResolvedValue(multiTrackBook);
        setupClient();

        await audiobookshelfService.streamAudiobook("book-cache", undefined, 1);
        await audiobookshelfService.streamAudiobook("book-cache", undefined, 2);
        await audiobookshelfService.streamAudiobook("book-cache", undefined, 3);

        expect(getAudiobookSpy).toHaveBeenCalledTimes(1);
    });

    it("calls getAudiobook again after TTL expires", async () => {
        const getAudiobookSpy = jest
            .spyOn(audiobookshelfService as any, "getAudiobook")
            .mockResolvedValue(multiTrackBook);
        setupClient();

        await audiobookshelfService.streamAudiobook("book-ttl", undefined, 1);
        expect(getAudiobookSpy).toHaveBeenCalledTimes(1);

        // Manually age the cache entry past the TTL.
        const entry = (audiobookshelfService as any).trackCache.get("book-ttl");
        entry.fetchedAt = Date.now() - 6 * 60 * 1000; // 6 minutes ago

        await audiobookshelfService.streamAudiobook("book-ttl", undefined, 1);
        expect(getAudiobookSpy).toHaveBeenCalledTimes(2);
    });

    it("maintains separate cache entries for different books", async () => {
        const getAudiobookSpy = jest
            .spyOn(audiobookshelfService as any, "getAudiobook")
            .mockResolvedValue(multiTrackBook);
        setupClient();

        await audiobookshelfService.streamAudiobook("book-A", undefined, 1);
        await audiobookshelfService.streamAudiobook("book-B", undefined, 1);

        expect(getAudiobookSpy).toHaveBeenCalledTimes(2);

        // Subsequent calls to both hit the cache.
        await audiobookshelfService.streamAudiobook("book-A", undefined, 1);
        await audiobookshelfService.streamAudiobook("book-B", undefined, 1);
        expect(getAudiobookSpy).toHaveBeenCalledTimes(2);
    });
});

// ── Timeout: 15_000 on the stream request ─────────────────────────────────────

describe("streamAudiobook timeout", () => {
    it("passes timeout: 15_000 to the axios request", async () => {
        jest.spyOn(audiobookshelfService as any, "getAudiobook").mockResolvedValue(multiTrackBook);
        const client = setupClient();

        await audiobookshelfService.streamAudiobook("book-to", undefined, 1);

        expect(client.get).toHaveBeenCalledWith(
            "/abs/t1",
            expect.objectContaining({ timeout: 15_000 }),
        );
    });

    it("rejects when upstream returns a timeout error", async () => {
        jest.spyOn(audiobookshelfService as any, "getAudiobook").mockResolvedValue(multiTrackBook);

        // Simulate an axios timeout rejection (what axios emits when its own
        // timeout fires -- we verify the timeout value is 15_000 in the prior test).
        (audiobookshelfService as any).client = {
            get: jest.fn().mockRejectedValue(Object.assign(new Error("timeout"), { code: "ECONNABORTED" })),
        };

        await expect(
            audiobookshelfService.streamAudiobook("book-hang", undefined, 1),
        ).rejects.toThrow("timeout");
    });
});

// ── The listing the prune relies on ───────────────────────────────────────────

describe("getAllAudiobooks", () => {
    const book = (id: string) => ({ id });
    function listingOf(libraries: Array<{ id: string; mediaType: string }>, items: Record<string, unknown>) {
        const get = jest.fn(async (url: string) => {
            if (url === "/api/libraries") return { data: { libraries } };
            const answer = items[url.split("/")[3]];
            if (answer instanceof Error) throw answer;
            return { data: answer };
        });
        (audiobookshelfService as any).client = { get };
    }

    it("is complete when every book library answered with all of its items", async () => {
        listingOf([{ id: "l1", mediaType: "book" }, { id: "m1", mediaType: "music" }], {
            l1: { results: [book("a"), book("b")], total: 2 },
        });

        expect(await audiobookshelfService.getAllAudiobooks()).toEqual({ books: [book("a"), book("b")], complete: true });
    });

    it("is complete when the library does not say its total", async () => {
        listingOf([{ id: "l1", mediaType: "book" }], { l1: { results: [book("a")] } });

        expect((await audiobookshelfService.getAllAudiobooks()).complete).toBe(true);
    });

    it("is incomplete when a library answered fewer items than its total", async () => {
        listingOf([{ id: "l1", mediaType: "book" }], { l1: { results: [book("a")], total: 3 } });

        expect(await audiobookshelfService.getAllAudiobooks()).toEqual({ books: [book("a")], complete: false });
    });

    it("keeps the books of the libraries that answered, and is incomplete, when another library failed", async () => {
        listingOf([{ id: "l1", mediaType: "book" }, { id: "l2", mediaType: "book" }], {
            l1: { results: [book("a")], total: 1 },
            l2: new Error("503"),
        });

        expect(await audiobookshelfService.getAllAudiobooks()).toEqual({ books: [book("a")], complete: false });
    });

    it("fails when no book library could be read at all", async () => {
        listingOf([{ id: "l1", mediaType: "book" }], { l1: new Error("503") });

        await expect(audiobookshelfService.getAllAudiobooks()).rejects.toThrow("503");
    });
});

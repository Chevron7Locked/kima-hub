/**
 * The web service worker shows a stored cover from its cache at once and checks the server for a changed one meanwhile,
 * so a changed cover reaches the web app without the cache being cleared. A cover fetched from another site's address
 * keeps the plain cache-first rule. The worker file is run as it ships, against a small in-memory cache and fetch.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

type FetchListener = (event: { request: Request; respondWith: (p: Promise<Response>) => void; waitUntil: (p: Promise<unknown>) => void }) => void;

const source = readFileSync(path.join(__dirname, "../../public/sw.js"), "utf8");

function load() {
    const stores = new Map<string, Map<string, Response>>();
    const store = (name: string) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name)!;
    };
    const caches = {
        open: async (name: string) => ({
            match: async (req: Request) => store(name).get(req.url)?.clone(),
            put: async (req: Request, res: Response) => void store(name).set(req.url, res),
            keys: async () => [...store(name).keys()].map((u) => new Request(u)),
            delete: async (req: Request) => store(name).delete(req.url),
            addAll: async () => undefined,
        }),
        keys: async () => [...stores.keys()],
        delete: async (name: string) => stores.delete(name),
    };
    let listener: FetchListener | undefined;
    const self = {
        addEventListener: (type: string, fn: FetchListener) => {
            if (type === "fetch") listener = fn;
        },
        skipWaiting: () => undefined,
        clients: { claim: () => undefined },
    };
    const fetchMock = vi.fn<(req: Request, init?: RequestInit) => Promise<Response>>();
    new Function("self", "caches", "fetch", source)(self, caches, fetchMock);

    /** Sends one request through the worker; answers the response and waits for the work it kept going. */
    async function request(url: string) {
        const waits: Promise<unknown>[] = [];
        let answer: Promise<Response> | undefined;
        listener!({
            request: new Request(url),
            respondWith: (p) => void (answer = p),
            waitUntil: (p) => void waits.push(p),
        });
        const response = answer ? await answer : null;
        await Promise.all(waits);
        // The queue's own bookkeeping runs on a timer after each fetch.
        await new Promise((r) => setTimeout(r, 30));
        return response;
    }
    return { request, fetchMock, store };
}

const photo = (body: string, etag: string) =>
    new Response(body, { status: 200, headers: { "content-type": "image/jpeg", etag } });
const NATIVE = "http://kima.test/api/library/cover-art?url=native%3Aalbums%2Fa1.jpg&size=300&token=abc";
const KEY = "http://kima.test/api/library/cover-art?url=native%3Aalbums%2Fa1.jpg&size=300";
const REMOTE = "http://kima.test/api/library/cover-art?url=https%3A%2F%2Fexample.org%2Fc.jpg&size=300&token=abc";
const REMOTE_KEY = "http://kima.test/api/library/cover-art?url=https%3A%2F%2Fexample.org%2Fc.jpg&size=300";

let sw: ReturnType<typeof load>;
beforeEach(() => {
    sw = load();
});

describe("a stored cover (native address)", () => {
    it("is fetched and cached the first time", async () => {
        sw.fetchMock.mockResolvedValue(photo("one", '"v1"'));

        const res = await sw.request(NATIVE);

        expect(await res!.text()).toBe("one");
        expect(await sw.store("kima-images-v3").get(KEY)!.text()).toBe("one");
    });

    it("is shown from the cache at once, and the server is asked meanwhile whether it changed", async () => {
        sw.fetchMock.mockResolvedValueOnce(photo("one", '"v1"'));
        await sw.request(NATIVE);
        sw.fetchMock.mockResolvedValueOnce(photo("two", '"v2"'));

        const res = await sw.request(NATIVE);

        expect(await res!.text()).toBe("one");
        expect(sw.fetchMock).toHaveBeenCalledTimes(2);
        expect(sw.fetchMock.mock.calls[1][1]).toMatchObject({ cache: "no-cache" });
    });

    it("keeps the changed cover for the next time it is shown", async () => {
        sw.fetchMock.mockResolvedValueOnce(photo("one", '"v1"'));
        await sw.request(NATIVE);
        sw.fetchMock.mockResolvedValueOnce(photo("two", '"v2"'));
        await sw.request(NATIVE);
        sw.fetchMock.mockResolvedValueOnce(photo("two", '"v2"'));

        const res = await sw.request(NATIVE);

        expect(await res!.text()).toBe("two");
    });

    it("keeps the cached picture when the server cannot be reached or does not have the cover", async () => {
        sw.fetchMock.mockResolvedValueOnce(photo("one", '"v1"'));
        await sw.request(NATIVE);
        sw.fetchMock.mockRejectedValueOnce(new Error("offline"));
        await sw.request(NATIVE);
        sw.fetchMock.mockResolvedValueOnce(new Response("gone", { status: 404 }));
        await sw.request(NATIVE);
        sw.fetchMock.mockResolvedValueOnce(new Response("down", { status: 500 }));

        const res = await sw.request(NATIVE);

        expect(await res!.text()).toBe("one");
        expect(await sw.store("kima-images-v3").get(KEY)!.text()).toBe("one");
    });

    it("does not store the sign-in token in the cache key", async () => {
        sw.fetchMock.mockResolvedValue(photo("one", '"v1"'));

        await sw.request(NATIVE);

        expect([...sw.store("kima-images-v3").keys()]).toEqual([KEY]);
    });
});

describe("a cover from another site's address", () => {
    it("stays cache-first: shown from the cache with no request to the server", async () => {
        sw.fetchMock.mockResolvedValueOnce(photo("remote", '"r1"'));
        await sw.request(REMOTE);

        const res = await sw.request(REMOTE);

        expect(await res!.text()).toBe("remote");
        expect(sw.fetchMock).toHaveBeenCalledTimes(1);
        expect(sw.store("kima-images-v3").has(REMOTE_KEY)).toBe(true);
    });
});

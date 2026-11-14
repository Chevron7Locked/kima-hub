/**
 * The metadata of a share page, read by chat apps. The page asks the backend for the share from the web server, so the
 * backend's per-address limits see the visitor only if the visitor's forwarded address goes along with that request;
 * otherwise every visitor is one address. The Open Graph type follows what is shared.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { shareMetadata } from "@/lib/shareMetadata";

const incoming = new Headers({
    "x-forwarded-for": "203.0.113.9",
    "x-forwarded-proto": "https",
    "x-forwarded-host": "kima.example.com",
});

function backendReplies(body: unknown, ok = true) {
    const fetchMock = vi.fn(async () => ({ ok, json: async () => body }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("shareMetadata", () => {
    it("forwards the visitor's address on the backend request", async () => {
        const fetchMock = backendReplies({ entityType: "album", entity: { title: "An Album", artist: { name: "Someone" } } });
        await shareMetadata("tok", incoming);
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toMatch(/\/api\/share\/tok$/);
        expect(new Headers(init.headers).get("x-forwarded-for")).toBe("203.0.113.9");
    });

    it("sends no forwarded address when the request had none", async () => {
        const fetchMock = backendReplies({ entityType: "album", entity: { title: "An Album" } });
        await shareMetadata("tok", new Headers({ host: "127.0.0.1:3030" }));
        const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(new Headers(init.headers).has("x-forwarded-for")).toBe(false);
    });

    it.each([
        ["album", "music.album"],
        ["playlist", "music.playlist"],
        ["track", "music.song"],
    ])("a %s share is %s", async (entityType, type) => {
        backendReplies({ entityType, entity: { title: "x", name: "x" } });
        const meta = await shareMetadata("tok", incoming);
        expect((meta.openGraph as { type: string }).type).toBe(type);
    });

    it("puts the share's cover in the preview image", async () => {
        backendReplies({ entityType: "album", entity: { title: "An Album", coverUrl: "native:covers/a.jpg" } });
        const meta = await shareMetadata("tok", incoming);
        expect(meta.openGraph?.images).toEqual([
            { url: "https://kima.example.com/api/share/tok/cover-art/native%3Acovers%2Fa.jpg?size=500" },
        ]);
    });

    it("answers a plain title when the backend refuses the share", async () => {
        backendReplies({}, false);
        expect(await shareMetadata("tok", incoming)).toEqual({ title: "shared music - kima" });
    });

    it("encodes the token in the backend address", async () => {
        const fetchMock = backendReplies({ entityType: "album", entity: { title: "x" } });
        await shareMetadata("a/b", incoming);
        expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toMatch(/\/api\/share\/a%2Fb$/);
    });
});

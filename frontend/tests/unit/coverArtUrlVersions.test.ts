/**
 * A cover value carries its version (`native:albums/a.jpg?v=<hash>`, `/audiobooks/<id>/cover/<version>`), and the web
 * client builds the address from it untouched, so a changed cover is a new address. The version is not stripped, not
 * re-encoded apart from the one query-string encoding, and not replaced by anything the client makes up.
 */

import { describe, expect, it } from "vitest";
import { api } from "@/lib/api";

describe("getCoverArtUrl", () => {
    it("passes a stored cover's version through inside the url parameter", () => {
        const url = new URL(api.getCoverArtUrl("native:albums/a1.jpg?v=0123456789", 300, false), "http://kima.test");

        expect(url.pathname).toBe("/api/library/cover-art");
        expect(url.searchParams.get("url")).toBe("native:albums/a1.jpg?v=0123456789");
        expect(url.searchParams.get("size")).toBe("300");
    });

    it("gives two versions of one cover two addresses", () => {
        const a = api.getCoverArtUrl("native:albums/a1.jpg?v=aaaaaaaaaa", 300, false);
        const b = api.getCoverArtUrl("native:albums/a1.jpg?v=bbbbbbbbbb", 300, false);

        expect(a).not.toBe(b);
    });

    it("keeps an unversioned stored cover working", () => {
        const url = new URL(api.getCoverArtUrl("native:albums/a1.jpg", 300, false), "http://kima.test");

        expect(url.searchParams.get("url")).toBe("native:albums/a1.jpg");
    });

    it("passes an audiobook cover's version through as the path's last segment", () => {
        const url = new URL(api.getCoverArtUrl("/audiobooks/book-1/cover/lq3x9z", undefined, false), "http://kima.test");

        expect(url.pathname).toBe("/api/audiobooks/book-1/cover/lq3x9z");
    });
});

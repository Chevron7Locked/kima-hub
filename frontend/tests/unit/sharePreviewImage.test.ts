/**
 * A share link pasted into a chat app shows the shared cover. The chat app fetches the Open Graph image itself, so its
 * address must be absolute, on the host the link was opened on, and the share's own cover route (the only one that
 * serves a cover to a stranger). A cover that route would refuse, and a share with no cover, give no image.
 */

import { describe, expect, it } from "vitest";
import { sharePreviewImage } from "@/lib/sharePreviewImage";

const proxied = new Headers({ "x-forwarded-proto": "https", "x-forwarded-host": "kima.example.com", host: "127.0.0.1:3030" });

describe("sharePreviewImage", () => {
    it("is the share's cover route on the forwarded proto and host", () => {
        const entity = { coverUrl: "native:covers/abc.jpg?v=7" };
        expect(sharePreviewImage("tok123", entity, proxied)).toBe(
            "https://kima.example.com/api/share/tok123/cover-art/native%3Acovers%2Fabc.jpg%3Fv%3D7?size=500",
        );
    });

    it("uses the first cover of a playlist share", () => {
        const entity = { items: [{ track: { album: { coverUrl: "native:covers/p.jpg" } } }] };
        expect(sharePreviewImage("tok", entity, proxied)).toBe(
            "https://kima.example.com/api/share/tok/cover-art/native%3Acovers%2Fp.jpg?size=500",
        );
    });

    it("uses the album's cover for a song share", () => {
        const entity = { album: { coverUrl: "native:covers/s.jpg" } };
        expect(sharePreviewImage("tok", entity, proxied)).toContain("/cover-art/native%3Acovers%2Fs.jpg?size=500");
    });

    it("takes the first of a list of forwarded values", () => {
        const headers = new Headers({ "x-forwarded-proto": "https, http", "x-forwarded-host": "kima.example.com, inner:3030" });
        expect(sharePreviewImage("tok", { coverUrl: "native:a.jpg" }, headers)).toMatch(/^https:\/\/kima\.example\.com\/api\/share\//);
    });

    it("falls back to the host header and plain http when nothing is forwarded", () => {
        const headers = new Headers({ host: "192.168.1.5:3030" });
        expect(sharePreviewImage("tok", { coverUrl: "native:a.jpg" }, headers)).toMatch(/^http:\/\/192\.168\.1\.5:3030\/api\/share\/tok\//);
    });

    it("gives no image for a cover from outside (the share's cover route refuses it)", () => {
        expect(sharePreviewImage("tok", { coverUrl: "https://elsewhere.example/c.jpg" }, proxied)).toBeNull();
    });

    it("gives no image when the share has no cover", () => {
        expect(sharePreviewImage("tok", { items: [] }, proxied)).toBeNull();
        expect(sharePreviewImage("tok", { coverUrl: null }, proxied)).toBeNull();
        expect(sharePreviewImage("tok", undefined, proxied)).toBeNull();
    });

    it("gives no image when no host is known, rather than a relative address", () => {
        expect(sharePreviewImage("tok", { coverUrl: "native:a.jpg" }, new Headers())).toBeNull();
    });

    it("refuses a proto that is not http or https and a host that is not a host", () => {
        const badProto = new Headers({ "x-forwarded-proto": "javascript", "x-forwarded-host": "kima.example.com" });
        expect(sharePreviewImage("tok", { coverUrl: "native:a.jpg" }, badProto)).toMatch(/^http:\/\/kima\.example\.com\//);
        const badHost = new Headers({ "x-forwarded-host": "evil.example/x?y=", host: "kima.local" });
        expect(sharePreviewImage("tok", { coverUrl: "native:a.jpg" }, badHost)).toMatch(/^http:\/\/kima\.local\//);
    });
});

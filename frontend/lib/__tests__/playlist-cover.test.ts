import { describe, it, expect } from "vitest";
import {
    isCoverImage,
    coverUploadError,
    COVER_ACCEPT,
    COVER_MAX_BYTES,
} from "@/features/playlist/playlistCover";

function fakeFile(partial: {
    type?: string;
    name?: string;
    size?: number;
} = {}): { type: string; name: string; size: number } {
    return { type: partial.type ?? "image/jpeg", name: partial.name ?? "cover.jpg", size: partial.size ?? 1000 };
}

describe("isCoverImage", () => {
    it.each([
        { type: "image/jpeg", name: "cover.jpg" },
        { type: "image/png", name: "cover.png" },
        { type: "image/webp", name: "cover.webp" },
    ])("accepts $type files", (file) => {
        expect(isCoverImage(fakeFile(file))).toBe(true);
    });

    it("accepts files with an empty MIME type when the extension matches", () => {
        // Some Android/TV file pickers report no type at all.
        expect(isCoverImage(fakeFile({ type: "", name: "cover.WEBP" }))).toBe(true);
        expect(isCoverImage(fakeFile({ type: "", name: "cover.jpg" }))).toBe(true);
    });

    it("rejects a non-cover MIME type even with a cover-looking extension", () => {
        expect(isCoverImage(fakeFile({ type: "image/gif", name: "cover.gif" }))).toBe(false);
        expect(isCoverImage(fakeFile({ type: "text/plain", name: "notes.txt" }))).toBe(false);
    });

    it("rejects a file with an empty MIME type and a non-cover extension", () => {
        expect(isCoverImage(fakeFile({ type: "", name: "cover.bmp" }))).toBe(false);
        expect(isCoverImage(fakeFile({ type: "", name: "archive.zip" }))).toBe(false);
    });

    it("rejects a name without an extension", () => {
        expect(isCoverImage(fakeFile({ type: "", name: "noextension" }))).toBe(false);
    });
});

describe("coverUploadError", () => {
    it("returns null for a valid small image", () => {
        expect(coverUploadError(fakeFile())).toBeNull();
    });

    it("returns the format message for a disallowed type", () => {
        expect(coverUploadError(fakeFile({ type: "image/gif", name: "cover.gif" }))).toBe(
            "Only JPEG, PNG and WebP images are supported"
        );
    });

    it("returns the size message for an oversized image", () => {
        expect(coverUploadError(fakeFile({ size: COVER_MAX_BYTES + 1 }))).toBe(
            "Image is larger than 10 MB"
        );
    });

    it("allows a file exactly at the size limit", () => {
        expect(coverUploadError(fakeFile({ size: COVER_MAX_BYTES }))).toBeNull();
    });

    it("exposes the input accept string that matches the supported set", () => {
        expect(COVER_ACCEPT.split(",")).toEqual(["image/jpeg", "image/png", "image/webp"]);
        expect(COVER_MAX_BYTES).toBe(10 * 1024 * 1024);
    });
});

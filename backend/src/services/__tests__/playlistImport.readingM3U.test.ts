import { M3UContainsNullBytes, M3UTooManyEntries, decodeM3U, parseM3U } from "../playlistImport";

describe("M3U Parser", () => {
    it("parses basic M3U (paths only, no metadata)", () => {
        const content = `/music/Artist/Album/01 - Track.flac
/music/Artist/Album/02 - Song.mp3`;

        const entries = parseM3U(content);
        expect(entries).toHaveLength(2);
        expect(entries[0].filePath).toBe("/music/Artist/Album/01 - Track.flac");
        expect(entries[0].artist).toBeNull();
        expect(entries[0].title).toBeNull();
    });

    it("parses extended M3U with EXTINF metadata", () => {
        const content = `#EXTM3U
#EXTINF:213,Alice in Chains - Rotten Apple
/music/Alice in Chains/Jar of Flies/04 - Rotten Apple.flac
#EXTINF:185,Tool - Lateralus
/music/Tool/Lateralus/09 - Lateralus.flac`;

        const entries = parseM3U(content);
        expect(entries).toHaveLength(2);
        expect(entries[0].artist).toBe("Alice in Chains");
        expect(entries[0].title).toBe("Rotten Apple");
        expect(entries[0].durationSeconds).toBe(213);
        expect(entries[0].filePath).toBe(
            "/music/Alice in Chains/Jar of Flies/04 - Rotten Apple.flac",
        );
    });

    it("handles Windows backslash paths", () => {
        const content = `#EXTM3U
#EXTINF:200,Artist - Title
C:\\Music\\Artist\\Album\\01 - Title.mp3`;

        const entries = parseM3U(content);
        expect(entries[0].filePath).toBe("C:/Music/Artist/Album/01 - Title.mp3");
    });

    it("skips empty lines and unknown directives", () => {
        const content = `#EXTM3U
#EXTGRP:Rock

#EXTINF:100,Band - Song
/music/song.flac

`;
        const entries = parseM3U(content);
        expect(entries).toHaveLength(1);
    });

    it("handles EXTINF with no artist separator (title only)", () => {
        const content = `#EXTM3U
#EXTINF:180,Just A Title
/music/file.mp3`;

        const entries = parseM3U(content);
        expect(entries[0].artist).toBeNull();
        expect(entries[0].title).toBe("Just A Title");
    });

    it("rejects files exceeding max entry limit", () => {
        const lines = Array.from(
            { length: 10001 },
            (_, i) => `/music/track${i}.mp3`,
        ).join("\n");
        expect(() => parseM3U(lines, { maxEntries: 10000 })).toThrow(
            "exceeds maximum",
        );
    });

    it("rejects content with null bytes", () => {
        const content = `/music/track\x00.mp3`;
        expect(() => parseM3U(content)).toThrow("null bytes");
    });

    it("refuses with errors a caller can tell apart by type, not by their wording", () => {
        const many = Array.from({ length: 4 }, (_, i) => `/music/track${i}.mp3`).join("\n");
        expect(() => parseM3U(many, { maxEntries: 3 })).toThrow(M3UTooManyEntries);
        expect(() => parseM3U("/music/track\x00.mp3")).toThrow(M3UContainsNullBytes);
    });
});

describe("decodeM3U", () => {
    it("reads valid UTF-8 as UTF-8, with or without a byte order mark", () => {
        expect(decodeM3U(Buffer.from("Café/日本.flac", "utf-8"))).toBe("Café/日本.flac");
        expect(decodeM3U(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Café.flac", "utf-8")]))).toBe("Café.flac");
    });

    it("reads bytes that are not valid UTF-8 as Windows-1252", () => {
        expect(decodeM3U(Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x2e]))).toBe("Café.");
        expect(decodeM3U(Buffer.from([0x92, 0x80]))).toBe("\u2019\u20ac");
    });

    it("reads a file with a byte order mark as UTF-8 even when its bytes are not valid UTF-8", () => {
        expect(decodeM3U(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from([0x61, 0xe9])]))).toBe("a\ufffd");
    });

    it("reads UTF-16 with a byte order mark, either byte order", () => {
        const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Café\\a.flac", "utf16le")]);
        expect(decodeM3U(le)).toBe("Café\\a.flac");
        const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(Buffer.from("Café\\a.flac", "utf16le")).swap16()]);
        expect(decodeM3U(be)).toBe("Café\\a.flac");
    });

    it("reads plain ASCII as itself", () => {
        expect(decodeM3U(Buffer.from("a/b.flac"))).toBe("a/b.flac");
    });
});

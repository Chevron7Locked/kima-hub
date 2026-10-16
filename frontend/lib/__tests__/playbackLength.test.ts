import { describe, expect, it } from "vitest";
import { playbackLength } from "@/lib/format";

describe("playbackLength", () => {
    it("is the engine's length once it has one, for a track or a podcast, longer or shorter than the stored one", () => {
        expect(playbackLength({ multiFile: false, stored: 4844, engine: 5344.7 })).toBe(5344.7);
        expect(playbackLength({ multiFile: false, stored: 200, engine: 190 })).toBe(190);
    });

    it("is the stored length until the engine has one", () => {
        expect(playbackLength({ multiFile: false, stored: 4844, engine: 0 })).toBe(4844);
    });

    it("is a multi-file audiobook's whole stored length, never the one file the engine has open", () => {
        expect(playbackLength({ multiFile: true, stored: 36000, engine: 1800 })).toBe(36000);
    });

    it("is 0 when nothing knows the length", () => {
        expect(playbackLength({ multiFile: false, stored: 0, engine: 0 })).toBe(0);
        expect(playbackLength({ multiFile: true, stored: 0, engine: 1800 })).toBe(0);
    });
});

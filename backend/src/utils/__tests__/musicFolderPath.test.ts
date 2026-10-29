/**
 * A downloaded file's place in the music folder is built from names other people chose (a playlist's artist and
 * album, a Soulseek peer's file name). Each name becomes one safe folder or file name, and the result never leaves the
 * music folder; names are otherwise kept as they are.
 */
import path from "path";
import { pathInMusicFolder, safePathPart } from "../musicFolderPath";

const MUSIC = path.resolve("/srv/music");

describe("safePathPart", () => {
    it.each([
        ["..", "_"],
        [".", "_"],
        ["...", "_"],
        ["", "_"],
        ["   ", "_"],
        ["a/b", "a_b"],
        ["a\\b", "a_b"],
        ['AC:DC <live> "x" |?*', "AC_DC _live_ _x_ ___"],
        ["tab\there", "tab_here"],
    ])("makes %p into %p", (name, safe) => {
        expect(safePathPart(name)).toBe(safe);
    });

    it.each(["...And You Will Know Us by the Trail of Dead", ".hack", "Sigur Rós", "Vol. 2", "  padded  "])(
        "keeps %p as a name",
        (name) => {
            expect(safePathPart(name)).toBe(name.trim());
        },
    );
});

describe("pathInMusicFolder", () => {
    it("joins the safe names under the music folder", () => {
        expect(pathInMusicFolder(MUSIC, "Singles", "Low", "Things", "01.flac")).toBe(path.join(MUSIC, "Singles", "Low", "Things", "01.flac"));
    });

    it("works with the music folder at the root of the disk", () => {
        expect(pathInMusicFolder("/", "Low", "x.flac")).toBe(path.join("/", "Low", "x.flac"));
    });

    it.each([
        [["..", "..", "x.flac"]],
        [["Singles", "..", "..", ".."]],
        [["../..", "etc", "passwd"]],
    ])("never leaves the music folder for %p", (parts) => {
        const result = pathInMusicFolder(MUSIC, ...parts);
        expect(result.startsWith(MUSIC + path.sep)).toBe(true);
    });
});

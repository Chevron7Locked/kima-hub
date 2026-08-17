/**
 * `resolveWithinMusicRoot` -- the guard between a database string and rm -rf.
 *
 * The read paths (streaming, waveform, subsonic playback) went through this
 * from the start. The DELETE paths did not: they joined the music root to a
 * stored value and handed the result to unlinkSync or
 * rmSync(recursive, force). The cases below are the ones that made that a real
 * hole rather than a theoretical one -- `Artist.name` and `Album.title` are ID3
 * tag values, so a file added to the watched folder chooses them.
 */

jest.mock("../../../config", () => ({
  config: { music: { musicPath: "/music" } },
}));

import { resolveTrackFilePath, resolveWithinMusicRoot } from "../trackPath";

describe("paths inside the root resolve", () => {
  it("resolves a plain relative path", () => {
    expect(resolveWithinMusicRoot("Radiohead/OK Computer/01.flac")).toBe(
      "/music/Radiohead/OK Computer/01.flac",
    );
  });

  it("joins multiple segments", () => {
    expect(resolveWithinMusicRoot("Radiohead", "OK Computer")).toBe(
      "/music/Radiohead/OK Computer",
    );
  });

  it("allows interior dot segments that stay inside", () => {
    expect(resolveWithinMusicRoot("Radiohead/../Muse/album")).toBe(
      "/music/Muse/album",
    );
  });

  it("keeps a name that merely contains dots", () => {
    expect(resolveWithinMusicRoot("A...Band", "album")).toBe(
      "/music/A...Band/album",
    );
  });
});

describe("paths that escape the root are refused", () => {
  it.each([
    ["../etc/passwd"],
    ["../../etc/passwd"],
    ["Radiohead/../../etc"],
    ["/etc/passwd"],
    ["../../../../tmp/x"],
  ])("refuses %s", (evil) => {
    expect(resolveWithinMusicRoot(evil)).toBeNull();
  });

  it("refuses an escape hidden in a later segment", () => {
    // The album-folder delete passes artist and title separately, so the
    // traversal can arrive in either one.
    expect(resolveWithinMusicRoot("Radiohead", "../../../../tmp/x")).toBeNull();
  });

  it("refuses an escape in the FIRST of several segments", () => {
    expect(resolveWithinMusicRoot("../../tmp", "album")).toBeNull();
  });

  it("refuses backslash traversal from a Windows-scanned library", () => {
    expect(resolveWithinMusicRoot("..\\..\\etc")).toBeNull();
  });

  it("refuses the music root itself", () => {
    // "delete the music directory" is never the intended answer, so the
    // root is out even though it does not escape.
    expect(resolveWithinMusicRoot(".")).toBeNull();
    expect(resolveWithinMusicRoot("")).toBeNull();
  });

  it("refuses a sibling directory that merely shares the prefix", () => {
    // /music-backup starts with /music as a STRING but is a different
    // directory; the separator in the check is what distinguishes them.
    expect(resolveWithinMusicRoot("../music-backup/x")).toBeNull();
  });
});

describe("resolveTrackFilePath keeps its old contract", () => {
  it("resolves a track path", () => {
    expect(resolveTrackFilePath("Artist/Album/t.mp3")).toBe(
      "/music/Artist/Album/t.mp3",
    );
  });

  it("refuses a traversing track path", () => {
    expect(resolveTrackFilePath("../../etc/passwd")).toBeNull();
  });
});

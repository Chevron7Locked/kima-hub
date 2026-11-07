/** extractPlaylist: yt-dlp is run only for a music link, and only with the arguments that keep it on that site. The yt-dlp program is stood in for. */
jest.mock("../../utils/logger", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
const mockExecFile = jest.fn();
jest.mock("child_process", () => ({ ...jest.requireActual("child_process"), execFile: (...a: unknown[]) => mockExecFile(...a) }));

import { extractPlaylist } from "../ytdlp";

beforeEach(() => {
    mockExecFile.mockReset();
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, done: (e: null, out: string, err: string) => void) =>
        done(null, JSON.stringify({ id: "abc", title: "Song", _playlist_title: "Mix", _playlist_id: "PL1" }) + "\n", ""),
    );
});

describe("extractPlaylist", () => {
    it.each([
        "https://youtube.com.evil.invalid/playlist?list=x",
        "https://example.com/",
        "https://youtube.com@evil.invalid/",
        "file:///etc/passwd",
        "ftp://youtube.com/x",
        "--exec=touch /tmp/x",
        "not a url",
    ])("refuses %s without running yt-dlp", async (url) => {
        await expect(extractPlaylist(url)).rejects.toThrow();
        expect(mockExecFile).not.toHaveBeenCalled();
    });
});

describe("extractPlaylist for a real playlist", () => {
    it("runs yt-dlp with the generic fallback off and the link after a --", async () => {
        const playlist = await extractPlaylist("https://www.youtube.com/playlist?list=PL123");
        expect(mockExecFile).toHaveBeenCalledTimes(1);
        expect(mockExecFile.mock.calls[0][0]).toBe("yt-dlp");
        expect(mockExecFile.mock.calls[0][1]).toEqual([
            "--flat-playlist",
            "--dump-json",
            "--no-warnings",
            "--extractor-args", "youtube:lang=en",
            "--ies", "default,-generic",
            "--",
            "https://www.youtube.com/playlist?list=PL123",
        ]);
        expect(playlist).toMatchObject({ id: "PL1", title: "Mix", platform: "YouTube" });
    });

    it("gives yt-dlp the parsed address", async () => {
        await extractPlaylist("https://youtu.be\\@evil.invalid/abc");
        const args = mockExecFile.mock.calls[0][1] as string[];
        expect(args[args.length - 1]).toBe("https://youtu.be/@evil.invalid/abc");
    });
});

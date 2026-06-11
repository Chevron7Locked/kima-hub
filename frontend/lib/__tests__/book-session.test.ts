import { describe, it, expect, vi, beforeEach } from "vitest";
import {
    BookSession,
    BookSessionUnavailableError,
    type BookFile,
} from "../book-session";

vi.mock("@/lib/api", () => ({
    api: {
        getAudiobook: vi.fn(),
    },
}));

import { api } from "@/lib/api";

const mockGetAudiobook = api.getAudiobook as ReturnType<typeof vi.fn>;

beforeEach(() => {
    vi.clearAllMocks();
});

const TRACK_A: BookFile = { index: 1, startOffset: 0, duration: 1200 };
const TRACK_B: BookFile = { index: 2, startOffset: 1200, duration: 900 };
const TRACK_C: BookFile = { index: 3, startOffset: 2100, duration: 600 };

describe("BookSession.open", () => {
    it("uses provided tracks when present and non-empty (multi-file)", async () => {
        const session = await BookSession.open({
            id: "book1",
            duration: 2700,
            tracks: [TRACK_A, TRACK_B],
        });
        expect(session.bookId).toBe("book1");
        expect(session.files).toHaveLength(2);
        expect(mockGetAudiobook).not.toHaveBeenCalled();
    });

    it("sorts unsorted provided tracks by startOffset", async () => {
        const session = await BookSession.open({
            id: "book1",
            duration: 2700,
            tracks: [TRACK_B, TRACK_A],
        });
        expect(session.files[0].index).toBe(1);
        expect(session.files[1].index).toBe(2);
    });

    it("fetches detail endpoint when no tracks provided", async () => {
        mockGetAudiobook.mockResolvedValueOnce({
            tracks: [TRACK_A, TRACK_B],
        });
        const session = await BookSession.open({ id: "book2", duration: 2700 });
        expect(mockGetAudiobook).toHaveBeenCalledWith("book2");
        expect(session.files).toHaveLength(2);
    });

    it("uses detail tracks when book.tracks is undefined", async () => {
        mockGetAudiobook.mockResolvedValueOnce({
            tracks: [TRACK_A, TRACK_B, TRACK_C],
        });
        const session = await BookSession.open({ id: "book3", duration: 2700 });
        expect(session.files).toHaveLength(3);
    });

    it("throws BookSessionUnavailableError when detail returns tracksUnavailable", async () => {
        mockGetAudiobook.mockResolvedValueOnce({ tracksUnavailable: true });
        await expect(
            BookSession.open({ id: "book4", duration: 3600 })
        ).rejects.toBeInstanceOf(BookSessionUnavailableError);
    });

    it("throws when trackCount is undefined and no tracks anywhere", async () => {
        mockGetAudiobook.mockResolvedValueOnce({});
        await expect(
            BookSession.open({ id: "book5", duration: 3600 })
        ).rejects.toBeInstanceOf(BookSessionUnavailableError);
    });

    it("throws when trackCount is null and no tracks anywhere", async () => {
        mockGetAudiobook.mockResolvedValueOnce({ trackCount: null });
        await expect(
            BookSession.open({ id: "book6", duration: 3600, trackCount: undefined })
        ).rejects.toBeInstanceOf(BookSessionUnavailableError);
    });

    it("never synthesizes when trackCount is null/undefined (UNKNOWN)", async () => {
        mockGetAudiobook.mockResolvedValueOnce({ trackCount: null });
        await expect(
            BookSession.open({ id: "book7", duration: 3600 })
        ).rejects.toBeInstanceOf(BookSessionUnavailableError);
        expect(mockGetAudiobook).toHaveBeenCalledTimes(1);
    });

    it("synthesizes single-file map when book.trackCount === 1", async () => {
        const session = await BookSession.open({
            id: "book8",
            duration: 3600,
            trackCount: 1,
        });
        expect(mockGetAudiobook).not.toHaveBeenCalled();
        expect(session.files).toHaveLength(1);
        expect(session.files[0]).toEqual({ index: 1, startOffset: 0, duration: 3600 });
    });

    it("synthesizes single-file map when book.trackCount === 0", async () => {
        const session = await BookSession.open({
            id: "book9",
            duration: 1800,
            trackCount: 0,
        });
        expect(session.files).toHaveLength(1);
        expect(session.files[0].index).toBe(1);
        expect(session.files[0].startOffset).toBe(0);
    });

    it("synthesizes single-file map when detail trackCount === 1 and no tracks array", async () => {
        mockGetAudiobook.mockResolvedValueOnce({ trackCount: 1 });
        const session = await BookSession.open({ id: "book10", duration: 900 });
        expect(session.files).toHaveLength(1);
        expect(session.files[0]).toEqual({ index: 1, startOffset: 0, duration: 900 });
    });

    it("uses one-entry track list verbatim from detail (no renumbering)", async () => {
        const singleTrack: BookFile = { index: 1, startOffset: 0, duration: 7200 };
        mockGetAudiobook.mockResolvedValueOnce({ tracks: [singleTrack] });
        const session = await BookSession.open({ id: "book11", duration: 7200 });
        expect(session.files).toHaveLength(1);
        expect(session.files[0].index).toBe(1);
    });

    it("preserves 1-based indexes verbatim from provided tracks", async () => {
        const session = await BookSession.open({
            id: "book12",
            duration: 2700,
            tracks: [TRACK_A, TRACK_B, TRACK_C],
        });
        expect(session.files.map((f) => f.index)).toEqual([1, 2, 3]);
    });
});

describe("BookSession.locate", () => {
    let session: BookSession;

    beforeEach(async () => {
        session = await BookSession.open({
            id: "loc-test",
            duration: 2700,
            tracks: [TRACK_A, TRACK_B, TRACK_C],
        });
    });

    it("locates t=0 to first file at fileTime 0", () => {
        const { file, fileTime } = session.locate(0);
        expect(file.index).toBe(1);
        expect(fileTime).toBe(0);
    });

    it("locates exact start of file 2 (startOffset boundary)", () => {
        const { file, fileTime } = session.locate(1200);
        expect(file.index).toBe(2);
        expect(fileTime).toBe(0);
    });

    it("locates exact start of file 3", () => {
        const { file, fileTime } = session.locate(2100);
        expect(file.index).toBe(3);
        expect(fileTime).toBe(0);
    });

    it("locates mid-file correctly", () => {
        const { file, fileTime } = session.locate(1500);
        expect(file.index).toBe(2);
        expect(fileTime).toBe(300);
    });

    it("locates t = duration to last file", () => {
        const { file, fileTime } = session.locate(2700);
        expect(file.index).toBe(3);
        expect(fileTime).toBe(600);
    });

    it("clamps t > duration to end of last file", () => {
        const { file, fileTime } = session.locate(99999);
        expect(file.index).toBe(3);
        expect(fileTime).toBe(TRACK_C.duration);
    });

    it("clamps t < 0 to start of first file", () => {
        const { file, fileTime } = session.locate(-500);
        expect(file.index).toBe(1);
        expect(fileTime).toBe(0);
    });

    it("locates 1 second before file 2 boundary", () => {
        const { file, fileTime } = session.locate(1199);
        expect(file.index).toBe(1);
        expect(fileTime).toBe(1199);
    });
});

describe("BookSession.absolute", () => {
    let session: BookSession;

    beforeEach(async () => {
        session = await BookSession.open({
            id: "abs-test",
            duration: 2700,
            tracks: [TRACK_A, TRACK_B, TRACK_C],
        });
    });

    it("round-trips locate -> absolute for a mid-file time", () => {
        const bookTime = 1500;
        const { file, fileTime } = session.locate(bookTime);
        expect(session.absolute(file, fileTime)).toBe(bookTime);
    });

    it("round-trips locate -> absolute for t=0", () => {
        const { file, fileTime } = session.locate(0);
        expect(session.absolute(file, fileTime)).toBe(0);
    });

    it("round-trips locate -> absolute for t=duration", () => {
        const { file, fileTime } = session.locate(2700);
        expect(session.absolute(file, fileTime)).toBe(2700);
    });

    it("round-trips locate -> absolute for each file boundary", () => {
        for (const t of [0, 1200, 2100, 2700]) {
            const { file, fileTime } = session.locate(t);
            expect(session.absolute(file, fileTime)).toBe(t);
        }
    });

    it("computes absolute for first file correctly", () => {
        expect(session.absolute(TRACK_A, 300)).toBe(300);
    });

    it("computes absolute for middle file correctly", () => {
        expect(session.absolute(TRACK_B, 450)).toBe(1650);
    });
});

describe("BookSession.isLastFile", () => {
    it("returns true for the only file in a single-file session", async () => {
        const session = await BookSession.open({
            id: "single",
            duration: 3600,
            trackCount: 1,
        });
        expect(session.isLastFile(session.files[0])).toBe(true);
    });

    it("returns false for non-last file in a multi-file session", async () => {
        const session = await BookSession.open({
            id: "multi",
            duration: 2700,
            tracks: [TRACK_A, TRACK_B, TRACK_C],
        });
        expect(session.isLastFile(TRACK_A)).toBe(false);
        expect(session.isLastFile(TRACK_B)).toBe(false);
    });

    it("returns true for the last file in a multi-file session", async () => {
        const session = await BookSession.open({
            id: "multi2",
            duration: 2700,
            tracks: [TRACK_A, TRACK_B, TRACK_C],
        });
        expect(session.isLastFile(TRACK_C)).toBe(true);
    });

    it("identifies last by index, not object identity", async () => {
        const session = await BookSession.open({
            id: "multi3",
            duration: 2700,
            tracks: [TRACK_A, TRACK_B],
        });
        const copy: BookFile = { index: 2, startOffset: 1200, duration: 900 };
        expect(session.isLastFile(copy)).toBe(true);
    });
});

describe("BookSession.fileByIndex", () => {
    it("returns undefined for an unknown index", async () => {
        const session = await BookSession.open({
            id: "fi-test",
            duration: 2700,
            tracks: [TRACK_A, TRACK_B],
        });
        expect(session.fileByIndex(99)).toBeUndefined();
    });

    it("returns the correct file for a valid 1-based index", async () => {
        const session = await BookSession.open({
            id: "fi-test2",
            duration: 2700,
            tracks: [TRACK_A, TRACK_B, TRACK_C],
        });
        expect(session.fileByIndex(2)).toEqual(TRACK_B);
    });
});

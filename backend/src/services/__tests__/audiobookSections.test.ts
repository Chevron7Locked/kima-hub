import { buildSections } from "../audiobookSections";

describe("buildSections", () => {
    describe("chapter coverage path", () => {
        it("returns sections from chapters when coverage >= 0.85", () => {
            const result = buildSections({
                duration: 10000,
                chapters: [
                    { title: "Chapter 1", start: 0, end: 5000 },
                    { title: "Chapter 2", start: 5000, end: 9000 },
                ],
                tracks: [{ startOffset: 0, name: "track.mp3" }],
            });

            expect(result).toHaveLength(2);
            expect(result[0]).toEqual({ index: 1, title: "Chapter 1", start: 0 });
            expect(result[1]).toEqual({ index: 2, title: "Chapter 2", start: 5000 });
        });

        it("sorts chapters by start offset", () => {
            const result = buildSections({
                duration: 10000,
                chapters: [
                    { title: "Chapter 2", start: 5000, end: 9000 },
                    { title: "Chapter 1", start: 0, end: 5000 },
                ],
                tracks: [],
            });

            expect(result[0].title).toBe("Chapter 1");
            expect(result[1].title).toBe("Chapter 2");
        });
    });

    describe("broken coverage → track fallback (Katie Mack case)", () => {
        const DURATION = 29000;
        const chapters = [
            { title: "Intro", start: 0, end: 4000 },
            { title: "Main", start: 4000, end: 9000 },
        ];
        // maxEnd = 9000, coverage = 9000/29000 ≈ 0.310 < 0.85 → falls through

        const tracks = [
            { startOffset: 0, name: "01 - Part 1.mp3" },
            { startOffset: 3625, name: "02 - Part 2.mp3" },
            { startOffset: 7250, name: "03 - Part 3.mp3" },
            { startOffset: 10875, name: "04 - Part 4.mp3" },
            { startOffset: 14500, name: "05 - Part 5.mp3" },
            { startOffset: 18125, name: "06 - Part 6.mp3" },
            { startOffset: 21750, name: "07 - Part 7.mp3" },
            { startOffset: 25375, name: "08 - Part 8.mp3" },
        ];

        it("returns 8 derived parts from tracks when chapter coverage is 0.31", () => {
            const result = buildSections({ duration: DURATION, chapters, tracks });

            expect(result).toHaveLength(8);
        });

        it("titles are cleaned (extension stripped, leading numbering removed)", () => {
            const result = buildSections({ duration: DURATION, chapters, tracks });

            expect(result[0].title).toBe("Part 1");
            expect(result[1].title).toBe("Part 2");
        });

        it("start offsets match track startOffsets", () => {
            const result = buildSections({ duration: DURATION, chapters, tracks });

            expect(result[0].start).toBe(0);
            expect(result[7].start).toBe(25375);
        });
    });

    describe("single-track → []", () => {
        it("returns [] when only one track and no chapters", () => {
            const result = buildSections({
                duration: 3600,
                chapters: [],
                tracks: [{ startOffset: 0, name: "book.mp3" }],
            });

            expect(result).toEqual([]);
        });
    });

    describe("duration guard", () => {
        it("returns [] when duration is 0", () => {
            expect(
                buildSections({
                    duration: 0,
                    chapters: [{ title: "Ch1", start: 0, end: 100 }],
                    tracks: [{ startOffset: 0 }, { startOffset: 50 }],
                })
            ).toEqual([]);
        });

        it("returns [] when duration is negative", () => {
            expect(
                buildSections({ duration: -1, chapters: [], tracks: [] })
            ).toEqual([]);
        });
    });

    describe("title cleaning", () => {
        it("strips file extension and leading numbering", () => {
            const result = buildSections({
                duration: 10000,
                chapters: [],
                tracks: [
                    { startOffset: 0, name: "01 - Chapter One.mp3" },
                    { startOffset: 3333, name: "02  Chapter Two.flac" },
                    { startOffset: 6666, name: "03. Chapter Three.m4b" },
                ],
            });

            expect(result[0].title).toBe("Chapter One");
            expect(result[1].title).toBe("Chapter Two");
            expect(result[2].title).toBe("Chapter Three");
        });

        it("strips 3-digit numeric prefix from ABS-style filenames", () => {
            const result = buildSections({
                duration: 3600,
                chapters: [],
                tracks: [
                    { startOffset: 0, name: "001 - The Beginning.mp3" },
                    { startOffset: 1800, name: "002 - The End.mp3" },
                ],
            });

            expect(result[0].title).toBe("The Beginning");
            expect(result[1].title).toBe("The End");
        });

        it("preserves 'Part NNN' filenames where no leading digit prefix exists", () => {
            const result = buildSections({
                duration: 3600,
                chapters: [],
                tracks: [
                    { startOffset: 0, name: "Part 001.mp3" },
                    { startOffset: 1800, name: "Part 002.mp3" },
                ],
            });

            expect(result[0].title).toBe("Part 001");
            expect(result[1].title).toBe("Part 002");
        });

        it("falls back to 'Part N' when name is empty after cleaning", () => {
            const result = buildSections({
                duration: 10000,
                chapters: [],
                tracks: [
                    { startOffset: 0 },
                    { startOffset: 5000 },
                ],
            });

            expect(result[0].title).toBe("Part 1");
            expect(result[1].title).toBe("Part 2");
        });
    });

    describe("no chapters, no tracks", () => {
        it("returns [] when both are empty", () => {
            expect(
                buildSections({ duration: 3600, chapters: [], tracks: [] })
            ).toEqual([]);
        });
    });
});

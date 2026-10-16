import { describe, expect, it } from "vitest";
import { sortShows } from "@/features/podcast/utils";

const shows = [
    { id: "b", title: "Beta", author: "Zed", latestEpisodeAt: "2026-03-01T00:00:00.000Z" },
    { id: "none", title: "Alpha", author: "Mia", latestEpisodeAt: null },
    { id: "a", title: "Gamma", author: "Ann", latestEpisodeAt: "2026-10-01T00:00:00.000Z" },
];

describe("sortShows", () => {
    it("puts the show that published most recently first, and a show with no episodes last", () => {
        expect(sortShows(shows, "latest").map((s) => s.id)).toEqual(["a", "b", "none"]);
    });

    it("sorts by title and by author", () => {
        expect(sortShows(shows, "title").map((s) => s.id)).toEqual(["none", "b", "a"]);
        expect(sortShows(shows, "author").map((s) => s.id)).toEqual(["a", "none", "b"]);
    });
});

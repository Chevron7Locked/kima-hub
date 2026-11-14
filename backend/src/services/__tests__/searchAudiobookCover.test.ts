/**
 * An audiobook found by search carries the same versioned cover address every other audiobook list does
 * (`/audiobooks/<id>/cover/<version>`), by the full-text path and by the fallback path, and none when it has no cover.
 * Real database; only the search interface is called.
 */

import { prisma } from "../../utils/db";
import { searchService } from "../search";
import { audiobookCoverAddress } from "../imageStorage";

const P = "zzsearchcover";
const WITH = { id: `${P}-with`, title: `${P} lantern`, coverUrl: "items/with/cover", coverVersion: "0a1b2c3d4e" };
const WITHOUT = { id: `${P}-without`, title: `${P} lantern bare`, coverUrl: null, coverVersion: null };

beforeAll(async () => {
    for (const b of [WITH, WITHOUT]) await prisma.audiobook.create({ data: { ...b, audioUrl: `${P}-${b.id}` } });
});

afterAll(async () => {
    await prisma.audiobook.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.$disconnect();
});

const address = audiobookCoverAddress({ id: WITH.id, localCoverPath: null, coverUrl: WITH.coverUrl, coverVersion: WITH.coverVersion });

describe("an audiobook search result's cover", () => {
    it("carries the version, from the full-text search", async () => {
        const found = await searchService.searchAudiobooksFTS({ query: `${P} lantern` });

        expect(address).toMatch(/^\/audiobooks\/zzsearchcover-with\/cover\/0a1b2c3d4e$/);
        expect(found.find((b) => b.id === WITH.id)?.coverUrl).toBe(address);
        expect(found.find((b) => b.id === WITHOUT.id)?.coverUrl).toBeNull();
    });

    it("carries the version, when the full-text search finds nothing and the substring search answers", async () => {
        // Starts mid-word: no full-text hit, so the answer comes from the fallback.
        const found = await searchService.searchAudiobooksFTS({ query: "chcover lantern" });

        expect(found.find((b) => b.id === WITH.id)?.coverUrl).toBe(address);
    });

    it("does not leak the columns the address is made from", async () => {
        const found = await searchService.searchAudiobooksFTS({ query: `${P} lantern` });

        expect(Object.keys(found[0]).sort()).toEqual(
            ["author", "coverUrl", "description", "duration", "id", "narrator", "rank", "series", "title"],
        );
    });
});

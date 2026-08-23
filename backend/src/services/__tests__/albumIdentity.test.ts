/**
 * Album identity.
 *
 * Regressions locked down here:
 *  - Only true duplicates merge: case/punctuation/accent/unicode-variant.
 *    Edition markers (remaster, deluxe, anniversary, remix, live, etc.) are
 *    NOT stripped -- they produce distinct album rows.
 *  - A cross-artist fallback matched title+year across EVERY artist, guarded
 *    only against the literal strings "Unknown Album"/"Unknown", so one
 *    artist's 1995 "Greatest Hits" absorbed another's.
 */

import { albumIdentityKey, isGenericAlbumTitle, resolveAlbum } from "../albumIdentity";

describe("albumIdentityKey — only true duplicates merge", () => {
    it("merges case variants of the same album", () => {
        const forms = [
            "Abbey Road",
            "abbey road",
            "ABBEY ROAD",
        ];
        const keys = forms.map(albumIdentityKey);
        expect(new Set(keys).size).toBe(1);
        expect(keys[0]).toBe("abbeyroad");
    });

    it("keeps edition variants apart", () => {
        expect(albumIdentityKey("Abbey Road (2019 Remaster)")).not.toBe(
            albumIdentityKey("Abbey Road")
        );
        expect(albumIdentityKey("Abbey Road [Remastered]")).not.toBe(
            albumIdentityKey("Abbey Road")
        );
        expect(albumIdentityKey("Abbey Road (Deluxe Edition)")).not.toBe(
            albumIdentityKey("Abbey Road")
        );
        expect(albumIdentityKey("Abbey Road (Super Deluxe)")).not.toBe(
            albumIdentityKey("Abbey Road")
        );
    });

    it.each([
        ["Nocturnal (Deluxe)", "nocturnaldeluxe"],
        ["In A Time Lapse (Deluxe Edition)", "inatimelapsedeluxeedition"],
        ["Dark Side of the Moon [Remastered]", "darksideofthemoonremastered"],
        ["4x4=12", "4x412"],
        ["Sigur Rós - Ágætis Byrjun", "sigurrosagaetisbyrjun"],
        ["Mötley Crüe", "motleycrue"],
    ])("%s -> %s", (title, expected) => {
        expect(albumIdentityKey(title)).toBe(expected);
    });
    it("keeps genuinely different albums apart", () => {
        expect(albumIdentityKey("Leather Teeth")).not.toBe(
            albumIdentityKey("Leather Temple")
        );
        expect(albumIdentityKey("Abbey Road")).not.toBe(
            albumIdentityKey("Abbey Road Sessions")
        );
        // Edition variants are distinct albums
        expect(albumIdentityKey("Abbey Road")).not.toBe(
            albumIdentityKey("Abbey Road (2019 Remaster)")
        );
        expect(albumIdentityKey("Playing the Angel")).not.toBe(
            albumIdentityKey("Playing the Angel (Deluxe)")
        );
        expect(albumIdentityKey("Random Access Memories")).not.toBe(
            albumIdentityKey("Random Access Memories (Drum & Bass Remix)")
        );
    });

    it("folds ligatures the same way Postgres unaccent() does", () => {
        // The SQL backfill and this function must agree, or a backfilled key is
        // unreachable at scan time and the duplicate comes straight back.
        expect(albumIdentityKey("Ágætis Byrjun")).toBe("agaetisbyrjun");
        expect(albumIdentityKey("Trøndelag")).toBe("trondelag");
        expect(albumIdentityKey("Straße")).toBe("strasse");
    });

    it("collapses a punctuation-only title to empty so the caller can fall back", () => {
        expect(albumIdentityKey("( )")).toBe("");
        expect(albumIdentityKey("...")).toBe("");
    });

    it("survives non-Latin titles", () => {
        expect(albumIdentityKey("初恋")).toBe("初恋");
    });

    it("handles null/undefined without throwing", () => {
        expect(albumIdentityKey(null)).toBe("");
        expect(albumIdentityKey(undefined)).toBe("");
    });
});

describe("instrumental albums stay separate from originals", () => {
    it('keeps "Album X" and "Album X (Instrumental)" apart', () => {
        expect(albumIdentityKey("Album X")).not.toBe(
            albumIdentityKey("Album X (Instrumental)")
        );
        expect(albumIdentityKey("Album X")).toBe("albumx");
        expect(albumIdentityKey("Album X (Instrumental)")).toBe("albumxinstrumental");
    });

    it('keeps "Album X (Instrumental)" and "Album X (Instrumental Edition)" apart', () => {
        expect(albumIdentityKey("Album X (Instrumental)")).not.toBe(
            albumIdentityKey("Album X (Instrumental Edition)")
        );
        expect(albumIdentityKey("Album X (Instrumental)")).toBe("albumxinstrumental");
        expect(albumIdentityKey("Album X (Instrumental Edition)")).toBe("albumxinstrumentaledition");
    });

    it('keeps "Album X (Instrumental)" and "Album X (Remastered)" apart', () => {
        expect(albumIdentityKey("Album X (Instrumental)")).not.toBe(
            albumIdentityKey("Album X (Remastered)")
        );
    });

    it('merges case variants of "instrumental" — "Album X (INSTRUMENTAL)" = "Album X (instrumental)"', () => {
        expect(albumIdentityKey("Album X (INSTRUMENTAL)")).toBe(
            albumIdentityKey("Album X (instrumental)")
        );
        expect(albumIdentityKey("Album X (INSTRUMENTAL)")).toBe("albumxinstrumental");
    });

    it('merges "The Instrumentals" and "The Instrumental" (true duplicate, not an edition)', () => {
        // These are different album titles — one is plural, one singular.
        // They should NOT merge.
        expect(albumIdentityKey("The Instrumentals")).not.toBe(
            albumIdentityKey("The Instrumental")
        );
        expect(albumIdentityKey("The Instrumentals")).toBe("theinstrumentals");
        expect(albumIdentityKey("The Instrumental")).toBe("theinstrumental");
    });

    it('merges case variants of "The Instrumental" (true duplicate)', () => {
        expect(albumIdentityKey("The Instrumental")).toBe(
            albumIdentityKey("THE INSTRUMENTAL")
        );
        expect(albumIdentityKey("The Instrumental")).toBe(
            albumIdentityKey("the instrumental")
        );
    });

    it('keeps "Album X" and "Album X (Instrumental)" distinct even with accents', () => {
        expect(albumIdentityKey("Álbum X")).not.toBe(
            albumIdentityKey("Álbum X (Instrumental)")
        );
        expect(albumIdentityKey("Álbum X")).toBe("albumx");
        expect(albumIdentityKey("Álbum X (Instrumental)")).toBe("albumxinstrumental");
    });

    it('keeps "Album X (Instrumental)" and "Album X (Instrumental Mix)" apart', () => {
        expect(albumIdentityKey("Album X (Instrumental)")).not.toBe(
            albumIdentityKey("Album X (Instrumental Mix)")
        );
        expect(albumIdentityKey("Album X (Instrumental Mix)")).toBe("albumxinstrumentalmix");
    });
});

describe("isGenericAlbumTitle — gates cross-artist matching", () => {
    it.each([
        "Greatest Hits",
        "greatest hits",
        "The Greatest Hits",
        "Best Of",
        "Unknown Album",
        "Unknown",
        "Untitled",
        "Live",
        "Singles",
        "( )",
        "",
    ])("%s is too generic to match across artists", (title) => {
        expect(isGenericAlbumTitle(title)).toBe(true);
    });

    it("does not treat generic titles with edition suffixes as generic", () => {
        // With the new policy, edition markers make a title specific.
        // "Greatest Hits" is generic; "Greatest Hits (Deluxe Edition)" is not.
        expect(isGenericAlbumTitle("Greatest Hits (Deluxe Edition)")).toBe(false);
        expect(isGenericAlbumTitle("The Best Of [Remastered]")).toBe(false);
    });

    it.each([
        "Abbey Road",
        "Leather Teeth",
        "Ágætis Byrjun",
        "4x4=12",
    ])("%s is specific enough", (title) => {
        expect(isGenericAlbumTitle(title)).toBe(false);
    });

    it("treats null as generic rather than throwing", () => {
        expect(isGenericAlbumTitle(null)).toBe(true);
    });
});

describe("resolveAlbum — sortName is written on creation", () => {
    // No displayTitle can exist yet on a row that does not exist yet, so this
    // is always the canonical title alone -- a later override keeps sortName
    // in sync itself (routes/enrichment.ts's PUT/reset handlers).
    function fakeDb(overrides: Partial<Record<"findUnique" | "findFirst" | "create", jest.Mock>> = {}) {
        return {
            album: {
                findUnique: overrides.findUnique ?? jest.fn().mockResolvedValue(null),
                findFirst: overrides.findFirst ?? jest.fn().mockResolvedValue(null),
                create: overrides.create ?? jest.fn().mockResolvedValue({ id: "new-album" }),
            },
        } as any;
    }

    it("computes sortName from the canonical title, article-stripped, on a fresh row", async () => {
        const create = jest.fn().mockResolvedValue({ id: "new-album" });
        const db = fakeDb({ create });

        await resolveAlbum(db, { artistId: "artist-1", title: "The Dark Side of the Moon" });

        expect(create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                title: "The Dark Side of the Moon",
                sortName: "dark side of the moon",
            }),
        }));
    });

    it("keeps sortName from the full title, identityKey reflects editions", async () => {
        const create = jest.fn().mockResolvedValue({ id: "new-album" });
        const db = fakeDb({ create });

        await resolveAlbum(db, { artistId: "artist-1", title: "Abbey Road (2019 Remaster)" });

        const call = create.mock.calls[0][0];
        expect(call.data.identityKey).toBe("abbeyroad2019remaster");
        expect(call.data.sortName).toBe("abbey road (2019 remaster)");
    });

    it("does not write sortName when an existing row is returned instead of created", async () => {
        const existing = { id: "existing-album", sortName: "already set" };
        const db = fakeDb({ findUnique: jest.fn().mockResolvedValue(existing) });
        const create = db.album.create;

        const result = await resolveAlbum(db, { artistId: "artist-1", title: "Anything" });

        expect(result).toBe(existing);
        expect(create).not.toHaveBeenCalled();
    });
});

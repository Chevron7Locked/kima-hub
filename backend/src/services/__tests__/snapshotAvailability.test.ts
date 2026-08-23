/**
 * "Do we actually have this album?"
 *
 * The answer marks downloads complete, which marks discovery picks ACQUIRED,
 * which is what retention later tries to delete. A false yes therefore ends
 * with the system confident it holds a record it never got — and it said yes
 * on a bare substring: asking for "Trust In Trance" while owning "Trance"
 * matched, because containment was tested in both directions.
 */

import { lidarrService } from "../lidarr";
import type { ReconciliationSnapshot } from "../lidarr";
import { albumIdentityKey } from "../albumIdentity";

const snapshotOf = (held: [artist: string, album: string][]): ReconciliationSnapshot => {
    const albumsByTitle = new Map<string, any>();
    const albumsByMbid = new Map<string, any>();
    held.forEach(([artist, album], i) => {
        const info = {
            id: i + 1,
            title: album,
            foreignAlbumId: `mbid-${i + 1}`,
            artistName: artist,
            hasFiles: true,
        };
        albumsByTitle.set(`${artist.toLowerCase().trim()}|${album.toLowerCase().trim()}`, info);
        albumsByMbid.set(`mbid-${i + 1}`, info);
    });
    return { queue: new Map(), albumsByMbid, albumsByTitle, fetchedAt: new Date() };
};

const available = (snap: ReconciliationSnapshot, artist: string, album: string) =>
    lidarrService.isAlbumAvailableInSnapshot(snap, undefined, artist, album);

describe("isAlbumAvailableInSnapshot", () => {
    it("matches the same album exactly", () => {
        const snap = snapshotOf([["Astral Projection", "Trust In Trance"]]);
        expect(available(snap, "Astral Projection", "Trust In Trance")).toBe(true);
    });

    it("still matches across an edition difference", () => {
        // The reason strategy 3 exists, and it has to keep working.
        const snap = snapshotOf([["Perturbator", "Dangerous Days (Deluxe Edition)"]]);
        expect(available(snap, "Perturbator", "Dangerous Days")).toBe(true);
    });

    it("does NOT match a different, shorter album by the same artist", () => {
        // The defect. "Trust In Trance" contains "Trance", so containment said
        // we held an album we had never downloaded.
        const snap = snapshotOf([["Astral Projection", "Trance"]]);
        expect(available(snap, "Astral Projection", "Trust In Trance")).toBe(false);
    });

    it("does NOT match a different, longer album by the same artist", () => {
        const snap = snapshotOf([["Pink Floyd", "The Dark Side of the Moon"]]);
        expect(available(snap, "Pink Floyd", "The Dark")).toBe(false);
    });

    it("does not match the same album title by a different artist", () => {
        const snap = snapshotOf([["Gost", "Behemoth"]]);
        expect(available(snap, "Perturbator", "Behemoth")).toBe(false);
    });

    it("matches by MBID without needing any title at all", () => {
        const snap = snapshotOf([["Skazi", "Total Anarchy"]]);
        expect(lidarrService.isAlbumAvailableInSnapshot(snap, "mbid-1")).toBe(true);
    });

    it("says no when the library holds nothing", () => {
        expect(available(snapshotOf([]), "Anyone", "Anything")).toBe(false);
    });
});

/**
 * The library and the download check ask DIFFERENT questions about the same two
 * titles, and must keep giving opposite answers.
 *
 *   library      -- "is this one row on the shelf?"        -> NO, editions are separate
 *   acquisition  -- "do we already hold this, so skip it?" -> YES, the deluxe counts
 *
 * They shared one key until 2026-08-23, when the library rule changed to keep
 * editions apart and silently flipped acquisition with it -- every album held
 * only as a deluxe/remaster started reading as "not owned" and got fetched
 * again. These tests fail if the two are ever re-coupled, in either direction.
 */
describe("library grouping and acquisition disagree on editions, on purpose", () => {
    const PLAIN = "Dangerous Days";
    const DELUXE = "Dangerous Days (Deluxe Edition)";

    it("the library keeps an edition apart from its original", () => {
        expect(albumIdentityKey(DELUXE)).not.toBe(albumIdentityKey(PLAIN));
    });

    it("acquisition treats that same pair as already held, in both directions", () => {
        expect(available(snapshotOf([["Perturbator", DELUXE]]), "Perturbator", PLAIN)).toBe(true);
        expect(available(snapshotOf([["Perturbator", PLAIN]]), "Perturbator", DELUXE)).toBe(true);
    });

    it.each([
        ["Abbey Road (2019 Remaster)", "Abbey Road"],
        ["Abbey Road [Remastered]", "Abbey Road"],
        ["Abbey Road - 2019 Remaster", "Abbey Road"],
        ["Playing the Angel (Deluxe)", "Playing the Angel"],
    ])("acquisition sees %s as covering %s", (held, wanted) => {
        expect(available(snapshotOf([["The Beatles", held]]), "The Beatles", wanted)).toBe(true);
    });

    it("edition tolerance still does not let a different album through", () => {
        // The substring defect, re-checked against the edition-stripped key:
        // stripping "(Deluxe)" must not widen matching back into containment.
        const snap = snapshotOf([["Astral Projection", "Trance (Deluxe Edition)"]]);
        expect(available(snap, "Astral Projection", "Trust In Trance")).toBe(false);
    });

    it("edition tolerance does not merge across artists", () => {
        const snap = snapshotOf([["Gost", DELUXE]]);
        expect(available(snap, "Perturbator", PLAIN)).toBe(false);
    });
});

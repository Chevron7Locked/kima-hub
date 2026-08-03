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

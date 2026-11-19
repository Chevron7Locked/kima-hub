/**
 * The one check every identification path uses: a source's recording is the
 * track only when title, version, artist and length agree. Cases are wrong matches
 * seen on a real library.
 */
import {
    LENGTH_TOLERANCE_SEC,
    artistsAgree,
    lengthsAgree,
    normalizeIsrc,
    pickRecording,
    recordingAgrees,
    versionOf,
} from "../recordingMatch";

const track = (title: string, artists: string[], durationSec: number | null) => ({ title, artists, durationSec });
const rec = (id: string, title: string, lengthSec: number | null, artists: string[], score?: number) => ({
    id, title, lengthMs: lengthSec == null ? null : lengthSec * 1000, artists, score,
});

describe("recording agreement", () => {
    it("rejects a different song that shares the ISRC (Paramore 'Daydreaming' vs 'Decode (live 2014)')", () => {
        expect(recordingAgrees(rec("x", "Decode", 262, ["Paramore"]), track("Daydreaming", ["Paramore"], 271))).toBe(false);
    });

    it("rejects another version of the same title by length (a 491 s dub vs the 222 s album cut)", () => {
        expect(recordingAgrees(
            rec("x", "John the Revelator", 222, ["Depeche Mode"]),
            track("John the Revelator (Tiefschwarz Dub)", ["Depeche Mode"], 491),
        )).toBe(false);
    });

    it("rejects a remix or live recording for a studio track even at the same length", () => {
        expect(versionOf("Song (Live)")).toBe("live");
        expect(recordingAgrees(rec("x", "Song (Live)", 200, ["A"]), track("Song", ["A"], 200))).toBe(false);
    });

    it("rejects a same-titled song by another artist ('Nero' vs 'Uomo nero')", () => {
        expect(recordingAgrees(rec("x", "Nero", 180, ["Two Fingerz", "J-Ax"]), track("Nero", ["Two Steps From Hell"], 180))).toBe(false);
    });

    it("accepts the track: same title, artist, and length within the tolerance", () => {
        expect(recordingAgrees(rec("x", "Strobe", 634, ["deadmau5"]), track("Strobe", ["Deadmau5"], 634 - LENGTH_TOLERANCE_SEC))).toBe(true);
    });

    it("accepts a duo credited as one name, and a performer credited on a classical recording", () => {
        expect(artistsAgree(["Hall & Oates"], ["Daryl Hall", "John Oates", "Hall & Oates"])).toBe(true);
        expect(artistsAgree(["The Beatles"], ["Beatles"])).toBe(true);
        expect(artistsAgree(["Philip Glass"], ["Philip Glass Ensemble"])).toBe(false);
    });

    it("treats an unknown length as no evidence either way", () => {
        expect(lengthsAgree(null, 200000)).toBeNull();
        expect(lengthsAgree(200, null)).toBeNull();
        expect(lengthsAgree(200, 206000)).toBe(false);
    });

    it("picks the agreeing candidate with a known length over the source's top-scored one", () => {
        const pick = pickRecording(
            [
                rec("wrong-song", "Decode", 218, ["A"], 100),
                rec("no-length", "Song", null, ["A"], 99),
                rec("right", "Song", 219, ["A"], 80),
            ],
            track("Song", ["A"], 218),
        );
        expect(pick?.id).toBe("right");
    });

    it("returns nothing when no candidate is the track", () => {
        expect(pickRecording([rec("x", "Other", 200, ["A"])], track("Song", ["A"], 200))).toBeNull();
    });
});

describe("ISRC form", () => {
    it("accepts the 12-character form with or without hyphens", () => {
        expect(normalizeIsrc("US-RC1-76-07839")).toBe("USRC17607839");
        expect(normalizeIsrc("gbaye0601498")).toBe("GBAYE0601498");
    });

    it("rejects text that is not an ISRC (the PMEDIA tags on the real library)", () => {
        expect(normalizeIsrc("PMEDIA")).toBeNull();
        expect(normalizeIsrc("P.M.E.D.I.A")).toBeNull();
        expect(normalizeIsrc(null)).toBeNull();
    });
});

/**
 * The bitRate a Subsonic listing gives for a song: the bitrate the scan stored, else (a song not read since the scan
 * began keeping it) an estimate from the codec. A lossless codec, by the one vocabulary (`utils/audioCodec.ts`) the
 * library sweep also uses to prefer a copy, never estimates as a lossy one.
 */
import { mapSong, type TrackRow } from "../mappers";
import { isLosslessCodec } from "../../../utils/audioCodec";

const album = { id: "alb", title: "Album", displayTitle: null, year: null };
const bitRate = (mime: string | null, bitrate: number | null = null) => {
    const track: TrackRow = { id: "t", title: "T", displayTitle: null, trackNo: 1, discNumber: null, duration: 200, filePath: "/m/t", mime, bitrate, fileSize: 1 };
    return mapSong(track, album, "Artist", "art")["@_bitRate"];
};

describe("a song's bitRate", () => {
    it("is the stored bitrate when the scan read one, whatever the codec would estimate", () => {
        expect(bitRate("FLAC", 1011)).toBe(1011);
        expect(bitRate("MPEG 1 Layer 3", 320)).toBe(320);
        expect(bitRate("AAC", 96)).toBe(96);
    });

    it("falls back to the codec's estimate only when none is stored", () => {
        expect(bitRate("FLAC", null)).toBe(900);
        expect(bitRate("MPEG 1 Layer 3", null)).toBe(192);
    });
});

describe("a song's estimated bitRate", () => {
    it.each([
        ["FLAC", 900],
        ["ALAC", 900],
        ["PCM", 900],
        ["WavPack", 900],
        ["Monkey's Audio", 900],
        ["audio/flac", 900],
        ["WAV", 1400],
        ["audio/x-wav", 1400],
        ["audio/wave", 1400],
        ["audio/vnd.wave", 1400],
        ["wavpack", 900],
    ])("%s, lossless, is %i", (mime, expected) => expect(bitRate(mime)).toBe(expected));

    it.each([
        ["MPEG 1 Layer 3", 192],
        ["AAC", 256],
        ["Opus", 128],
        [null, 192],
    ])("%s is %i", (mime, expected) => expect(bitRate(mime)).toBe(expected));

    it("calls lossless exactly what the library sweep calls lossless: nothing lossless is estimated as a lossy codec's rate", () => {
        for (const codec of ["FLAC", "ALAC", "PCM", "WavPack", "TTA", "DSD", "WAV", "AIFF"]) {
            expect(isLosslessCodec(codec)).toBe(true);
            expect(bitRate(codec)).toBeGreaterThanOrEqual(900);
        }
        for (const codec of ["MPEG 1 Layer 3", "AAC", "Opus", "Vorbis"]) {
            expect(isLosslessCodec(codec)).toBe(false);
            expect(bitRate(codec)).toBeLessThan(900);
        }
    });
});

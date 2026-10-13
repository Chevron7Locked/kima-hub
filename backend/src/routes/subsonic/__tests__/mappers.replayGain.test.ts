/**
 * mapSong's replayGain follows the OpenSubsonic extension: the object is
 * always present on a song child, trackGain appears only when a trustworthy
 * integrated-loudness measurement exists, and the gain levels a track to the
 * ReplayGain 2 reference (−18 LUFS), attenuation only.
 */

import { mapSong, trackGainDb, isValidLoudness } from "../mappers";

const ALBUM = { id: "al1", title: "Album", displayTitle: null, year: 2020 };

function song(loudness?: number | null) {
    return mapSong(
        {
            id: "t1",
            title: "Song",
            trackNo: 1,
            discNumber: null,
            duration: 100,
            filePath: "/x.flac",
            mime: "FLAC",
            fileSize: 1000,
            loudness,
        },
        ALBUM,
        "Artist",
        "ar1"
    ) as Record<string, any>;
}

describe("trackGainDb", () => {
    it("levels a loud master down to the -18 reference", () => {
        expect(trackGainDb(-9.1)).toBe(-8.9);
    });

    it("gives a reference-loudness track no gain", () => {
        expect(trackGainDb(-18)).toBe(0);
    });

    it("never boosts: quieter-than-reference tracks stay at their level", () => {
        expect(trackGainDb(-24)).toBe(6);
    });

    it.each([null, undefined, 2868.6, -61, 0.5, NaN])(
        "treats %p as unmeasured",
        (value) => {
            expect(trackGainDb(value as number | null)).toBeNull();
            expect(isValidLoudness(value)).toBe(false);
        }
    );
});

describe("mapSong replayGain", () => {
    it("always carries the replayGain object, trackGain only when measured", () => {
        expect(song(-9.1).replayGain).toEqual({ trackGain: -8.9 });
        expect(song(null).replayGain).toEqual({});
        expect(song(2868.6).replayGain).toEqual({});
    });
});

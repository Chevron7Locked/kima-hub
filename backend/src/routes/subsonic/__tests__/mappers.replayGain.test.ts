/**
 * mapSong's replayGain follows the OpenSubsonic extension: the object is
 * always present on a song child, trackGain appears only when a trustworthy
 * integrated-loudness measurement exists, and the gain levels a track to the
 * ReplayGain 2 reference (−18 LUFS). trackGainDb is signed — native clients
 * apply it with peak protection, so a quiet track gets a positive gain; the
 * web player clamps to attenuation on its own (lib/loudness.ts).
 */

import { mapSong, mapQueueEntry, trackGainDb, isValidLoudness } from "../mappers";

const ALBUM = { id: "al1", title: "Album", displayTitle: null, year: 2020 };

function song(loudness?: number | null, trackPeak?: number | null) {
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
            trackPeak,
        } as Parameters<typeof mapSong>[0],
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

    it("gives a quiet track a positive gain for native clients", () => {
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

describe("mapSong trackPeak", () => {
    it("emits trackPeak as positive linear full-scale beside trackGain", () => {
        expect(song(-14, 0.891253).replayGain).toEqual({ trackGain: -4, trackPeak: 0.891253 });
    });

    it("omits trackPeak when unmeasured", () => {
        expect(song(-14, null).replayGain).toEqual({ trackGain: -4 });
    });

    // OpenSubsonic extension 28: trackPeak "Must be positive". A zero or
    // negative reading is no peak at all and is left off.
    it("omits trackPeak when the reading is not positive", () => {
        expect(song(-14, 0).replayGain).toEqual({ trackGain: -4 });
        expect(song(-14, -0.5).replayGain).toEqual({ trackGain: -4 });
    });
});

describe("mapSong replayGain", () => {
    it("always carries the replayGain object, trackGain only when measured", () => {
        expect(song(-9.1).replayGain).toEqual({ trackGain: -8.9 });
        expect(song(null).replayGain).toEqual({});
        expect(song(2868.6).replayGain).toEqual({});
    });
});

describe("mapQueueEntry replayGain", () => {
    function queueEntry(loudness?: number | null, trackPeak?: number | null) {
        return mapQueueEntry({
            id: "t1",
            title: "Song",
            loudness,
            trackPeak,
        } as Parameters<typeof mapQueueEntry>[0]) as Record<string, any>;
    }

    // The play queue is a song child too; it must obey the exact same gain
    // contract as mapSong (it used to be hand-rolled in queue.ts and dropped it).
    it("carries replayGain on every playQueue entry, trackGain only when measured", () => {
        expect(queueEntry(-9.1).replayGain).toEqual({ trackGain: -8.9 });
        expect(queueEntry(-24).replayGain).toEqual({ trackGain: 6 });
        expect(queueEntry(null).replayGain).toEqual({});
        expect(queueEntry(undefined).replayGain).toEqual({});
        expect(queueEntry(2868.6).replayGain).toEqual({});
    });

    it("agrees with mapSong for the same loudness", () => {
        expect(queueEntry(-9.1).replayGain).toEqual(song(-9.1).replayGain);
    });

    it("carries trackPeak under the same contract as mapSong", () => {
        expect(queueEntry(-14, 0.891253).replayGain).toEqual({ trackGain: -4, trackPeak: 0.891253 });
        expect(queueEntry(-14, null).replayGain).toEqual({ trackGain: -4 });
        expect(queueEntry(-14).replayGain).toEqual({ trackGain: -4 });
        expect(queueEntry(-14, 0.891253).replayGain).toEqual(song(-14, 0.891253).replayGain);
    });
});

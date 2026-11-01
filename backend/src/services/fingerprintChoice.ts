/**
 * Which fingerprints a song is asked about at AcoustID, in order. One choice shared by identification, the
 * prefetch and the album vote, so a reply saved for one answers the others.
 */
import type { IdentityTags } from "./acoustidIdentification";

export type FingerprintQuestion = {
    fingerprint: string;
    duration: number;
    from: "tag_fingerprint" | "stored_fingerprint";
};

/**
 * The file's fingerprint tag first, then the stored (`Track.acoustidFingerprint`) one when it is a different
 * string: a wrong tag must not blind the song, so the stored fingerprint is the second ask (at most one extra).
 * The length comes from the tags read (unreadable tags: the track's own). A length that rounds to 0 seconds is
 * never asked (AcoustID refuses it), so such a song has no questions.
 */
export function fingerprintsToAsk(
    tags: IdentityTags | null | undefined,
    storedFingerprint: string | null | undefined,
    trackDuration: number,
): FingerprintQuestion[] {
    const duration = tags ? tags.duration : trackDuration;
    if (!Number.isFinite(duration) || Math.round(duration) < 1) return [];
    const out: FingerprintQuestion[] = [];
    if (tags?.fingerprint) out.push({ fingerprint: tags.fingerprint, duration, from: "tag_fingerprint" });
    if (storedFingerprint && storedFingerprint !== tags?.fingerprint) {
        out.push({ fingerprint: storedFingerprint, duration, from: "stored_fingerprint" });
    }
    return out;
}

/** The first question: what the song is asked about before any fallback. Null when there is none. */
export function fingerprintToAsk(
    tags: IdentityTags | null | undefined,
    storedFingerprint: string | null | undefined,
    trackDuration: number,
): FingerprintQuestion | null {
    return fingerprintsToAsk(tags, storedFingerprint, trackDuration)[0] ?? null;
}

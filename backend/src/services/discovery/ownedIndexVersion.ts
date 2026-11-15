/**
 * Whether the owned-album snapshot behind Discover's ownership checks (discoverySeeding) is still current. It is cached for
 * minutes, so whatever writes an artist's MusicBrainz id, moves an album into or out of the library, or changes which
 * albums are owned calls `forgetOwnedIndex`, and the next check rebuilds it. A leaf module, so a writer anywhere can import
 * it without pulling in Discover.
 */
let version = 0;

/** The snapshot's version: a snapshot read under an older one predates a write and is not used. */
export const ownedIndexVersion = (): number => version;

/** Call after a write that the owned-album snapshot reads (see above), once it is committed. */
export const forgetOwnedIndex = (): void => {
    version++;
};

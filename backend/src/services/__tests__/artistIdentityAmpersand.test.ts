/**
 * artistIdentityKey and the SQL backfill must produce the SAME key.
 *
 * identityKey is UNIQUE on Artist and is how resolveArtist finds an existing
 * artist instead of inserting a duplicate. It is written from two places: this
 * TypeScript at runtime, and the artist_identity migration's SQL backfill.
 *
 * They disagreed. The TypeScript replaces "&" with " and " before stripping
 * non-alphanumerics; the migration stripped the ampersand instead. So the
 * migration wrote "simongarfunkel" while the app looked up
 * "simonandgarfunkel", missed, and would have inserted a second row -- the
 * duplicate this whole mechanism exists to prevent, for every band with an
 * ampersand in its name.
 *
 * The expectations below are the values the FIXED migration produces, verified
 * by running its own UPDATE statement against Postgres 16 and diffing the rows
 * against this function. Changing either side without the other reopens the
 * bug, so this test is the tripwire for the TypeScript half.
 */

import { artistIdentityKey } from "../artistIdentity";

describe("artistIdentityKey agrees with the migration backfill", () => {
    it.each([
        ["AC&DC", "acanddc"],
        ["Simon & Garfunkel", "simonandgarfunkel"],
        ["Earth, Wind & Fire", "earthwindandfire"],
        ["Hall & Oates", "hallandoates"],
    ])("folds the ampersand in %s", (name, expected) => {
        expect(artistIdentityKey(name)).toBe(expected);
    });

    it.each([
        ["Björk", "bjork"],
        ["MØ", "mo"],
        ["Kælan Mikla", "kaelanmikla"],
        ["東京事変", "東京事変"],
        ["deadmau5", "deadmau5"],
    ])("matches unaccent() on %s", (name, expected) => {
        expect(artistIdentityKey(name)).toBe(expected);
    });
});

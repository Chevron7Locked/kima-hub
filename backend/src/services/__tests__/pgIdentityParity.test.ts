/**
 * TS/SQL identity parity.
 *
 * Identity keys are computed in two places: here at scan time, and in SQL by the
 * migration backfills. If the two disagree by a single character the backfilled
 * key is unreachable from the runtime, and the next scan re-creates the
 * duplicate the whole identity mechanism exists to prevent -- silently.
 *
 * That has happened three times. A hand-written 20-entry "characters unaccent
 * folds" table missed 857 of 2624 sampled codepoints; the two sides lowercased
 * in opposite order, so `unaccent` expansions that are uppercase ("(C)") kept
 * their case on one side only; and JS `\s` matches four characters Postgres `\s`
 * does not, so a name containing a no-break space normalised differently.
 *
 * The expectations below are GENERATED OUTPUT from the `kima_*` SQL functions
 * running in the shipped Postgres image -- they are what the database actually
 * produces, not what anyone believes it produces. Regenerate with
 * `npm run gen:pg-text-rules` after changing those functions, and only then.
 *
 * A failure here means the runtime and the backfill have diverged. Do not
 * "fix" it by editing the fixture.
 */

import { artistIdentityKey, artistSortName, normalizeArtistName } from "../artistIdentity";
import { albumIdentityKey } from "../albumIdentity";
import golden from "./fixtures/pgIdentityGolden.json";

type Row = {
    in: string;
    identityKey: string;
    normalizedName: string;
    sortName: string;
    albumIdentityKey: string;
};

const rows = golden as Row[];

/** U+XXXX form, so a diff on invisible characters is readable. */
function describeInput(value: string): string {
    if (value === "") return "(empty)";
    return [...value]
        .map((ch) => {
            const cp = ch.codePointAt(0)!;
            return cp < 0x20 || cp === 0x7f || (cp >= 0x80 && !/[\p{L}\p{N}]/u.test(ch))
                ? `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`
                : ch;
        })
        .join("");
}

describe("identity keys match the SQL the migrations run", () => {
    it("has a non-trivial corpus", () => {
        expect(rows.length).toBeGreaterThan(300);
    });

    const check = (
        label: keyof Omit<Row, "in">,
        fn: (v: string) => string
    ) => {
        it(`${label} agrees with Postgres on all ${rows.length} inputs`, () => {
            const mismatches = rows
                .filter((r) => fn(r.in) !== r[label])
                .map((r) => `${describeInput(r.in)}: ts=${JSON.stringify(fn(r.in))} sql=${JSON.stringify(r[label])}`);
            expect(mismatches).toEqual([]);
        });
    };

    check("identityKey", artistIdentityKey);
    check("normalizedName", normalizeArtistName);
    check("sortName", artistSortName);
    check("albumIdentityKey", albumIdentityKey);
});

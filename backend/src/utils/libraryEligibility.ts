/**
 * The one library-eligibility predicate.
 *
 * A file missing from disk is flagged `missingSince`, never offered to a
 * stage, and never streamed — so it must not appear in any recommendation,
 * ranking, projection, search answer, or mix. Streaming already refuses these
 * tracks; every read path must agree with what it refuses. The flag clears
 * when the file returns, and the track comes back to every consumer with no
 * extra work. Deleting flagged rows is the reconcile step's job, never this
 * predicate's.
 *
 * Status counters are the deliberate exception: they count the whole
 * library, missing files included, and show the count (invariant 3 —
 * counted and shown, never silent).
 *
 * In raw SQL the same rule is the literal fragment
 * `<track alias>."missingSince" IS NULL`, inline in the query — enforced
 * by the grep gate in `libraryEligibility.integration.test.ts`.
 */

/** For Prisma `where` clauses on Track. */
export const NOT_MISSING = { missingSince: null } as const;

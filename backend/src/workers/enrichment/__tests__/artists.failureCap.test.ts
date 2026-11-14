/**
 * An artist whose enrichment keeps failing stops being asked: each failure counts, and at the
 * stage retry cap the artist is closed as unresolvable rather than retried every cycle.
 */
import { failedArtistStatus } from "../artists";
import { STAGE_RETRY_CAP } from "../../stageRetry";

describe("an artist's failures are counted and capped", () => {
    it("counts each failure and stays retryable below the cap", () => {
        expect(failedArtistStatus(0)).toEqual({ enrichmentStatus: "failed", enrichmentFailures: 1 });
        expect(failedArtistStatus(STAGE_RETRY_CAP - 2)).toEqual({
            enrichmentStatus: "failed",
            enrichmentFailures: STAGE_RETRY_CAP - 1,
        });
    });

    it("closes the artist as unresolvable on the failure that reaches the cap", () => {
        expect(failedArtistStatus(STAGE_RETRY_CAP - 1)).toEqual({
            enrichmentStatus: "unresolvable",
            enrichmentFailures: STAGE_RETRY_CAP,
        });
    });
});

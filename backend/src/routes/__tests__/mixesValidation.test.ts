import {
    validateSaveTrackIds,
    MOOD_MIX_LIMIT,
} from "../mixesValidation";

describe("validateSaveTrackIds (mood-mix save route validation)", () => {
    it("undefined body -> regenerate (trackIds undefined, no error)", () => {
        const r = validateSaveTrackIds(undefined);
        expect(r).toEqual({ trackIds: undefined });
    });

    it("a non-array -> 400 message", () => {
        expect(validateSaveTrackIds("not-an-array")).toEqual({
            error: "trackIds must be an array",
        });
        expect(validateSaveTrackIds(42)).toEqual({
            error: "trackIds must be an array",
        });
    });

    it("a non-string element -> 400 message", () => {
        expect(validateSaveTrackIds(["a", 2, "c"])).toEqual({
            error: "Each trackId must be a string",
        });
    });

    it("more than the limit -> 400 message", () => {
        const tooMany = Array.from({ length: MOOD_MIX_LIMIT + 1 }, (_, i) => `t${i}`);
        expect(validateSaveTrackIds(tooMany)).toEqual({
            error: `trackIds must not exceed ${MOOD_MIX_LIMIT} tracks`,
        });
    });

    it("a valid array (<= limit) -> passes it through", () => {
        const ids = ["t1", "t2", "t3"];
        expect(validateSaveTrackIds(ids)).toEqual({ trackIds: ids });
    });

    it("exactly the limit -> valid", () => {
        const ids = Array.from({ length: MOOD_MIX_LIMIT }, (_, i) => `t${i}`);
        expect(validateSaveTrackIds(ids)).toEqual({ trackIds: ids });
    });

    it("empty array -> valid (empty, not undefined)", () => {
        expect(validateSaveTrackIds([])).toEqual({ trackIds: [] });
    });
});

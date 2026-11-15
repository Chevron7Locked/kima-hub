// The recount's progress line is due once each time the count passes a multiple of 500, and never while nothing has
// been counted (a batch whose artists all failed leaves the count at 0, which is a multiple of 500 but no progress).
import { crossedProgressMark } from "../artistCountsService";

describe("when the recount logs its progress", () => {
    it("does not while nothing has been counted", () => {
        expect(crossedProgressMark(0, 0)).toBe(false);
        expect(crossedProgressMark(300, 300)).toBe(false);
    });

    it("does not between marks", () => {
        expect(crossedProgressMark(0, 100)).toBe(false);
        expect(crossedProgressMark(400, 499)).toBe(false);
        expect(crossedProgressMark(501, 999)).toBe(false);
    });

    it("does once when a batch lands on or passes a mark, even if failures kept it off the exact multiple", () => {
        expect(crossedProgressMark(400, 500)).toBe(true);
        expect(crossedProgressMark(450, 520)).toBe(true);
        expect(crossedProgressMark(500, 600)).toBe(false);
    });

    it("does once for a batch that passes more than one mark", () => {
        expect(crossedProgressMark(450, 1050)).toBe(true);
    });
});

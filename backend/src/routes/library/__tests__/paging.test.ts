// The one page-size parser every route uses: the route's default when the value is absent or not a number, never under
// 1 (a negative size would make Prisma read from the end of the set), never over the route's cap (10000 by default).
import { parseLimit, parseOffset } from "../paging";

describe("parseLimit", () => {
    it("falls back to the route's default when the value is missing or not a number", () => {
        for (const raw of [undefined, "", "abc", "0"]) expect([raw, parseLimit(raw, 50)]).toEqual([raw, 50]);
    });

    it("never goes under 1, so a negative size cannot read from the end", () => {
        expect(parseLimit("-5", 50, 100)).toBe(1);
        expect(parseLimit("-5", 50)).toBe(1);
    });

    it("never goes over the route's cap, or 10000 when it sets none", () => {
        expect(parseLimit("150", 50, 100)).toBe(100);
        expect(parseLimit("99999", 20)).toBe(10000);
        expect(parseLimit("75", 50, 100)).toBe(75);
    });
});

describe("parseOffset", () => {
    it("is 0 when missing, not a number or negative", () => {
        for (const raw of [undefined, "x", "-3"]) expect([raw, parseOffset(raw)]).toEqual([raw, 0]);
        expect(parseOffset("40")).toBe(40);
    });
});

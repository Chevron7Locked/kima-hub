/**
 * The proxy routes copy headers off an axios response onto their own response.
 * axios and Node disagree about what a header value can be, and the gap is not
 * theoretical: axios represents a valueless header as boolean `true`, which
 * Node rejects at runtime with ERR_INVALID_HTTP_TOKEN rather than at compile
 * time. These tests pin every shape that can come out of axios.
 */

import { upstreamHeader, upstreamHeaderNumber } from "../upstreamHeaders";

describe("upstreamHeader", () => {
    it("passes a plain string through untouched", () => {
        expect(upstreamHeader("audio/mpeg")).toBe("audio/mpeg");
    });

    it("passes a number through untouched", () => {
        expect(upstreamHeader(4096)).toBe(4096);
    });

    it("reports a missing header as undefined, so `if (value)` still works", () => {
        expect(upstreamHeader(undefined)).toBeUndefined();
        expect(upstreamHeader(null)).toBeUndefined();
    });

    it("turns a valueless header into an empty string rather than dropping it", () => {
        // axios gives `true` for a header sent with no value. Node throws on
        // `true`, but the header WAS sent, so empty string is the honest
        // translation -- that is how Node represents a valueless header.
        expect(upstreamHeader(true)).toBe("");
    });

    it("stringifies every element of a repeated header", () => {
        expect(upstreamHeader(["bytes", "none"])).toEqual(["bytes", "none"]);
        expect(upstreamHeader([1, 2])).toEqual(["1", "2"]);
    });

    it("stringifies an exotic value instead of letting it reach Node", () => {
        // An AxiosHeaders instance, or anything else with a toString. The point
        // is that a malformed upstream header cannot kill the response.
        expect(upstreamHeader({ toString: () => "x-weird" })).toBe("x-weird");
    });
});

describe("upstreamHeaderNumber", () => {
    it("parses a numeric string", () => {
        expect(upstreamHeaderNumber("4096")).toBe(4096);
    });

    it("passes a real number through", () => {
        expect(upstreamHeaderNumber(4096)).toBe(4096);
    });

    it("returns 0 for anything that is not a usable size", () => {
        // Callers test `> 0` for 'the upstream told us a real length', so every
        // unusable shape has to collapse to the same falsy answer -- and never
        // to NaN, which would survive a `> 0` check only by accident.
        expect(upstreamHeaderNumber(undefined)).toBe(0);
        expect(upstreamHeaderNumber(null)).toBe(0);
        expect(upstreamHeaderNumber("")).toBe(0);
        expect(upstreamHeaderNumber("not-a-number")).toBe(0);
        expect(upstreamHeaderNumber("-1")).toBe(0);
        expect(upstreamHeaderNumber("0")).toBe(0);
        expect(upstreamHeaderNumber(true)).toBe(0);
    });

    it("takes the first entry of a repeated header", () => {
        expect(upstreamHeaderNumber(["4096", "8192"])).toBe(4096);
    });
});

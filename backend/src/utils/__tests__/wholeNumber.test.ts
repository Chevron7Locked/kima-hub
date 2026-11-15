import { plainNumber, wholeNumber } from "../wholeNumber";

describe("wholeNumber", () => {
    it.each([
        [7, 7],
        ["7", 7],
        [" 7 ", 7],
        ["0", 0],
        ["-3", -3],
    ])("reads %p as %p", (raw, expected) => {
        expect(wholeNumber(raw)).toBe(expected);
    });

    it.each([["7abc"], [""], ["   "], ["1.5"], [10.5], [null], [undefined], [true], [[]], ["1e3"], ["0x10"], [NaN], [Infinity], ["99999999999999999999"], [2 ** 60]])(
        "does not read %p",
        (raw) => {
            expect(Number.isNaN(wholeNumber(raw))).toBe(true);
        },
    );
});

describe("plainNumber", () => {
    it.each([
        [1.5, 1.5],
        ["1.5", 1.5],
        ["2", 2],
        [" 1.25 ", 1.25],
    ])("reads %p as %p", (raw, expected) => {
        expect(plainNumber(raw)).toBe(expected);
    });

    it.each([["1.5x"], [""], ["."], ["1e3"], [null], [undefined], [NaN], [Infinity], ["Infinity"]])("does not read %p", (raw) => {
        expect(Number.isNaN(plainNumber(raw))).toBe(true);
    });
});

import { cleanDeviceName } from "../apiKeyStore";

describe("cleanDeviceName", () => {
    it("trims, and keeps at most 100 characters", () => {
        expect(cleanDeviceName("  kitchen tablet  ")).toBe("kitchen tablet");
        expect(cleanDeviceName("d".repeat(150))).toBe("d".repeat(100));
    });

    it("does not end on a space when the cut lands after one", () => {
        expect(cleanDeviceName(`${"d".repeat(99)}   tail`)).toBe("d".repeat(99));
    });

    it.each([[""], ["   "], [undefined], [null], [5], [{}]])("names %p a mobile device", (raw) => {
        expect(cleanDeviceName(raw)).toBe("Mobile Device");
    });
});

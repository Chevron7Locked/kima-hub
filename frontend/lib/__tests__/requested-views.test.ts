import { describe, expect, it } from "vitest";
import { stillRequested, viewToChange } from "@/lib/requested-views";

type View = { sort: string; perPage: number };
const same = (a: View, b: View) => a.sort === b.sort && a.perPage === b.perPage;
const shown: View = { sort: "name", perPage: 40 };

describe("requested views", () => {
    it("builds a change on the last one asked for while it has not rendered", () => {
        expect(viewToChange([], shown)).toBe(shown);
        const first = { sort: "name-desc", perPage: 40 };
        const second = { ...viewToChange([first], shown), perPage: 80 };
        expect(second).toEqual({ sort: "name-desc", perPage: 80 });
    });

    it("keeps the later changes when an earlier one renders, so none is lost", () => {
        const a = { sort: "name-desc", perPage: 40 };
        const b = { sort: "name-desc", perPage: 80 };
        const c = { sort: "recent", perPage: 80 };
        // a renders while b and c are on their way; the next change still builds on c.
        const left = stillRequested([a, b, c], a, same);
        expect(left).toEqual([b, c]);
        expect(viewToChange(left, a)).toBe(c);
        expect(stillRequested(left, c, same)).toEqual([]);
    });

    it("forgets the changes asked for when the address moves somewhere else", () => {
        const a = { sort: "name-desc", perPage: 40 };
        expect(stillRequested([a], { sort: "name", perPage: 24 }, same)).toEqual([]);
    });
});

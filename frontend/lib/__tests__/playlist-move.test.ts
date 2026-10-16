import { it, expect } from "vitest";
import { anchorForScreenMove, movePlaylistItem } from "@/hooks/useQueries";

// The page sends moves in stored order (afterItemId, null for the top); a reversed playlist arrives in display
// order. The instant update must show what the server will store, in the order the page shows it.
const list = (ids: string[], reverseOrder = false) => ({ reverseOrder, items: ids.map((id) => ({ id })) });
const ids = (p: ReturnType<typeof list> | undefined) => (p!.items as Array<{ id: string }>).map((i) => i.id);

it("moves an item after another in a normal playlist", () => {
    expect(ids(movePlaylistItem(list(["A", "B", "C"]), "C", "A"))).toEqual(["A", "C", "B"]);
    expect(ids(movePlaylistItem(list(["A", "B", "C"]), "C", null))).toEqual(["C", "A", "B"]);
});

it("moves 'up' on screen in a reversed playlist, as the page asks", () => {
    // Shown A,B,C (stored C,B,A). Up on C: the page sends afterItemId = B; stored becomes B,C,A, shown A,C,B.
    expect(ids(movePlaylistItem(list(["A", "B", "C"], true), "C", "B"))).toEqual(["A", "C", "B"]);
});

it("moves to the bottom of the screen in a reversed playlist without flashing to the top", () => {
    // Shown A,B,C (stored C,B,A). Down on B to the end: afterItemId = null puts it first in stored order: B,C,A.
    expect(ids(movePlaylistItem(list(["A", "B", "C"], true), "B", null))).toEqual(["A", "C", "B"]);
});

it("moves the merged list the page draws too, after the anchor and ahead of a song still downloading", () => {
    // Stored: A, B, (P pending), C. Move C after A: the server ranks it between A and the next entry, B.
    const before = {
        reverseOrder: false,
        items: ["A", "B", "C"].map((id) => ({ id })),
        mergedItems: ["A", "B", "P", "C"].map((id) => ({ id })),
    };
    const after = movePlaylistItem(before, "C", "A");
    expect((after.mergedItems as Array<{ id: string }>).map((i) => i.id)).toEqual(["A", "C", "B", "P"]);
    // Reversed, shown C, P, B, A (stored A, B, P, C): B after P stores A, P, B, C, shown C, B, P, A.
    const reversed = { ...before, reverseOrder: true, items: ["C", "B", "A"].map((id) => ({ id })), mergedItems: ["C", "P", "B", "A"].map((id) => ({ id })) };
    const moved = movePlaylistItem(reversed, "B", "P");
    expect((moved.mergedItems as Array<{ id: string }>).map((i) => i.id)).toEqual(["C", "B", "P", "A"]);
    expect(ids(moved as ReturnType<typeof list>)).toEqual(["C", "B", "A"]);
});

it("leaves the cached list itself untouched", () => {
    const before = list(["A", "B", "C"], true);
    movePlaylistItem(before, "C", "B");
    expect(ids(before)).toEqual(["A", "B", "C"]);
});

it("every screen move, normal or reversed, lands where the screen put it", () => {
    // For every list of up to five songs, every song, and every place on screen (after each other song, or the top):
    // the stored move the page sends, applied the way the server stores it, shows the song exactly there.
    for (let n = 2; n <= 5; n++) {
        const shown = Array.from({ length: n }, (_, i) => String.fromCharCode(65 + i));
        for (const reversed of [false, true]) {
            for (const item of shown) {
                for (const after of [null, ...shown.filter((id) => id !== item)]) {
                    const expected = shown.filter((id) => id !== item);
                    expected.splice(after === null ? 0 : expected.indexOf(after) + 1, 0, item);
                    const anchor = anchorForScreenMove(shown, item, after, reversed);
                    expect(ids(movePlaylistItem(list(shown, reversed), item, anchor)), `${reversed ? "reversed" : "normal"} ${shown.join("")}: ${item} after ${after}`).toEqual(expected);
                }
            }
        }
    }
});

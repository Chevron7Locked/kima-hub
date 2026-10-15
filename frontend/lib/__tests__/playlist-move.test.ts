import { it, expect } from "vitest";
import { movePlaylistItem } from "@/hooks/useQueries";

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

it("leaves the cached list itself untouched", () => {
    const before = list(["A", "B", "C"], true);
    movePlaylistItem(before, "C", "B");
    expect(ids(before)).toEqual(["A", "B", "C"]);
});

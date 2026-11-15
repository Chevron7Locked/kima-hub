// The add-to-playlist dialog's guards: the name box's Enter follows the create button's rule, the form starts fresh
// when the dialog reopens, nothing closes the dialog while an add or create is in flight, and a retry into the
// playlist this dialog just made does not ask about songs its own first try added.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";

const getPlaylists = vi.fn();
const getPlaylist = vi.fn();
const mutateAsync = vi.fn();
const createPlaylist = vi.fn();
vi.mock("@/lib/api", () => ({
    api: {
        getPlaylists: (...a: unknown[]) => getPlaylists(...a),
        getPlaylist: (...a: unknown[]) => getPlaylist(...a),
        createPlaylist: (...a: unknown[]) => createPlaylist(...a),
    },
}));
vi.mock("@/hooks/useQueries", () => ({ useAddToPlaylistMutation: () => ({ mutateAsync }) }));

import { PlaylistSelector } from "@/components/ui/PlaylistSelector";

let root: Root | null = null;
afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = "";
});

const onClose = vi.fn();
const onAdded = vi.fn();
const text = () => document.body.textContent ?? "";
const button = (label: string) =>
    Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim().startsWith(label)) as HTMLButtonElement | undefined;
const click = async (label: string) => {
    const b = button(label);
    if (!b) throw new Error(`no button "${label}" in: ${text()}`);
    await act(async () => b.click());
};
const nameBox = () => document.querySelector("input[type=text]") as HTMLInputElement;
const typeName = async (name: string) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
        set.call(nameBox(), name);
        nameBox().dispatchEvent(new Event("input", { bubbles: true }));
    });
};
const enter = () => nameBox().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
const escape = () =>
    act(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
const held = (...ids: string[]) => ({ id: "pl-1", items: ids.map((id, i) => ({ id: `item-${i}`, trackId: id, track: { id } })) });
const render = async (trackIds: string[], isOpen = true) => {
    if (!root) root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () =>
        root!.render(<PlaylistSelector isOpen={isOpen} onClose={onClose} onAdded={onAdded} trackIds={trackIds} />),
    );
};

beforeEach(() => {
    vi.clearAllMocks();
    getPlaylists.mockResolvedValue([{ id: "pl-1", name: "road trip", trackCount: 2 }]);
    mutateAsync.mockResolvedValue({ added: 1, duplicates: 0, rejected: [] });
});

describe("the new-playlist name box", () => {
    it("Enter on an empty name makes nothing", async () => {
        await render(["a"]);
        await act(async () => enter());
        await typeName("   ");
        await act(async () => enter());
        expect(createPlaylist).not.toHaveBeenCalled();
    });

    it("a double Enter makes one playlist", async () => {
        let resolve!: (p: { id: string; name: string }) => void;
        createPlaylist.mockReturnValue(new Promise((r) => (resolve = r)));
        await render(["a"]);
        await typeName("late night");
        await act(async () => {
            enter();
            enter();
        });
        expect(createPlaylist).toHaveBeenCalledTimes(1);
        await act(async () => resolve({ id: "new-1", name: "late night" }));
        expect(mutateAsync).toHaveBeenCalledTimes(1);
    });

    it("does not make a playlist while an add to another one is in flight", async () => {
        getPlaylist.mockResolvedValue(held("z"));
        mutateAsync.mockReturnValue(new Promise(() => {}));
        await render(["a"]);
        await click("road trip");
        await typeName("late night");
        await act(async () => enter());
        expect(createPlaylist).not.toHaveBeenCalled();
    });

    it("starts empty and private again when the dialog reopens", async () => {
        await render(["a"]);
        await typeName("half typed");
        await act(async () => (document.querySelector("input[type=checkbox]") as HTMLInputElement).click());
        expect((document.querySelector("input[type=checkbox]") as HTMLInputElement).checked).toBe(true);
        await render(["a"], false);
        await render(["a"], true);
        expect(nameBox().value).toBe("");
        expect((document.querySelector("input[type=checkbox]") as HTMLInputElement).checked).toBe(false);
    });
});

describe("closing while an add is in flight", () => {
    let finish!: (r: { added: number; rejected: string[] }) => void;
    const pendingAdd = async () => {
        getPlaylist.mockResolvedValue(held("z"));
        mutateAsync.mockReturnValue(new Promise((r) => (finish = r)));
        await render(["a"]);
        await click("road trip");
    };

    it("Escape does not close, and the result closes it once", async () => {
        await pendingAdd();
        await escape();
        expect(onClose).not.toHaveBeenCalled();
        await act(async () => finish({ added: 1, rejected: [] }));
        expect(onAdded).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("a backdrop click does not close", async () => {
        await pendingAdd();
        const backdrop = document.querySelector('[role="dialog"]')!.parentElement as HTMLElement;
        await act(async () => backdrop.click());
        expect(onClose).not.toHaveBeenCalled();
        await act(async () => finish({ added: 1, rejected: [] }));
    });

    it("the close button does not close", async () => {
        await pendingAdd();
        await act(async () => (document.querySelector('button[aria-label="close"]') as HTMLButtonElement).click());
        expect(onClose).not.toHaveBeenCalled();
        await act(async () => finish({ added: 1, rejected: [] }));
    });

    it("does not close while a new playlist is being made", async () => {
        createPlaylist.mockReturnValue(new Promise(() => {}));
        await render(["a"]);
        await typeName("late night");
        await click("create");
        await escape();
        expect(onClose).not.toHaveBeenCalled();
    });

    it("closes normally when nothing is in flight", async () => {
        await render(["a"]);
        await escape();
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});

describe("retrying a create-then-add into the playlist this dialog made", () => {
    it("skips songs the failed first try already put there, without asking", async () => {
        createPlaylist.mockResolvedValue({ id: "new-1", name: "late night" });
        mutateAsync
            .mockRejectedValueOnce(new Error("offline"))
            .mockResolvedValueOnce({ added: 1, duplicates: 1, duplicateIds: ["a"], rejected: [] });
        await render(["a", "b"]);
        await typeName("late night");
        await click("create");
        await click("create");
        expect(text()).not.toContain("already in this playlist");
        expect(mutateAsync).toHaveBeenCalledTimes(2);
        expect(mutateAsync).toHaveBeenLastCalledWith({ playlistId: "new-1", trackIds: ["a", "b"] });
        expect(onAdded).toHaveBeenCalled();
        expect(onClose).toHaveBeenCalled();
    });

    it("still counts the add when the retry finds every song already there", async () => {
        createPlaylist.mockResolvedValue({ id: "new-1", name: "late night" });
        mutateAsync
            .mockRejectedValueOnce(new Error("offline"))
            .mockResolvedValueOnce({ added: 0, duplicates: 1, duplicateIds: ["a"], rejected: [] });
        await render(["a"]);
        await typeName("late night");
        await click("create");
        await click("create");
        expect(text()).not.toContain("already in this playlist");
        expect(onAdded).toHaveBeenCalled();
        expect(onClose).toHaveBeenCalled();
    });

    it("does not make a second playlist on the retry, and a click on the new playlist in the list skips without asking too", async () => {
        createPlaylist.mockResolvedValue({ id: "new-1", name: "late night" });
        getPlaylists.mockResolvedValue([{ id: "new-1", name: "late night", trackCount: 1 }]);
        getPlaylist.mockResolvedValue(held("a"));
        mutateAsync
            .mockRejectedValueOnce(new Error("offline"))
            .mockResolvedValueOnce({ added: 1, duplicates: 1, duplicateIds: ["a"], rejected: [] });
        await render(["a", "b"]);
        await typeName("late night");
        await click("create");
        expect(createPlaylist).toHaveBeenCalledTimes(1);
        await click("late night");
        expect(createPlaylist).toHaveBeenCalledTimes(1);
        expect(text()).not.toContain("already in this playlist");
        expect(mutateAsync).toHaveBeenLastCalledWith({ playlistId: "new-1", trackIds: ["a", "b"] });
        expect(onClose).toHaveBeenCalled();
    });

    it("still asks when adding to a playlist picked from the list", async () => {
        getPlaylist.mockResolvedValue(held("z"));
        mutateAsync.mockResolvedValueOnce({ added: 0, duplicates: 1, duplicateIds: ["a"], rejected: [] });
        await render(["a"]);
        await click("road trip");
        expect(text()).toContain("already in this playlist");
    });
});

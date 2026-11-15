// Adding a song a playlist already holds asks first: one song gets "add again" or "skip", several get "add all" or
// "add new ones". Nothing is written until the person answers, and only an answer of "again" or "all" allows repeats.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";

const getPlaylists = vi.fn();
const getPlaylist = vi.fn();
const mutateAsync = vi.fn();
vi.mock("@/lib/api", () => ({
    api: {
        getPlaylists: (...a: unknown[]) => getPlaylists(...a),
        getPlaylist: (...a: unknown[]) => getPlaylist(...a),
        createPlaylist: vi.fn(),
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

const held = (...ids: string[]) => ({ id: "pl-1", items: ids.map((id, i) => ({ id: `item-${i}`, trackId: id, track: { id } })) });
const text = () => document.body.textContent ?? "";
const button = (label: string) =>
    Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim().startsWith(label)) as HTMLButtonElement | undefined;
const click = async (label: string) => {
    const b = button(label);
    if (!b) throw new Error(`no button "${label}" in: ${text()}`);
    await act(async () => b.click());
};

const onClose = vi.fn();
const onAdded = vi.fn();
async function open(trackIds: string[]) {
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(<PlaylistSelector isOpen onClose={onClose} onAdded={onAdded} trackIds={trackIds} />));
    await click("road trip");
}

beforeEach(() => {
    vi.clearAllMocks();
    getPlaylists.mockResolvedValue([{ id: "pl-1", name: "road trip", trackCount: 2 }]);
    mutateAsync.mockResolvedValue({ added: 1, duplicates: 0, rejected: [] });
});

describe("adding one song", () => {
    it("adds it straight away when the playlist does not hold it", async () => {
        getPlaylist.mockResolvedValue(held("b"));
        await open(["a"]);
        expect(mutateAsync).toHaveBeenCalledWith({ playlistId: "pl-1", trackIds: ["a"] });
        expect(onAdded).toHaveBeenCalled();
        expect(onClose).toHaveBeenCalled();
    });

    it("asks first when the playlist already holds it, and writes nothing yet", async () => {
        getPlaylist.mockResolvedValue(held("a"));
        await open(["a"]);
        expect(text()).toContain("already in this playlist. add again?");
        expect(button("add again")).toBeDefined();
        expect(button("skip")).toBeDefined();
        expect(mutateAsync).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
    });

    it("adds a second copy, allowing repeats, only after \"add again\"", async () => {
        getPlaylist.mockResolvedValue(held("a"));
        await open(["a"]);
        await click("add again");
        expect(mutateAsync).toHaveBeenCalledTimes(1);
        expect(mutateAsync).toHaveBeenCalledWith({ playlistId: "pl-1", trackIds: ["a"], allowRepeats: true });
        expect(onAdded).toHaveBeenCalled();
        expect(onClose).toHaveBeenCalled();
    });

    it("adds nothing on \"skip\" and closes", async () => {
        getPlaylist.mockResolvedValue(held("a"));
        await open(["a"]);
        await click("skip");
        expect(mutateAsync).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalled();
    });
});

describe("adding several songs", () => {
    it("offers add all or add new ones when some are already there", async () => {
        getPlaylist.mockResolvedValue(held("a", "b"));
        await open(["a", "b", "c"]);
        expect(text()).toContain("2 of 3 songs are already in this playlist");
        expect(button("add all")).toBeDefined();
        expect(button("add new ones")).toBeDefined();
        expect(mutateAsync).not.toHaveBeenCalled();
    });

    it("\"add all\" adds every song, allowing repeats", async () => {
        getPlaylist.mockResolvedValue(held("a", "b"));
        await open(["a", "b", "c"]);
        await click("add all");
        expect(mutateAsync).toHaveBeenCalledWith({ playlistId: "pl-1", trackIds: ["a", "b", "c"], allowRepeats: true });
        expect(onClose).toHaveBeenCalled();
    });

    it("\"add new ones\" adds only the songs the playlist lacks, with no repeats allowed", async () => {
        getPlaylist.mockResolvedValue(held("a", "b"));
        await open(["a", "b", "c"]);
        await click("add new ones");
        expect(mutateAsync).toHaveBeenCalledWith({ playlistId: "pl-1", trackIds: ["c"] });
        expect(onClose).toHaveBeenCalled();
    });

    it("asks add again or skip when every one is already there", async () => {
        getPlaylist.mockResolvedValue(held("a", "b"));
        await open(["a", "b"]);
        expect(text()).toContain("all 2 songs are already in this playlist");
        expect(button("add all")).toBeUndefined();
        await click("add again");
        expect(mutateAsync).toHaveBeenCalledWith({ playlistId: "pl-1", trackIds: ["a", "b"], allowRepeats: true });
    });

    it("adds without asking when none are there", async () => {
        getPlaylist.mockResolvedValue(held("z"));
        await open(["a", "b"]);
        expect(mutateAsync).toHaveBeenCalledWith({ playlistId: "pl-1", trackIds: ["a", "b"] });
    });
});

describe("when something goes wrong", () => {
    it("still adds the plain way if the playlist cannot be read, since the server skips repeats itself", async () => {
        getPlaylist.mockRejectedValue(new Error("offline"));
        await open(["a"]);
        expect(mutateAsync).toHaveBeenCalledWith({ playlistId: "pl-1", trackIds: ["a"] });
    });

    it("stays open and says so when the add fails after the answer", async () => {
        getPlaylist.mockResolvedValue(held("a"));
        mutateAsync.mockRejectedValue(new Error("nope"));
        await open(["a"]);
        await click("add again");
        expect(onClose).not.toHaveBeenCalled();
        expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/couldn't add/i);
    });
});

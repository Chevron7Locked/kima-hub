/**
 * The metadata editor sends only the fields the person changed. The form starts from what the page shows (the shown
 * year, cover and genres, canonical or edited), so sending all of it would turn every one of those into an edit, and an
 * album stored with a year the server refuses (0, say) could not have its title changed.
 */
import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";

const api = vi.hoisted(() => ({
    updateAlbumMetadata: vi.fn(),
    updateArtistMetadata: vi.fn(),
    updateTrackMetadata: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ api }));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

import { MetadataEditor } from "@/components/MetadataEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
    api.updateAlbumMetadata.mockReset().mockResolvedValue({});
    api.updateArtistMetadata.mockReset().mockResolvedValue({});
    api.updateTrackMetadata.mockReset().mockResolvedValue({});
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

const ALBUM = {
    title: "old title",
    year: 0,
    genres: ["rock"],
    rgMbid: "11111111-1111-1111-1111-111111111111",
    coverUrl: "https://covers.example/a.jpg",
};

async function open(type: "artist" | "album" | "track", currentData: Record<string, unknown>) {
    await act(async () => root.render(<MetadataEditor type={type} id="x1" currentData={currentData} />));
    await act(async () => (container.querySelector("button") as HTMLButtonElement).click());
}

async function type(input: HTMLInputElement, value: string) {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
        set.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
}

const inputs = () => Array.from(document.body.querySelectorAll("input")) as HTMLInputElement[];
const save = async () => {
    const button = Array.from(document.body.querySelectorAll("button")).find((b) => /save changes/i.test(b.textContent ?? ""));
    await act(async () => (button as HTMLButtonElement).click());
};

it("a title-only save of an album stored with year 0 sends the title and no year", async () => {
    await open("album", ALBUM);
    await type(inputs()[0], "new title");
    await save();

    expect(api.updateAlbumMetadata).toHaveBeenCalledTimes(1);
    expect(api.updateAlbumMetadata).toHaveBeenCalledWith("x1", { title: "new title" });
});

it("a changed genre list and a cleared year are sent, and nothing else", async () => {
    await open("album", { ...ALBUM, year: 1999 });
    const [, year, genres] = inputs();
    await type(year, "");
    await type(genres, "rock, ambient");
    await save();

    expect(api.updateAlbumMetadata).toHaveBeenCalledWith("x1", { year: null, genres: ["rock", "ambient"] });
});

it("a field changed and put back is not sent", async () => {
    await open("album", ALBUM);
    await type(inputs()[0], "something else");
    await type(inputs()[0], "old title");
    await save();

    expect(api.updateAlbumMetadata).toHaveBeenCalledWith("x1", {});
});

it("an artist and a track send only what changed too", async () => {
    await open("artist", { name: "a", bio: "b", genres: ["x"], mbid: "m", heroUrl: "https://h.example/h.jpg" });
    await type(inputs()[0], "renamed");
    await save();
    expect(api.updateArtistMetadata).toHaveBeenCalledWith("x1", { name: "renamed" });

    act(() => root.unmount());
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await open("track", { title: "song", genres: ["x"] });
    await type(inputs()[0], "song 2");
    await save();
    expect(api.updateTrackMetadata).toHaveBeenCalledWith("x1", { title: "song 2" });
});

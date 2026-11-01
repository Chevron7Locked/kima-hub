/**
 * Deleting an artist or album is offered on its own page, not on the collection grid: the action bars show a delete
 * button only when handed onDelete, and the grid's cards never show one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";

vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));

import { ArtistActionBar } from "@/features/artist/components/ArtistActionBar";
import { AlbumActionBar } from "@/features/album/components/AlbumActionBar";
import { MediaCard } from "@/components/cards/MediaCard";
import { LibraryGrid } from "@/features/library/components/LibraryGrid";
import { Play } from "lucide-react";
import type { Album } from "@/features/album/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLDivElement;

afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    container?.remove();
});

function draw(node: React.ReactNode) {
    container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
    act(() => root!.render(node));
    return container;
}

const deleteButton = (c: HTMLElement) => c.querySelector('button[aria-label*="delete" i], button[title*="delete" i]');

const artistBar = (onDelete?: () => void) => (
    <ArtistActionBar
        albums={[]}
        source="library"
        onPlayAll={() => {}}
        onShuffle={() => {}}
        onStartRadio={() => {}}
        onDelete={onDelete}
        isPendingDownload={false}
        isPlaying={false}
        isPlayingThisArtist={false}
        onPause={() => {}}
    />
);

const albumBar = (onDelete?: () => void) => (
    <AlbumActionBar
        album={{ id: "al", title: "x", owned: true } as unknown as Album}
        source="library"
        onPlayAll={() => {}}
        onShuffle={() => {}}
        onAddToPlaylist={() => {}}
        onDelete={onDelete}
        isPendingDownload={false}
        isPlaying={false}
        isPlayingThisAlbum={false}
        onPause={() => {}}
    />
);

describe("delete lives on the artist and album pages", () => {
    it("the artist bar shows a lowercase delete button only when given onDelete", () => {
        expect(deleteButton(draw(artistBar()))).toBeNull();
        act(() => root!.unmount());
        const onDelete = vi.fn();
        const button = deleteButton(draw(artistBar(onDelete)));
        expect(button?.getAttribute("aria-label")).toBe("delete artist");
        expect(button?.getAttribute("title")).toBe("delete artist");
        act(() => (button as HTMLElement).click());
        expect(onDelete).toHaveBeenCalledTimes(1);
    });

    it("the album bar shows a lowercase delete button only when given onDelete", () => {
        expect(deleteButton(draw(albumBar()))).toBeNull();
        act(() => root!.unmount());
        const onDelete = vi.fn();
        const button = deleteButton(draw(albumBar(onDelete)));
        expect(button?.getAttribute("aria-label")).toBe("delete album");
        act(() => (button as HTMLElement).click());
        expect(onDelete).toHaveBeenCalledTimes(1);
    });

    it("a media card and the collection grid never show a delete button", () => {
        const card = draw(
            <MediaCard href="/album/1" title="Thriller" imageUrl={null} fallbackIcon={Play} type="album" index={0} action={{ icon: Play, label: "Play", onClick: () => {} }} {...{ onDelete: () => {} }} />,
        );
        expect(deleteButton(card)).toBeNull();
        act(() => root!.unmount());
        const grid = draw(
            <LibraryGrid
                kind="album"
                cards={[{ id: "1", title: "Thriller", subtitle: "mj", href: "/album/1" }]}
                onPlay={async () => {}}
                {...{ onDelete: () => {} }}
            />,
        );
        expect(deleteButton(grid)).toBeNull();
    });
});

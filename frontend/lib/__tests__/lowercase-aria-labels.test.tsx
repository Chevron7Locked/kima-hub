/**
 * Every word the interface says is lowercase, to a screen reader too: the accessible names of the episode list's and the
 * album song list's buttons carry no capitals, except a typed title (an episode's own name keeps its case).
 */
import { describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { mountHost } from "./helpers/dom";

vi.mock("@/lib/audio-state-context", () => ({
    useCurrentMedia: () => ({ currentTrack: null }),
    useQueueState: () => ({ currentQueueSource: null }),
}));
vi.mock("@/lib/audio-playback-context", () => ({ useAudioPlayback: () => ({ isPlaying: false }) }));
vi.mock("@/lib/audio-controls-context", () => ({
    useAudioControls: () => ({ pause: vi.fn(), resumeWithGesture: vi.fn(async () => undefined) }),
}));
vi.mock("@/lib/api", () => ({ api: { getCoverArtUrl: (id: string) => `/cover/${id}` } }));
vi.mock("@/components/ui/CachedImage", () => ({ CachedImage: () => null }));
vi.mock("@/components/ui/PlaylistSelector", () => ({ PlaylistSelector: () => null }));
vi.mock("@/hooks/useDoubleTap", () => ({
    useDoubleTap: (callback: () => void) => ({ onTouchEnd: () => {}, onDoubleClick: callback }),
    useDoubleTapList: () => () => {},
}));

import { TrackList } from "@/features/album/components/TrackList";
import { EpisodeList } from "@/features/podcast/components/EpisodeList";

const dom = mountHost();

const labels = () => [...dom.host.querySelectorAll("[aria-label]")].map((el) => el.getAttribute("aria-label")!);
const withoutTitles = (all: string[], ...titles: string[]) => all.map((label) => titles.reduce((rest, title) => rest.replace(title, ""), label));

describe("accessible names", () => {
    it("of the episode list have no capitals", async () => {
        const episode = {
            id: "e1", title: "Big Show", description: "<p>about</p>", duration: 600, publishedAt: "2026-01-01T00:00:00Z",
            progress: { currentTime: 0, progress: 0, isFinished: false, lastPlayedAt: new Date() },
        };
        await act(async () =>
            dom.root.render(
                <EpisodeList
                    episodes={[episode]}
                    sortOrder="newest"
                    onSortOrderChange={() => {}}
                    isEpisodePlaying={() => false}
                    isPlaying={false}
                    onPlayPause={() => {}}
                    onMarkComplete={() => {}}
                    total={1}
                />,
            ),
        );
        const found = withoutTitles(labels(), "Big Show");
        expect(found.length).toBeGreaterThan(3);
        expect(found.filter((label) => label !== label.toLowerCase())).toEqual([]);
    });

    it("of the album song list, with a preview-only song, have no capitals", async () => {
        await act(async () =>
            dom.root.render(
                <TrackList
                    tracks={[{ id: "t1", title: "Song", duration: 100, trackNumber: 1 }] as never}
                    album={{ id: "al", title: "Album", artist: { name: "Artist" } } as never}
                    source="discovery"
                    currentTrackId={undefined}
                    colors={null}
                    onPlayTrack={() => {}}
                    onAddToQueue={() => {}}
                    onAddToPlaylist={() => {}}
                    previewTrack={null}
                    previewPlaying={false}
                    onPreview={() => {}}
                />,
            ),
        );
        const found = labels();
        expect(found.length).toBeGreaterThan(1);
        expect(found.filter((label) => label !== label.toLowerCase())).toEqual([]);
    });
});

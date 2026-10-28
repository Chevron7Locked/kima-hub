/**
 * Chooses what a test uses by asking the server, not by taking whatever comes first on a page.
 * Every method returns null (or an empty list) when nothing fits, so the caller records that
 * part as not covered instead of failing on a library that simply lacks the thing.
 */
import type { APIRequestContext } from "@playwright/test";

/** A song as the track list returns it, cut down to what the tests read. */
export interface PickedTrack {
    id: string;
    title: string;
    duration: number;
    albumId: string;
    albumTitle: string;
    artistId: string;
    artistName: string;
    /** True when the server holds tempo and energy for the song. */
    analysed: boolean;
}

export interface PickedAlbum {
    id: string;
    title: string;
    artistId: string;
    artistName: string;
    tracks: PickedTrack[];
}

/** A song shorter than this cannot be played long enough for the player checks. */
export const MIN_PLAY_SECONDS = 60;

const PAGE = 2000;

export class LibraryPicker {
    private trackCache: PickedTrack[] | null = null;

    constructor(
        private readonly api: Pick<APIRequestContext, "get">,
        private readonly token: string,
    ) {}

    private get headers() {
        return { Authorization: `Bearer ${this.token}` };
    }

    /** Every library song the player can start: not missing, not corrupt, longer than a minute. Read once. */
    async playableTracks(): Promise<PickedTrack[]> {
        if (this.trackCache) return this.trackCache;
        const out: PickedTrack[] = [];
        for (let offset = 0; ; offset += PAGE) {
            const res = await this.api.get(`/api/library/tracks?limit=${PAGE}&offset=${offset}`, { headers: this.headers });
            if (!res.ok()) throw new Error(`the song list answered ${res.status()}`);
            const body = (await res.json()) as {
                tracks: Array<{
                    id: string;
                    title: string;
                    duration: number;
                    albumId: string;
                    corrupt?: boolean;
                    missingSince?: string | null;
                    audioFeatures?: { bpm: number | null; energy: number | null } | null;
                    album: { title: string; artist: { id: string; name: string } };
                }>;
                total: number;
            };
            for (const t of body.tracks) {
                if (t.corrupt || t.missingSince || !(t.duration > MIN_PLAY_SECONDS)) continue;
                out.push({
                    id: t.id,
                    title: t.title,
                    duration: t.duration,
                    albumId: t.albumId,
                    albumTitle: t.album.title,
                    artistId: t.album.artist.id,
                    artistName: t.album.artist.name,
                    analysed: t.audioFeatures?.bpm != null && t.audioFeatures?.energy != null,
                });
            }
            if (body.tracks.length < PAGE || offset + PAGE >= body.total) break;
        }
        this.trackCache = out;
        return out;
    }

    /** The first library album (in the song list's order) with at least `min` playable songs. */
    async albumWithTracks(min: number): Promise<PickedAlbum | null> {
        const byAlbum = new Map<string, PickedTrack[]>();
        for (const t of await this.playableTracks()) {
            const list = byAlbum.get(t.albumId) ?? [];
            list.push(t);
            byAlbum.set(t.albumId, list);
        }
        for (const [id, tracks] of byAlbum) {
            if (tracks.length >= min) {
                return { id, title: tracks[0].albumTitle, artistId: tracks[0].artistId, artistName: tracks[0].artistName, tracks };
            }
        }
        return null;
    }

    /** `count` playable songs whose titles all differ, or fewer when the library has fewer. */
    async distinctTitleTracks(count: number): Promise<PickedTrack[]> {
        const seen = new Set<string>();
        const out: PickedTrack[] = [];
        for (const t of await this.playableTracks()) {
            const key = t.title.trim().toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(t);
            if (out.length === count) break;
        }
        return out;
    }

    /** The first playable song the server has analysed (so its audio features are filled in). */
    async analysedTrack(): Promise<PickedTrack | null> {
        return (await this.playableTracks()).find((t) => t.analysed) ?? null;
    }

    /** The first playable song by an artist whose name can be searched for (not empty). */
    async firstTrack(): Promise<PickedTrack | null> {
        return (await this.playableTracks())[0] ?? null;
    }

    /**
     * Radio stations that would start right now: the server returns at least `minTracks` songs for
     * them, which is the bar the radio page itself applies. `candidates` are tried in order, then the
     * server's own mood stations (which need one song).
     */
    async playableStations(
        candidates: Array<{ name: string; type: string; value?: string; minTracks: number }>,
    ): Promise<Array<{ name: string; type: string; value?: string }>> {
        const all = [...candidates];
        const listed = await this.api.get("/api/library/radio/stations", { headers: this.headers });
        if (listed.ok()) {
            const stations = ((await listed.json()).stations ?? []) as Array<{ value: string; name: string }>;
            for (const s of stations) all.push({ name: s.name, type: "mood", value: s.value, minTracks: 1 });
        }
        const tz = encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone);
        const out: Array<{ name: string; type: string; value?: string }> = [];
        for (const c of all) {
            const q = `type=${encodeURIComponent(c.type)}${c.value ? `&value=${encodeURIComponent(c.value)}` : ""}&limit=100&tz=${tz}`;
            const res = await this.api.get(`/api/library/radio?${q}`, { headers: this.headers });
            if (res.ok() && ((await res.json()).tracks ?? []).length >= c.minTracks) out.push({ name: c.name, type: c.type, value: c.value });
        }
        return out;
    }

    /** A library artist with at least one album the listener does not own, found by asking for each artist's page. */
    async artistWithUnownedAlbums(): Promise<{ id: string; name: string } | null> {
        const list = await this.api.get("/api/library/artists?limit=50", { headers: this.headers });
        if (!list.ok()) return null;
        const artists = ((await list.json()).artists ?? []) as Array<{ id: string; name: string }>;
        for (const a of artists) {
            const res = await this.api.get(`/api/library/artists/${a.id}`, { headers: this.headers });
            if (!res.ok()) continue;
            const albums = ((await res.json()).albums ?? []) as Array<{ owned?: boolean }>;
            if (albums.some((al) => al.owned === false)) return { id: a.id, name: a.name };
        }
        return null;
    }
}

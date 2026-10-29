import { prisma } from "../../../utils/db";
import { eventBus, type SSEEvent } from "../../../services/eventBus";

/** Deletes everything a test seeded under `mark`: users by username prefix, then songs, albums and artists by name. */
export async function cleanupMarked(mark: string): Promise<void> {
    await prisma.user.deleteMany({ where: { username: { startsWith: mark } } });
    await prisma.track.deleteMany({ where: { title: { startsWith: mark } } });
    await prisma.album.deleteMany({ where: { title: { startsWith: mark } } });
    await prisma.artist.deleteMany({ where: { name: { startsWith: mark } } });
}

/** One artist, one library album and `count` songs, all named from `mark`; returns the song ids in track order. */
export async function seedSongs(mark: string, count: number, artistData: { libraryAlbumCount?: number } = {}): Promise<string[]> {
    const artist = await prisma.artist.create({ data: { name: `${mark} Artist`, identityKey: `${mark}-artist`, ...artistData } });
    const album = await prisma.album.create({
        data: { rgMbid: `${mark}-rg`, identityKey: `${mark}-album`, primaryType: "Album", title: `${mark} Album`, artistId: artist.id, location: "LIBRARY" },
    });
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
        const track = await prisma.track.create({
            data: { title: `${mark} Song ${i}`, albumId: album.id, trackNo: i + 1, duration: 100, filePath: `/${mark}/${i}.flac`, fileModified: new Date(), fileSize: 1000 },
        });
        ids.push(track.id);
    }
    return ids;
}

/** Subscribes to `userId`'s live events the way a connected device does; `heard` fills as events arrive. */
export function listenTo(userId: string): { heard: SSEEvent[]; stop: () => void } {
    const heard: SSEEvent[] = [];
    const stop = eventBus.subscribe(userId, { send: (event) => (heard.push(event), true) });
    return { heard, stop };
}

/** The payloads of the `playlist:updated` events among `heard`. */
export const playlistAnnouncements = (heard: SSEEvent[]) => heard.filter((e) => e.type === "playlist:updated").map((e) => e.payload);

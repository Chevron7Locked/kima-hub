import { prisma } from "../../utils/db";
import { spotifyImportService } from "../../services/spotifyImport";
import { M3UNothingMatched, type M3UEntry } from "../../services/m3uParser";

/**
 * The song ids an M3U import puts in its playlist, in order. An import in which nothing matched makes no playlist
 * and throws M3UNothingMatched; here that is an empty list, so a test can ask what matched without caring which way
 * "nothing" is answered.
 */
export async function m3uSongIds(userId: string, playlistName: string, entries: M3UEntry[]): Promise<string[]> {
    try {
        const { playlistId } = await spotifyImportService.importFromM3U(userId, playlistName, entries);
        const items = await prisma.playlistItem.findMany({ where: { playlistId }, orderBy: { sort: "asc" } });
        return items.map((i) => i.trackId);
    } catch (error) {
        if (error instanceof M3UNothingMatched) return [];
        throw error;
    }
}

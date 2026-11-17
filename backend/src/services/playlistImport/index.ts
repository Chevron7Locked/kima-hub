/**
 * Playlist imports from Spotify, Deezer, other music sites and M3U files: a preview of what the library has, downloads
 * of what it lacks, and the playlist built once they are scanned. Three parts sit behind this interface, each tested
 * on its own:
 * - reading.ts: a music link or an M3U file into a list of songs;
 * - matching/: those songs against the library;
 * - placing.ts and jobState.ts: the download jobs, the playlist, and the songs it still waits for.
 */
export { playlistImportService, mergeEditionTracks } from "./placing";
export { getImportJob, announceImportCounts, failImportJob, recordAlbumProgress } from "./jobState";
export { parseM3U, decodeM3U, M3UNothingMatched, M3UContainsNullBytes, M3UTooManyEntries, type M3UEntry } from "./reading";
export type { ImportJob, ImportPreview } from "./types";

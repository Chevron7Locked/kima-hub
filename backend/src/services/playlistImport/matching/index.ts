/**
 * Matching the songs of a source to the library. Three interfaces, each for one question:
 * - `previewOfTracklist`: what the library has of a tracklist and what it lacks, for the preview and the download pick;
 * - `matchEntries` / `matchEntry`: the song for a listing when nothing better is known (a playlist's build and refresh);
 * - `matchM3UEntries`: the song for each entry of an M3U file, by path, file name and metadata.
 */
export { previewOfTracklist, pendingTracksOf } from "./preview";
export { matchEntries, matchEntry, type Listing, type EntryMatch } from "./ladder";
export { matchM3UEntries } from "./m3u";

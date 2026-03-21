// Re-exports the modular library router from the library/ sub-directory.
// The implementation has been split into focused sub-routers:
//   library/scan.ts     -- scan, organize, corrupt-tracks
//   library/artists.ts  -- artists, artist-counts, backfill-genres
//   library/albums.ts   -- albums
//   library/tracks.ts   -- tracks, recently-listened/added, genres, decades, radio
//   library/streaming.ts -- audio streaming
//   library/coverArt.ts -- cover art serving and color extraction
//   library/backfill.ts -- image backfill
export { default } from "./library/index";

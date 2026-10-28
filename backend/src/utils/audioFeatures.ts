/**
 * Shared DTO formatter for per-track audio features.
 *
 * Returns the exact 8-field shape used by the iOS vibe %-badge.
 * For an un-analyzed track (null feature columns), returns an object
 * with all values set to null.
 */
/** The 8 per-track feature columns the DTO carries, all nullable until analysis runs. */
export interface AudioFeatures {
  bpm: number | null;
  energy: number | null;
  valence: number | null;
  arousal: number | null;
  danceability: number | null;
  keyScale: string | null;
  instrumentalness: number | null;
  analysisMode: string | null;
}

export function toAudioFeaturesDTO(track: AudioFeatures): AudioFeatures {
  return {
    bpm: track.bpm ?? null,
    energy: track.energy ?? null,
    valence: track.valence ?? null,
    arousal: track.arousal ?? null,
    danceability: track.danceability ?? null,
    keyScale: track.keyScale ?? null,
    instrumentalness: track.instrumentalness ?? null,
    analysisMode: track.analysisMode ?? null,
  };
}

/**
 * Prisma `select` fragment for the 8 columns `toAudioFeaturesDTO` reads. Spread into
 * a track `select` on list/collection endpoints so `audioFeatures` can be inlined
 * without over- or under-selecting. Endpoints that fetch full tracks via `include`
 * already have these columns and don't need this.
 */
export const AUDIO_FEATURE_SELECT = {
  bpm: true,
  energy: true,
  valence: true,
  arousal: true,
  danceability: true,
  keyScale: true,
  instrumentalness: true,
  analysisMode: true,
} as const;

/**
 * Shared DTO formatter for per-track audio features.
 *
 * Returns the exact 15-field shape used by the iOS vibe %-badge.
 * For an un-analyzed track (null feature columns), returns an object
 * with all values set to null.
 */
export function toAudioFeaturesDTO(track: {
  bpm: number | null;
  energy: number | null;
  valence: number | null;
  arousal: number | null;
  danceability: number | null;
  keyScale: string | null;
  instrumentalness: number | null;
  analysisMode: string | null;
  moodHappy: number | null;
  moodSad: number | null;
  moodRelaxed: number | null;
  moodAggressive: number | null;
  moodParty: number | null;
  moodAcoustic: number | null;
  moodElectronic: number | null;
}): {
  bpm: number | null;
  energy: number | null;
  valence: number | null;
  arousal: number | null;
  danceability: number | null;
  keyScale: string | null;
  instrumentalness: number | null;
  analysisMode: string | null;
  moodHappy: number | null;
  moodSad: number | null;
  moodRelaxed: number | null;
  moodAggressive: number | null;
  moodParty: number | null;
  moodAcoustic: number | null;
  moodElectronic: number | null;
} {
  return {
    bpm: track.bpm ?? null,
    energy: track.energy ?? null,
    valence: track.valence ?? null,
    arousal: track.arousal ?? null,
    danceability: track.danceability ?? null,
    keyScale: track.keyScale ?? null,
    instrumentalness: track.instrumentalness ?? null,
    analysisMode: track.analysisMode ?? null,
    moodHappy: track.moodHappy ?? null,
    moodSad: track.moodSad ?? null,
    moodRelaxed: track.moodRelaxed ?? null,
    moodAggressive: track.moodAggressive ?? null,
    moodParty: track.moodParty ?? null,
    moodAcoustic: track.moodAcoustic ?? null,
    moodElectronic: track.moodElectronic ?? null,
  };
}

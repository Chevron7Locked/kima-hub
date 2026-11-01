/**
 * The Redis keys the mixes keep under `mixes:`. The mood step drops the cached mix lists when the moods change, but not
 * the keys here: none of them is worked out from the moods (the energy band from analysis readings, the familiarity
 * scan from plays and sound vectors), so a mood change leaves them valid.
 */
export const ENERGY_BAND_KEY = "mixes:energy-band";
/** Prefix of the familiarity scan's result and its lock (familiarity.ts). */
export const FAMILIAR_KEY_PREFIX = "mixes:familiar";

/** True for a `mixes:` key that a change to the moods makes stale. */
export function dependsOnMoods(key: string): boolean {
    return key !== ENERGY_BAND_KEY && !key.startsWith(FAMILIAR_KEY_PREFIX);
}

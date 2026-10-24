/**
 * A Home mix drawn by the recipe engine: the mix's own id, title, description and colour around the songs the engine
 * draws from its recipe for this day and this user.
 */
import { ProgrammaticMix, albumCoverUrls, getMixColor, tracksByIds } from "./helpers";
import { weekdayOf } from "./mixDay";
import { pickRecipeTracks } from "./recipes";

export interface RecipeMixSpec {
    /** The recipe's id in recipes.json. */
    recipe: string;
    /** The mix id's prefix; the day it holds for follows it. */
    id: string;
    type: string;
    name: string;
    description: string;
    /** Key into the mix colour table. */
    colorType: string;
    /** The weekday the mix exists on (0 = Sunday), of the day it is drawn for; every day when absent. */
    day?: number;
}

/**
 * The mix for `today`, or null on another weekday or when fewer than MIN_MIX_TRACKS songs are the recipe's members.
 * `today` is the day the mix holds for, with a refresh's reroll appended, so a refresh draws again.
 */
export async function recipeMix(spec: RecipeMixSpec, userId: string, today: string): Promise<ProgrammaticMix | null> {
    if (spec.day !== undefined && weekdayOf(today) !== spec.day) return null;
    const mix = await pickRecipeTracks(spec.recipe, { userId, date: today });
    if (!mix) return null;
    const tracks = await tracksByIds(mix.trackIds, { album: { select: { coverUrl: true } } });
    return {
        id: `${spec.id}-${today}`,
        type: spec.type,
        name: spec.name,
        description: spec.description,
        trackIds: tracks.map((t) => t.id),
        coverUrls: albumCoverUrls(tracks),
        trackCount: tracks.length,
        color: getMixColor(spec.colorType),
    };
}

/** A generator for the daily rotation: `recipeMix` with its spec bound. */
export const recipeMixGenerator =
    (spec: RecipeMixSpec) =>
    (userId: string, today: string): Promise<ProgrammaticMix | null> =>
        recipeMix(spec, userId, today);

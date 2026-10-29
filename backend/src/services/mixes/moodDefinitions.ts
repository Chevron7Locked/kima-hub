/**
 * Mood definitions: the layer between the trained heads and the recipes. The 22 heads keep writing raw scores. A
 * definition (moodDefinitions.json) rebuilds one mood from parts, with weights and "low:" parts like a recipe's
 * components, and every recipe component and mood tag of that mood then reads the defined score (recipes.ts swaps it
 * in, standardised against the library like any raw score). A mood without a definition passes through unchanged.
 *
 * Parts: a mood (never a defined one), `head:<mood>` for a mood's raw head score (how a definition keeps its own
 * head as a part), a reading (arousal, instrumental, acoustic), or `pace`.
 *
 * The shipped weights add to 1 and each part is a library z-score. Focus: instrumental 0.5 (lyrics are the one
 * consistent harm to concentration), calm 0.3, the focus head 0.2 (the head alone failed on Music4All). Driving:
 * arousal 0.35, low:instrumental 0.25 (singable), pace 0.25 (a steady middle tempo, PACE_BAND), the driving head
 * 0.15. Pace is a soft part; a hard tempo limit would be a recipe filter instead.
 */
import { LIVE_MOODS, type Mood } from "../moods/heads";
import definitionFile from "./moodDefinitions.json";

/** The middle half of drivers' own picks (Navarro 2023). A tempo counts double or half, on a steady beat only. */
export const PACE_BAND: readonly [number, number] = [94, 130];
/** A song with no tempo, or no steady beat to trust one from, has no pace to judge: it scores in the middle. */
export const NEUTRAL_PACE = 0.5;

const DEFINITION_READINGS = ["arousal", "instrumental", "acoustic"] as const;
type DefinitionReading = (typeof DEFINITION_READINGS)[number];

export type DefinitionPart =
    | { kind: "mood"; mood: Mood; weight: number }
    | { kind: "head"; mood: Mood; weight: number }
    | { kind: "reading"; reading: DefinitionReading; weight: number }
    | { kind: "pace"; weight: number };

export interface MoodDefinition {
    mood: Mood;
    parts: DefinitionPart[];
}

const isLive = (name: string): name is Mood => (LIVE_MOODS as readonly string[]).includes(name);

/** The definitions file, checked: every key a live mood, every part known, positive weights, no part twice. */
export function parseDefinitions(raw: unknown): ReadonlyMap<Mood, MoodDefinition> {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("Definitions: not an object");
    const entries = Object.entries(raw);
    const defined = new Set(entries.map(([mood]) => mood));
    const definitions = new Map<Mood, MoodDefinition>();
    for (const [mood, entry] of entries) {
        const where = `Definition ${mood}`;
        if (!isLive(mood)) throw new Error(`${where}: not a mood a definition can rebuild`);
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error(`${where}: not an object`);
        const parts: DefinitionPart[] = [];
        const seen = new Set<string>();
        for (const [key, value] of Object.entries(entry)) {
            const low = key.startsWith("low:");
            const name = low ? key.slice(4) : key;
            if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
                throw new Error(`${where}: ${key} needs a positive weight`);
            }
            const weight = low ? -value : value;
            let part: DefinitionPart;
            if (name === "pace") part = { kind: "pace", weight };
            else if ((DEFINITION_READINGS as readonly string[]).includes(name)) {
                part = { kind: "reading", reading: name as DefinitionReading, weight };
            } else if (name.startsWith("head:")) {
                const head = name.slice(5);
                if (!isLive(head)) throw new Error(`${where}: ${name} is not a live mood's head`);
                part = { kind: "head", mood: head, weight };
            } else if (isLive(name)) {
                if (defined.has(name)) {
                    throw new Error(
                        `${where}: ${name} is itself defined, and a definition cannot read a defined mood; ` +
                            `use head:${name} for its raw score`,
                    );
                }
                part = { kind: "mood", mood: name, weight };
            } else {
                throw new Error(`${where}: unknown part ${name}`);
            }
            const id = part.kind === "pace" ? "pace" : part.kind === "reading" ? part.reading : `${part.kind}:${part.mood}`;
            if (seen.has(id)) throw new Error(`${where}: ${name} appears twice`);
            seen.add(id);
            parts.push(part);
        }
        if (parts.length === 0) throw new Error(`${where}: no parts`);
        definitions.set(mood, { mood, parts });
    }
    return definitions;
}

export const DEFINITIONS = parseDefinitions(definitionFile);

/**
 * The tag pass is skipped while the mood statistics row is the one it last wrote from (tags.ts), which is safe only if
 * every input the tags read changes that row. The inputs fingerprint (state.ts inputsFingerprint) covers the mood
 * scores, the eligible songs and the arousal, instrumental, acoustic, tempo, tempo confidence and key scale readings.
 * The tags read the mood scores and, for a defined mood, the parts of its definition (mixes/moodDefinitions.json):
 * every part must read only fingerprinted inputs, or a re-analysis that changed only that input would keep stale tags.
 */
import { LIVE_MOODS, MOODS, RETIRED_MOODS } from "../heads";
import { DEFINITIONS, parseDefinitions, type DefinitionPart } from "../../mixes/moodDefinitions";
import { TAG_LINE_Z } from "../tags";
import { RECIPE_LINE } from "../../mixes/recipes";
import fs from "fs";
import path from "path";

/** The "Track" columns each part reads, by part: what the fingerprint must cover. */
function inputsOf(part: DefinitionPart): string[] {
    switch (part.kind) {
        case "mood":
        case "head":
            return [`mood:${part.mood}`];
        case "reading":
            return [part.reading];
        case "pace":
            return ["bpm", "bpmConfidence"];
    }
}

/** What inputsFingerprint hashes, read from its source so the test fails if the two drift apart. */
const FINGERPRINT_SOURCE = fs.readFileSync(path.join(__dirname, "../state.ts"), "utf8");
const FINGERPRINTED = new Set<string>([
    ...MOODS.map((m) => `mood:${m}`),
    ...["arousal", "instrumental", "acoustic"],
    ...[
        ["bpm", "t.bpm::text"],
        ["bpmConfidence", `t."bpmConfidence"::text`],
    ].flatMap(([input, hashed]) => (FINGERPRINT_SOURCE.includes(hashed) ? [input] : [])),
]);

describe("the tags", () => {
    it("sit at the recipes' own line", () => {
        expect(TAG_LINE_Z).toBe(RECIPE_LINE);
    });

    it("read only inputs the mood statistics' fingerprint covers, so skipping an unchanged tag pass is safe", () => {
        expect(FINGERPRINT_SOURCE).toContain(`t."bpmConfidence"::text`);
        expect(FINGERPRINT_SOURCE).toContain(`t."keyScale"`);
        for (const definition of DEFINITIONS.values()) {
            const unfingerprinted = definition.parts.flatMap(inputsOf).filter((input) => !FINGERPRINTED.has(input));
            expect({ mood: definition.mood, unfingerprinted }).toEqual({ mood: definition.mood, unfingerprinted: [] });
        }
    });

    it("have no night: it is retired, kept only in the stored scores", () => {
        expect(RETIRED_MOODS).toEqual(["night"]);
        expect(LIVE_MOODS).not.toContain("night");
        expect(MOODS).toContain("night");
    });
});

describe("a mood definition", () => {
    const parse = (entry: unknown) => () => parseDefinitions({ focus: entry });

    it("is refused when it reads a mood that is itself defined, itself included", () => {
        expect(() => parseDefinitions({ focus: { calm: 1 }, calm: { instrumental: 1 } })).toThrow(/itself defined/);
        expect(parse({ focus: 1 })).toThrow(/itself defined/);
        // Its own raw head score is the allowed way in.
        expect(parse({ "head:focus": 0.2, instrumental: 0.5 })()).toBeDefined();
    });

    it("is refused for a retired mood, an unknown part, a bad weight or a part named twice", () => {
        expect(() => parseDefinitions({ night: { calm: 1 } })).toThrow(/not a mood a definition can rebuild/);
        expect(parse({ night: 1 })).toThrow(/unknown part night/);
        expect(parse({ tempo: 1 })).toThrow(/unknown part/);
        expect(parse({ calm: 0 })).toThrow(/positive weight/);
        expect(parse({ calm: "1" })).toThrow(/positive weight/);
        expect(parse({})).toThrow(/no parts/);
    });

    it("reads low: parts as negative weights", () => {
        const driving = DEFINITIONS.get("driving")!;
        expect(driving.parts).toContainEqual({ kind: "reading", reading: "instrumental", weight: -0.25 });
        expect(driving.parts).toContainEqual({ kind: "pace", weight: 0.25 });
    });
});

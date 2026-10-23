/**
 * The mood weights loader takes the shipped file whole and refuses any file that is missing a mood, a weight or a
 * bias, holds one that is not a finite number, or lists the moods in another order.
 */
import moodHeads from "../moodHeads.json";
import { MOODS, MOOD_HEADS, parseMoodHeads } from "../heads";

type RawFile = { version: unknown; model: unknown; dims: unknown; order: unknown; moods: Record<string, Record<string, unknown>> };

/** A deep copy of the shipped file, with `edit` applied. */
function file(edit: (raw: RawFile) => void = () => {}): RawFile {
    const raw = JSON.parse(JSON.stringify(moodHeads)) as RawFile;
    edit(raw);
    return raw;
}

describe("the mood weights", () => {
    it("loads all 22 moods in the file's order, each with 512 weights and a bias", () => {
        expect(MOOD_HEADS.version).toBe(moodHeads.version);
        expect(MOOD_HEADS.model).toBe("laion-clap-music-onnx-v1");
        expect(MOOD_HEADS.dims).toBe(512);
        expect(Object.keys(MOOD_HEADS.heads)).toEqual([...MOODS]);
        expect(moodHeads.order).toEqual([...MOODS]);
        for (const mood of MOODS) {
            expect(MOOD_HEADS.heads[mood].weights).toEqual(moodHeads.moods[mood].w);
            expect(MOOD_HEADS.heads[mood].bias).toBe(moodHeads.moods[mood].b);
        }
    });

    it.each<[string, (raw: RawFile) => void, RegExp]>([
        ["no version", (raw) => { raw.version = ""; }, /no version/],
        ["no model", (raw) => { delete (raw as Partial<RawFile>).model; }, /no model/],
        ["no dims", (raw) => { raw.dims = "512"; }, /no dims/],
        ["a mood missing from the order", (raw) => { raw.order = (raw.order as string[]).slice(1); }, /order must be/],
        ["the order shuffled", (raw) => { raw.order = [...(raw.order as string[])].reverse(); }, /order must be/],
        ["a mood missing", (raw) => { delete raw.moods.sleep; }, /sleep is missing/],
        ["a mood outside the order", (raw) => { raw.moods.spooky = raw.moods.dark; }, /outside the order: spooky/],
        ["a weight short", (raw) => { (raw.moods.calm.w as number[]).pop(); }, /calm needs 512 weights/],
        ["a weight that is not a number", (raw) => { (raw.moods.calm.w as unknown[])[3] = "0.1"; }, /calm has a weight/],
        ["an infinite weight", (raw) => { (raw.moods.calm.w as number[])[3] = Infinity; }, /calm has a weight/],
        ["a missing weight", (raw) => { (raw.moods.calm.w as unknown[])[3] = null; }, /calm has a weight/],
        ["no bias", (raw) => { delete raw.moods.happy.b; }, /happy has no finite bias/],
        ["a NaN bias", (raw) => { raw.moods.happy.b = NaN; }, /happy has no finite bias/],
    ])("refuses a file with %s", (_what, edit, message) => {
        expect(() => parseMoodHeads(file(edit))).toThrow(message);
    });
});

/**
 * `nameKeySql` (the fold the listens module finds a kept play's song by, in the database) folds names as `nameKey` (the
 * fold in code) does. Real database; no mocks.
 *
 * Three differences are by design or by the database, and asserted here as such:
 * - a name with no letters or digits has no `nameKey` ("") but keeps itself in SQL, so a kept "!!!" finds "!!!" and not
 *   every other symbol-only name;
 * - SQL composes decomposed text first only on a UTF8 database (Postgres can do that on no other, and the suite's is not
 *   one; nameKeySqlUtf8.integration.test.ts runs the fold on one), so here a letter that only exists composed folds apart
 *   from its decomposed form, while `nameKey` joins them;
 * - a database with a C ctype (the all-in-one image's, and the suite's) cannot tell a letter outside ASCII from a symbol,
 *   so the fold removes only what it knows is punctuation or space and keeps every other letter. A name in another
 *   script keeps its own letters there, and keeps its case (`lower` does not fold them), so "Би-2" and "би-2" are two
 *   keys. That can only miss a match, never make a false one. A UTF8 database with a real locale folds those scripts
 *   as `nameKey` does.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../../../utils/db";
import { nameKey } from "../../nameFold";
import { nameKeySql } from "../listens";

const sqlKeys = async (names: string[]): Promise<string[]> => {
    const rows = await prisma.$queryRaw<Array<{ ord: number; k: string }>>(Prisma.sql`
        SELECT v.ord::int AS ord, ${nameKeySql("v.name")} AS k
        FROM unnest(${names}::text[]) WITH ORDINALITY AS v(name, ord)
        ORDER BY v.ord`);
    return rows.map((r) => r.k);
};

/** Whether this database counts a letter outside ASCII as a letter. */
const countsWideLetters = async (): Promise<boolean> => {
    const [row] = await prisma.$queryRaw<Array<{ wide: boolean }>>`SELECT 'й' ~ '[[:alnum:]]' AS wide`;
    return row.wide;
};

describe("nameKeySql", () => {
    it.each([
        ["accents", ["Sigur Rós", "Sigur Ros", "SIGUR RÓS", "Beyoncé", "Beyonce"]],
        ["case", ["Daft Punk", "DAFT PUNK", "daft punk", "dAfT pUnK"]],
        ["punctuation and spaces", ["AC/DC", "AC-DC", "A.C. D.C.", "  ac dc  ", "Guns N' Roses", "Guns N Roses"]],
        ["apostrophe variants", ["Don't Stop", "Don’t Stop", "Don‘t Stop", "Don`t Stop", "Dont Stop", "Don´t Stop"]],
        ["sharp s and ligatures", ["Straße", "STRASSE", "Æon Flux", "Aeon Flux"]],
        ["digits", ["Blink-182", "blink 182", "2Pac", "2 pac"]],
        ["decomposed accents", ["Sigur Rós", "Béyoncé", "Sigur Rós"]],
    ])("folds %s as nameKey does", async (_label, names) => {
        expect(await sqlKeys(names)).toEqual(names.map((n) => nameKey(n)));
    });

    it("folds every variant of a name to one key, as nameKey does", async () => {
        const names = ["Don't Stop", "Don’t Stop", "DON`T STOP", " dont  stop "];

        expect(new Set(await sqlKeys(names)).size).toBe(1);
        expect(new Set(names.map(nameKey)).size).toBe(1);
    });

    it("keeps a name with no letters or digits as itself, where nameKey has no key for it", async () => {
        const names = ["!!!", "???", "™", "♫♫"];

        expect(await sqlKeys(names)).toEqual(names);
        expect(names.map(nameKey)).toEqual(["", "", "", ""]);
    });

    it("keeps an empty name empty", async () => {
        expect(await sqlKeys([""])).toEqual([""]);
        expect(nameKey("")).toBe("");
    });

    it("never folds two names that differ in letters of another script to one key", async () => {
        const [bi2, di2, bi2Lower] = await sqlKeys(["Би-2", "Ди-2", "би 2"]);

        expect(bi2).not.toBe(di2);
        expect(bi2).toMatch(/^[Бб]и2$/);
        expect(di2).toMatch(/^[Дд]и2$/);
        expect(bi2Lower).toMatch(/^[Бб]и2$/);
    });

    it("keeps the letters of other scripts and drops the spaces and punctuation between them", async () => {
        const names = ["宇多田ヒカル", "宇多田 ヒカル", "宇多田・ヒカル", "Привет, мир", "Привет\u00a0мир"];

        const [plain, spaced, dotted, ru, ruNbsp] = await sqlKeys(names);

        expect(plain).toBe("宇多田ヒカル");
        expect(spaced).toBe(plain);
        expect(dotted).toBe(plain);
        expect(ru).toBe(ruNbsp);
        expect(ru).toMatch(/^[Пп]ривет[Мм]ир$/);
    });

    it("takes out a listed mark whole and never the bytes it shares with other letters", async () => {
        // "Р" ends in the byte a no-break space ends in and "р" in a byte the bullet contains; a character-set strip would eat them.
        const [a, b, c] = await sqlKeys(["Рим\u00a0\u00b7р\u2022", "Рим р", "Рим\u200d\ufeff\u2029р"]);

        expect(a).toBe(b);
        expect(c).toBe(b);
        expect(a).toMatch(/^[Рр]им[Рр]$/);
    });

    it("folds names in other scripts as nameKey does where the database counts and cases their letters", async () => {
        // Asserts only where the database has a real locale (the suite's has none); the tests above hold on any.
        if (!(await countsWideLetters())) return;
        const names = ["宇多田ヒカル", "宇多田 ヒカル", "Би-2", "би 2"];

        expect(await sqlKeys(names)).toEqual(names.map((n) => nameKey(n)));
    });

    it("composes a decomposed letter that has no unaccented form as nameKey does on a UTF8 database, and not on any other", async () => {
        // The composing is `normalize`, which Postgres runs on a UTF8 database only (nameKeySqlUtf8.integration.test.ts).
        const [{ encoding }] = await prisma.$queryRaw<Array<{ encoding: string }>>`SELECT current_setting('server_encoding') AS encoding`;
        const composed = "Ай";
        const decomposed = "Ай";

        expect(nameKey(decomposed)).toBe(nameKey(composed));
        const [sqlComposed, sqlDecomposed] = await sqlKeys([composed, decomposed]);
        if (encoding === "UTF8") expect(sqlDecomposed).toBe(sqlComposed);
        else expect(sqlDecomposed).not.toBe(sqlComposed);
    });
});

describe("nameKeySql and full-width punctuation", () => {
    // CJK and full-width punctuation that `unaccent` leaves alone and a C-ctype `[:punct:]` cannot see.
    const PUNCTUATION: Array<[number, number]> = [
        [0x3001, 0x3003], [0x3008, 0x3011], [0x3014, 0x301f], [0xff01, 0xff0f], [0xff1a, 0xff20], [0xff3b, 0xff40], [0xff5b, 0xff65],
    ];
    // Full-width digits and letters are letters of their script, so they stay.
    const LETTERS: Array<[number, number]> = [[0xff10, 0xff19], [0xff21, 0xff3a], [0xff41, 0xff5a]];
    const chars = (ranges: Array<[number, number]>) =>
        ranges.flatMap(([from, to]) => Array.from({ length: to - from + 1 }, (_, i) => String.fromCodePoint(from + i)));
    const hex = (c: string) => c.codePointAt(0)!.toString(16);

    it("drops every CJK and full-width punctuation mark between letters, as nameKey does", async () => {
        const marks = chars(PUNCTUATION);
        const keys = await sqlKeys(marks.map((m) => `a${m}b`));

        expect(marks.filter((_, i) => keys[i] !== "ab").map(hex)).toEqual([]);
        expect(marks.filter((m) => nameKey(`a${m}b`) !== "ab").map(hex)).toEqual([]);
    });

    it("joins one name written with and without them", async () => {
        const [plain, spaced, quoted] = await sqlKeys(["宇多田ヒカル", "宇多田、ヒカル", "「宇多田」ヒカル！"]);

        expect(plain).toBe("宇多田ヒカル");
        expect(spaced).toBe(plain);
        expect(quoted).toBe(plain);
    });

    it("keeps full-width letters and digits, as nameKey does", async () => {
        const letters = chars(LETTERS);
        const keys = await sqlKeys(letters.map((l) => `a${l}b`));

        expect(letters.filter((_, i) => keys[i] === "ab").map(hex)).toEqual([]);
        expect(keys).toEqual(letters.map((l) => nameKey(`a${l}b`)));
    });
});

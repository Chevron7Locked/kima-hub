/**
 * `nameKeySql` (the fold the listens module finds a kept play's song by, in the database) folds names as `nameKey` (the
 * fold in code) does. Real database; no mocks.
 *
 * Three differences are by design or by the database, and asserted here as such:
 * - a name with no letters or digits has no `nameKey` ("") but keeps itself in SQL, so a kept "!!!" finds "!!!" and not
 *   every other symbol-only name;
 * - SQL does not compose decomposed text first (Postgres can only do that on a UTF8 database, and this must run on any),
 *   so a letter that only exists composed folds apart from its decomposed form there, while `nameKey` joins them;
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

    it("does not compose a decomposed letter that has no unaccented form, where nameKey does", async () => {
        const composed = "Ай";
        const decomposed = "Ай";

        expect(nameKey(decomposed)).toBe(nameKey(composed));
        const [sqlComposed, sqlDecomposed] = await sqlKeys([composed, decomposed]);
        expect(sqlDecomposed).not.toBe(sqlComposed);
    });
});

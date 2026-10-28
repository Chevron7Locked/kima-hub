/**
 * The one name fold: Postgres lower(unaccent()) as the stored artist and album keys use it, letters and digits of every
 * script kept. Every matcher that compares names reads it, so a name written two ways is one name everywhere, and two
 * different names written outside English letters are never one.
 */

jest.mock("../../utils/db", () => ({ prisma: {} }));

import { nameKey, nameWords } from "../nameFold";
import { albumIdentityKey } from "../albumIdentity";
import { artistIdentityKey } from "../artistIdentity";
import { sameName } from "../discovery/discoverEvidence";

describe("nameKey", () => {
    it.each([
        ["Sigur Rós", "sigurros"],
        ["AC/DC", "acdc"],
        ["Don’t Stop", "dontstop"],
        ["Straße", "strasse"],
        ["Ænima", "aenima"],
        ["Œuvre", "oeuvre"],
        ["Łódź", "lodz"],
        ["ﬁve", "five"],
        ["Ｆｕｌｌｗｉｄｔｈ", "fullwidth"],
        ["éte", "ete"],
        ["  The  Band ", "theband"],
        ["dead_mau5", "deadmau5"],
        ["Мумий Тролль", "мумийтролль"],
        ["Ёлка", "елка"],
        ["आशा भोसले", "आशाभोसले"],
        ["หนึ่ง", "หนึง"],
        ["宇多田ヒカル", "宇多田ヒカル"],
        ["Ελληνικά", "ελληνικα"],
        ["İstanbul", "istanbul"],
        ["!!!", ""],
        [null, ""],
    ])("%j -> %j", (name, key) => {
        expect(nameKey(name)).toBe(key);
    });

    it("is the stored album key, and the stored artist key wherever a name has no '&', for text in its usual form", () => {
        for (const name of ["Sigur Rós", "Straße", "Мумий Тролль", "आशा भोसले", "©", "  The  Band ", "Foo™", "X²", "㌔", "Ｆｕｌｌ", "ｱｲｳ", "Ⅻ", "½"]) {
            expect(nameKey(name)).toBe(albumIdentityKey(name));
            expect(nameKey(name)).toBe(artistIdentityKey(name));
        }
    });
});

describe("text in another Unicode form folds to the same key", () => {
    it.each([
        ["한국", "한국".normalize("NFD")],
        ["が", "が".normalize("NFD")],
        ["Café", "Cafe\u0301"],
        ["Ｒｏｃｋ", "Rock"],
        ["Album™", "Album"],
    ])("%j and %j", (a, b) => {
        expect(nameKey(a)).toBe(nameKey(b));
        expect(nameWords(a)).toBe(nameWords(b));
    });

    it("keeps superscript digits out of the key, as the stored keys do", () => {
        expect(nameKey("Vol²")).not.toBe(nameKey("Vol2"));
    });

    it("keeps a composed kana distinct from the bare kana", () => {
        expect(nameKey("が".normalize("NFD"))).not.toBe(nameKey("か"));
    });
});

describe("nameWords", () => {
    it.each([
        ["Sigur Rós", "sigur ros"],
        ["Don’t Stop", "dont stop"],
        ["Beyoncé & Jay-Z", "beyonce jayz"],
        ["  The  Band ", "the band"],
        ["Мумий Тролль", "мумий тролль"],
        ["आशा भोसले", "आशा भोसले"],
        ["Straße", "strasse"],
        ["Hello\u00A0World", "hello world"],
        ["Hello\u202FWorld", "hello world"],
        ["Hello\uFEFFWorld", "hello world"],
        ["!!!", ""],
    ])("%j -> %j", (name, words) => {
        expect(nameWords(name)).toBe(words);
    });
});

describe("Discover's same-name check", () => {
    it("matches a name written with or without ß, Æ or a Latin accent", () => {
        expect(sameName("Straße", "Strasse")).toBe(true);
        expect(sameName("Ænima", "Aenima")).toBe(true);
        expect(sameName("Sigur Rós", "sigur ros")).toBe(true);
    });

    it("keeps different Hindi, Thai and Russian names apart", () => {
        expect(sameName("आशा", "आश")).toBe(false);
        expect(sameName("หนึ่ง", "หนง")).toBe(false);
        expect(sameName("Мой", "Мои")).toBe(false);
    });
});

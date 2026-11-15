/**
 * What "lossless" means for a codec, written once (`utils/audioCodec.ts`): the library sweep chooses the better copy of a
 * song in SQL and the Subsonic listing estimates a bitrate in TypeScript, and both must call the same codecs lossless.
 * The codec strings are those the scanner stores (`metadata.format.codec`), and the mime types a client or an older
 * row may carry. Real suite database, so the SQL is judged by Postgres itself.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { isLosslessCodec, losslessCodecSql } from "../audioCodec";

const LOSSLESS = [
    "FLAC", "flac", "ALAC", "PCM", "WavPack", "Monkey's Audio", "APE", "TTA", "DSD", "DSD64", "Lossless", "WAV", "AIFF",
    "audio/flac", "audio/x-flac", "audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave", "audio/aiff", "audio/x-aiff",
    "MPEG 4 Audio (ALAC)", "FLAC (Free Lossless Audio Codec)",
];
const LOSSY = [
    "MPEG 1 Layer 3", "MPEG 2 Layer 3", "AAC", "MPEG-4/AAC", "Opus", "Vorbis", "OGG", "WMA", "audio/mpeg", "audio/mp3",
    "audio/mp4", "audio/aac", "audio/ogg", "audio/opus", "Musepack", "AC-3", "", "unknown", "capella", "leapfrog", "grape",
];

describe("isLosslessCodec", () => {
    it.each(LOSSLESS)("%s is lossless", (codec) => expect(isLosslessCodec(codec)).toBe(true));
    it.each(LOSSY)("%s is not", (codec) => expect(isLosslessCodec(codec)).toBe(false));
    it("a song with no codec stored is not", () => {
        expect(isLosslessCodec(null)).toBe(false);
        expect(isLosslessCodec(undefined)).toBe(false);
    });
});

describe("losslessCodecSql", () => {
    afterAll(() => prisma.$disconnect());

    it("agrees with isLosslessCodec on every codec string, as the database judges them", async () => {
        const codecs = [...LOSSLESS, ...LOSSY];
        const rows = await prisma.$queryRaw<Array<{ codec: string; lossless: boolean }>>`
            SELECT c.codec, (${losslessCodecSql(Prisma.sql`c.codec`)}) AS lossless
              FROM unnest(${codecs}::text[]) AS c(codec)`;
        expect(rows.map((r) => [r.codec, r.lossless])).toEqual(expect.arrayContaining(codecs.map((c) => [c, isLosslessCodec(c)])));
        expect(rows).toHaveLength(codecs.length);
    });

    it("answers false, not null, for a song with no codec stored", async () => {
        const [row] = await prisma.$queryRaw<Array<{ lossless: boolean | null }>>`
            SELECT (${losslessCodecSql(Prisma.sql`${null}::text`)}) AS lossless`;
        expect(row.lossless).toBe(false);
    });
});

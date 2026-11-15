/**
 * Which codecs are lossless, the one place it is written. A song's `Track.mime` holds the codec string the scanner read
 * (`metadata.format.codec`: "FLAC", "ALAC", "PCM", "MPEG 1 Layer 3"), or a mime type such as "audio/flac" on an older row.
 *
 * Two readers ask: the library sweep prefers a lossless copy of a song in SQL (`losslessCodecSql`), and the Subsonic
 * listing estimates a bitrate in TypeScript (`isLosslessCodec`). Both match the same names as whole words, so "ape" is
 * Monkey's Audio and "grape" is not, and they can never disagree.
 */
import { Prisma } from "@prisma/client";

/** The names a lossless codec goes by, in lower case: each is a whole word in the stored string. */
export const LOSSLESS_CODECS = ["flac", "alac", "pcm", "wavpack", "ape", "monkey", "tta", "dsd", "lossless", "wav", "aiff"] as const;

/** The pattern both readers use: a name between two non-letters (or an end), whatever the case. */
const LOSSLESS_PATTERN = `(^|[^a-z])(${LOSSLESS_CODECS.join("|")})([^a-z]|$)`;
const LOSSLESS_RE = new RegExp(LOSSLESS_PATTERN, "i");

/** Whether a stored codec string names a lossless codec. A song with none stored is not. */
export function isLosslessCodec(codec: string | null | undefined): boolean {
    return codec ? LOSSLESS_RE.test(codec) : false;
}

/** `isLosslessCodec` for raw SQL, on a column or other text expression; false (never null) when there is no codec. */
export function losslessCodecSql(codec: Prisma.Sql): Prisma.Sql {
    return Prisma.sql`COALESCE((${codec}) ~* ${LOSSLESS_PATTERN}, false)`;
}

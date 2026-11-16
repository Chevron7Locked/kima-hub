/**
 * The enrichment offer's song rule, written once: a song on a library album whose file is there (`missingSince`
 * unset) is owed its questions.
 *
 * It is the playable-song rule (utils/playableSong.ts) without the corruption test. A corrupt song stays owed: its
 * questions are offered again for a retry and may close as a permanent failure, which a playable-only rule would hide
 * from the offer, the pending counts and the one-at-a-time check. A Discover song is never owed anything: a like moves
 * its album to the library and it is due from then. A song whose file is gone is not owed until a scan finds the file.
 */
import { Prisma } from "@prisma/client";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The rule as a raw-SQL condition on a song, given the name the query uses for the song's table (`"Track"` or an
 * alias). The album needs no join: the condition looks it up itself.
 */
export function ownedSongSql(song: string): Prisma.Sql {
    if (!IDENTIFIER.test(song)) throw new Error(`ownedSongSql: "${song}" is not a table name or alias`);
    return Prisma.raw(
        `"${song}"."missingSince" IS NULL AND EXISTS (SELECT 1 FROM "Album" owned_album WHERE owned_album.id = "${song}"."albumId" AND owned_album.location = 'LIBRARY')`,
    );
}

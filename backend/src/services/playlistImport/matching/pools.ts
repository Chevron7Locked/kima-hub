import { prisma, Prisma } from "../../../utils/db";
import { PLAYABLE_SONG, playableSongSql } from "../../../utils/playableSong";
import { artistIdentityKey, isArtistNamed, normalizeArtistName, parseCredit } from "../../artistIdentity";
import { containsSql, hasNonAscii } from "../../textMatch";
import { toMatchCandidates, type MatchCandidate } from "../../trackMatching";

/**
 * Playable songs whose artist's name begins with one of `words` (the candidate pool both import paths match against).
 * `normalizedName` is stored already folded to lower case, and `words` are normalized the same way, so a plain
 * comparison is exact for every script.
 */
export async function tracksOfArtistsStartingWith(words: string[], shownArtists: ShownArtists): Promise<Prisma.TrackWhereInput> {
  const shown = shownArtists.startingWith(words);
  return {
    AND: [
      PLAYABLE_SONG,
      {
        album: {
          artist: {
            OR: [
              ...words.flatMap((w) => [{ normalizedName: w }, { normalizedName: { startsWith: `${w} ` } }]),
              ...(shown.length > 0 ? [{ id: { in: shown } }] : []),
            ],
          },
        },
      },
    ],
  };
}

/** The first word of an artist name as the import normalizes it: the key its candidate pools are indexed by. */
export const firstArtistWord = (name: string): string => normalizeArtistName(name).split(" ")[0];

/**
 * Match candidates indexed by the first word of the artist name each carries (the one in the file or the one shown),
 * for fast lookup of the pool an entry's artist selects.
 */
export function candidatesByArtistFirstWord(tracks: Parameters<typeof toMatchCandidates>[0][]): Map<string, MatchCandidate[]> {
  const byWord = new Map<string, MatchCandidate[]>();
  for (const track of tracks) {
    for (const candidate of toMatchCandidates(track)) {
      const word = firstArtistWord(candidate.artistName);
      const existing = byWord.get(word) || [];
      existing.push(candidate);
      byWord.set(word, existing);
    }
  }
  return byWord;
}

/**
 * The shortest word the primary artist's first-word sweep and the five-letter prefix sweep look up, the shortest word the
 * M3U fuzzy tier looks an artist up by (see `artistLookupWord`), and the shortest file name the M3U filename tier tries:
 * shorter ones are too common to mean anything. The credit sweep has no minimum, so a credit like "DJ Shadow" still
 * finds its artist; it matches whole words only, and it runs only when the three sweeps before it found nothing.
 */
export const MIN_WORD_LENGTH = 3;

/** A normalized artist name without its leading "the" ("the beatles" is "beatles"); a name that is only "the" is kept. */
export const withoutLeadingThe = (name: string): string => name.replace(/^the\s+/, "") || name;

/**
 * The word the M3U fuzzy tier looks an artist up by: the longest word of the entry's primary artist (the first of
 * equals), with a leading "the" dropped, so "The Beatles" looks for "beatles" and not for every artist whose name has
 * "the". When every word is shorter than MIN_WORD_LENGTH the whole name is the key ("U2", "Bo Xx"), which finds the
 * artists holding those words together ("&" counts as the word "and" there, as it is stored). "" when the name has
 * nothing to look up.
 */
export function artistLookupWord(artistName: string): string {
  const withoutThe = withoutLeadingThe(normalizeArtistName(parseCredit(artistName).primary || artistName));
  const words = withoutThe.split(" ").filter(Boolean);
  // normalizeArtistName writes "&" as "and": the joining word is never the artist's word to look up.
  const longest = words.reduce((best, word) => (word !== "and" && word.length > best.length ? word : best), "");
  return longest.length >= MIN_WORD_LENGTH ? longest : words.join(" ");
}

/** Songs loaded per query when the artists a word finds have many: a query carries at most this many ids. */
const SONG_CHUNK_MAX = 10_000;

/**
 * Every playable song, in id order, of the artists whose `normalizedName` holds `word` as a whole word, anywhere in the
 * name, and of the artists `shownIds` names (those whose shown name holds it; ShownArtists.holding). This is the pool for
 * a source credit stored under a compound name ("artist a feat. b", "artist/other", "artist, other", "(artist)",
 * "x/artist"). A word ends at any character that is not a letter or a digit, and at the ends of the name. A whole word,
 * not a substring, so a common word ("the") finds the artists that have it and not every name with those letters
 * inside. `normalizedName` keeps punctuation, so the match is a regular expression built from the escaped word.
 * One query joins the match to the playable songs and returns their ids, so the number of artists never reaches a
 * query's bind-parameter limit (the shown ids travel as one array). The songs are then loaded in chunks of `chunkSize`
 * ids (SONG_CHUNK_MAX; a test passes a small one), in id order. "Letter" follows the database's character classes:
 * where they know only ASCII (a C locale, SQL_ASCII), every accented or non-Latin letter counts as a boundary, so such
 * names are offered more often, never less; the matcher narrows the pool afterwards.
 */
export async function songsOfArtistsHoldingWord<I extends Prisma.TrackInclude>(
  word: string,
  include: I,
  shownIds: string[],
  chunkSize: number = SONG_CHUNK_MAX,
): Promise<Prisma.TrackGetPayload<{ include: I }>[]> {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = `(^|[^[:alnum:]])${escaped}($|[^[:alnum:]])`;
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT t.id FROM "Track" t
    JOIN "Album" al ON al.id = t."albumId"
    JOIN "Artist" ar ON ar.id = al."artistId"
    WHERE (ar."normalizedName" ~ ${pattern} OR ar.id = ANY(${shownIds}::text[])) AND ${playableSongSql("t", "al")}
    ORDER BY t.id`;
  const songs: Prisma.TrackGetPayload<{ include: I }>[] = [];
  for (let from = 0; from < ids.length; from += chunkSize) {
    const chunk = ids.slice(from, from + chunkSize).map((r) => r.id);
    songs.push(...(await prisma.track.findMany({ where: { id: { in: chunk } }, include, orderBy: { id: "asc" } })));
  }
  return songs;
}

/**
 * Every playable song of the artists `artist` selects, in id order, so the matcher reads the whole pool and the same
 * song wins whatever order the rows were stored in. The title check, not a row cap, decides the match: a cap would
 * drop the right song of an artist with many songs.
 */
export const SONGS_OF_ARTISTS = (artist: Prisma.ArtistWhereInput) =>
  ({ where: { AND: [PLAYABLE_SONG, { album: { artist } }] }, orderBy: { id: "asc" } }) satisfies Prisma.TrackFindManyArgs;

/**
 * The artists a person renamed (their `displayName`), each with its shown name normalized, read in one query. There is no
 * stored normalized form of a shown name, and the edited are few, so an import loads them once and every track it matches
 * asks this list. A song of an artist so named is offered to the matcher under the shown name too (trackMatching
 * `toMatchCandidates`), and these ids find the songs to offer.
 */
export class ShownArtists {
  private constructor(private readonly shown: { id: string; name: string; displayName: string; identityKey: string }[]) {}

  static async load(): Promise<ShownArtists> {
    const edited = await prisma.artist.findMany({ where: { displayName: { not: null } }, select: { id: true, displayName: true } });
    return new ShownArtists(
      edited.flatMap((a) =>
        a.displayName
          ? [{ id: a.id, name: normalizeArtistName(a.displayName), displayName: a.displayName, identityKey: artistIdentityKey(a.displayName) }]
          : [],
      ),
    );
  }

  /** Ids of the artists whose shown name is the one `name` names, by the rule `artistNamed` selects the stored name with. */
  named(name: string): string[] {
    return this.shown.filter((a) => isArtistNamed({ name: a.displayName, identityKey: a.identityKey }, name)).map((a) => a.id);
  }

  /** Ids of the artists shown as one of `names` (normalized). */
  as(names: string[]): string[] {
    return this.shown.filter((a) => names.includes(a.name)).map((a) => a.id);
  }

  /** Ids of the artists whose shown name is, or begins with the word, one of `words` (normalized). */
  startingWith(words: string[]): string[] {
    return this.shown.filter((a) => words.some((w) => a.name === w || a.name.startsWith(`${w} `))).map((a) => a.id);
  }

  /**
   * Ids of the artists whose shown name holds `word` (normalized) as a whole word, read like the stored-name match. The
   * database's "letter" is its locale's; here it is any Unicode letter or digit, so under a C locale this offers fewer
   * non-ASCII names than the stored-name match does.
   */
  holding(word: string): string[] {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const whole = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "u");
    return this.shown.filter((a) => whole.test(a.name)).map((a) => a.id);
  }

  /** Ids of the artists whose shown name begins with `prefix` (normalized). */
  beginningWith(prefix: string): string[] {
    return this.shown.filter((a) => a.name.startsWith(prefix)).map((a) => a.id);
  }
}

/** What one read found, kept by its key; with a limit, the oldest keys are dropped once there are more than it. */
export class Remembered<V> {
  private readonly found = new Map<string, V>();
  constructor(private readonly limit = Infinity) {}

  async get(key: string, load: () => Promise<V>): Promise<V> {
    if (this.found.has(key)) return this.found.get(key) as V;
    const value = await load();
    this.found.set(key, value);
    if (this.found.size > this.limit) this.found.delete(this.found.keys().next().value as string);
    return value;
  }
}


/** The most title-only candidates one lookup reads. */
const TITLE_CANDIDATES_MAX = 500;

/**
 * Playable songs whose title, as in the file or as shown, holds one of `terms`, in any letter case. The database folds case for ASCII only, so a
 * term with a non-ASCII letter is matched with a case-blind pattern (foldedPattern), at most the candidate limit of ids,
 * counted among playable songs only so songs that cannot play never use up the places.
 */
export async function tracksTitledLike<I extends Prisma.TrackInclude>(terms: string[], include: I) {
  const asciiTerms = terms.filter((t) => !hasNonAscii(t));
  const otherTerms = terms.filter(hasNonAscii);
  const titleMatches: Prisma.TrackWhereInput[] = asciiTerms.flatMap((term) => [
    { title: { contains: term, mode: "insensitive" as const } },
    { displayTitle: { contains: term, mode: "insensitive" as const } },
  ]);
  if (otherTerms.length > 0) {
    const ids = new Set<string>();
    for (const term of otherTerms) {
      const rows = await prisma.$queryRaw<{ id: string }[]>`
        SELECT t.id FROM "Track" t JOIN "Album" a ON a.id = t."albumId"
        WHERE ${containsSql([Prisma.sql`t.title`, Prisma.sql`t."displayTitle"`], term)} AND ${playableSongSql("t", "a")}
        ORDER BY t.id LIMIT ${TITLE_CANDIDATES_MAX}`;
      for (const row of rows) ids.add(row.id);
    }
    titleMatches.push({ id: { in: [...ids].slice(0, TITLE_CANDIDATES_MAX) } });
  }
  return prisma.track.findMany({ where: { AND: [PLAYABLE_SONG, { OR: titleMatches }] }, include, orderBy: { id: "asc" }, take: TITLE_CANDIDATES_MAX });
}

/** Titles this short ("Intro", "Home") are too common to match without the artist. */
export const MIN_TITLE_ONLY_LENGTH = 10;

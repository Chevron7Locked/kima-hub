import { ShownArtists, Remembered, MIN_WORD_LENGTH, artistLookupWord, songsOfArtistsHoldingWord, withoutLeadingThe } from "./pools";
import type { M3UEntry } from "../reading";
import { caseSpellings, libraryFileNames, libraryPathReadings, longestSuffixMatches, unicodeForms } from "./m3uPaths";
import { config } from "../../../config";
import path from "path";
import * as fuzz from "fuzzball";
import { prisma } from "../../../utils/db";
import { PLAYABLE_SONG, playableSongSql } from "../../../utils/playableSong";
import { artistIdentityKey, artistNamed, isArtistNamed, normalizeArtistName, parseCredit } from "../../artistIdentity";
import { sameName } from "../../discovery/discoverEvidence";
import { titleWordsForScoring } from "../../../utils/normalization";
import { nameWords } from "../../nameFold";

/** The most first-word sweeps (each loads every song of the artists holding the word) one import keeps. */
const WORD_SWEEPS_KEPT = 16;

/**
 * What one M3U import has read from the library, so an entry that asks what an earlier entry asked does not read it
 * again: an artist's songs (tier 3), the songs of a file name (tier 2), the songs of the artists holding a word (tier 4)
 * and the song a path names (tier 1). It lives as long as the import and is never shared with another.
 */
class M3UReads {
  private readonly fileName = new Remembered<
    {
      id: string;
      filePath: string;
      title: string;
      displayTitle: string | null;
      album: { artist: { name: string; identityKey: string; displayName: string | null } };
    }[]
  >();
  readonly ofArtist = new Remembered<{ id: string; title: string; displayTitle: string | null }[]>();
  readonly holdingWord = new Remembered<Awaited<ReturnType<typeof songsOfArtistsHoldingWord<{ album: { include: { artist: { select: { name: true; displayName: true } } } } }>>>>(WORD_SWEEPS_KEPT);
  private readonly path = new Remembered<{ id: string } | null>();
  private caseBlindPaths: Promise<{ plain: Map<string, string>; folded: Map<string, string> }> | null = null;

  /** `everyReading` is every library path any entry of the import may stand for (libraryPathReadings of each). */
  constructor(private readonly everyReading: string[]) {}

  /**
   * The id of the playable song at each path any entry may stand for, by the path in lower case (`plain`) and by the
   * path in lower case and composed Unicode form (`folded`), read once for the import and only when an exact path first
   * misses: no index serves a case-blind compare, so one scan stands in for a scan per entry, and what it keeps is
   * bounded by the playlist, not the library. Ids come in order and the first of a key keeps it. The database cannot
   * normalise text (installs run on SQL_ASCII), so it is asked for each path in both Unicode forms and the keys are
   * folded here.
   */
  private caseBlind(): Promise<{ plain: Map<string, string>; folded: Map<string, string> }> {
    this.caseBlindPaths ??= (async () => {
      const lowered = [...new Set(this.everyReading.flatMap((r) => [r, ...unicodeForms(r)]).flatMap((r) => [r.toLowerCase(), ...caseSpellings(r)]))];
      const songs = await prisma.$queryRaw<{ id: string; filePath: string }[]>`
        SELECT t.id, t."filePath" FROM "Track" t
        JOIN "Album" al ON al.id = t."albumId"
        WHERE lower(t."filePath") = ANY(${lowered}::text[]) AND ${playableSongSql("t", "al")}
        ORDER BY t.id`;
      const plain = new Map<string, string>();
      const folded = new Map<string, string>();
      for (const song of songs) {
        const key = song.filePath.toLowerCase();
        if (!plain.has(key)) plain.set(key, song.id);
        const foldedKey = foldedForm(song.filePath);
        if (!folded.has(foldedKey)) folded.set(foldedKey, song.id);
      }
      return { plain, folded };
    })();
    return this.caseBlindPaths;
  }

  /**
   * The playable song one of `readings` (library paths, most literal first) names, the first of these that does:
   * a reading as written, a reading with the case of letters ignored, a reading in the other Unicode form (a Mac writes
   * accented names decomposed, a Linux library stores them composed), then that with the case ignored too. A path stands
   * for the same song to every entry that holds it, so the answer is kept by the readings.
   */
  pathMatch(readings: string[]): Promise<{ id: string } | null> {
    return this.path.get(readings.join("\n"), async () => {
      const otherForms = [...new Set(readings.flatMap(unicodeForms))].filter((form) => !readings.includes(form));
      const found = await prisma.track.findMany({
        where: { AND: [PLAYABLE_SONG, { filePath: { in: [...readings, ...otherForms] } }] },
        select: { id: true, filePath: true },
        orderBy: { id: "asc" },
      });
      const exact = (paths: string[]) => {
        for (const reading of paths) {
          const hit = found.find((t) => t.filePath === reading);
          if (hit) return { id: hit.id };
        }
        return null;
      };
      const asWritten = exact(readings);
      if (asWritten) return asWritten;
      // The exact paths missed: the same paths with a letter's case ignored (a library kept on a case-sensitive disk and
      // a playlist written on a case-insensitive one). The first reading that names a song so wins; of songs whose paths
      // differ by case alone, the lowest id.
      const { plain, folded } = await this.caseBlind();
      for (const reading of readings) {
        const id = plain.get(reading.toLowerCase());
        if (id) return { id };
      }
      const otherForm = exact(otherForms);
      if (otherForm) return otherForm;
      for (const reading of readings) {
        const id = folded.get(foldedForm(reading));
        if (id) return { id };
      }
      return null;
    });
  }

  /**
   * The playable songs whose file is named `name` (the last part of the path, or the whole path of a song at the music
   * root, which has no folder), in id order, the case of letters and the
   * Unicode form ignored. The database matches the name loosely (its own case-blind compare folds ASCII only, and a
   * wildcard in a name reaches further than it should) and the file names are compared here, so only a real match stays.
   * The same name in another case or form is one read.
   */
  songsNamed(name: string) {
    const folded = foldedForm(name);
    return this.fileName.get(folded, async () => {
      // A song at the music root has no folder: its whole path is the name.
      const spellings = [...new Set([name, ...unicodeForms(name)].flatMap((n) => [n, ...caseSpellings(n)]))];
      const named = spellings.flatMap((n) => [
        { filePath: { endsWith: `/${n}`, mode: "insensitive" as const } },
        { filePath: { equals: n, mode: "insensitive" as const } },
      ]);
      const songs = await prisma.track.findMany({
        where: { AND: [PLAYABLE_SONG, { OR: named }] },
        select: {
          id: true,
          filePath: true,
          title: true,
          displayTitle: true,
          album: { select: { artist: { select: { name: true, identityKey: true, displayName: true } } } },
        },
        orderBy: { id: "asc" },
      });
      return songs.filter((song) => foldedForm(song.filePath) === folded || foldedForm(song.filePath).endsWith(`/${folded}`));
    });
  }
}

/** `text` with the case of letters and the Unicode form ignored: two paths that name the same file to a player fold alike. */
const foldedForm = (text: string): string => text.normalize("NFC").toLowerCase();

/** Whether `shownName`, an artist's edited name, is the artist `name` names: the rule `isArtistNamed` applies to the stored name. */
const isShownAs = (shownName: string, name: string): boolean =>
  isArtistNamed({ name: shownName, identityKey: artistIdentityKey(shownName) }, name);

/** Whether `artist` is the artist `name` names, by its stored name or its edited one. */
const isByArtistNamed = (artist: { name: string; identityKey: string; displayName: string | null }, name: string): boolean =>
  isArtistNamed(artist, name) || (!!artist.displayName && isShownAs(artist.displayName, name));

/** Whether a song is titled `title`, by its stored title or its edited one. */
const isTitled = (song: { title: string; displayTitle: string | null }, title: string): boolean =>
  sameName(song.title, title) || (!!song.displayTitle && sameName(song.displayTitle, title));

/** The lowest artist score tier 4 accepts, whatever the title scores: the artist must be the one the entry names. */
const ARTIST_SCORE_FLOOR = 80;

/**
 * What separates credited artists in a name beyond what `parseCredit` splits: "&", "and", ", ", and a slash or plus
 * sign with spaces or with at least three letters or digits on each side ("Hall/Oates"; "AC/DC" stays one name).
 */
const CREDIT_SEPARATORS = /\s*&\s*|\s+and\s+|\s*,\s+|\s+[/+]\s+|(?<=[\p{L}\p{N}]{3})[/+](?=[\p{L}\p{N}]{3})/iu;

/** An artist name as the words that tell it from another, for scoring: no case, accents, punctuation or leading "the". */
const artistWordsForScoring = (name: string): string => {
  return nameWords(withoutLeadingThe(normalizeArtistName(name)));
};

/**
 * The names a credit stands for, as scoring words: the whole credit, the artists `parseCredit` splits out of it
 * (primary and featured), and each of those cut at the separators above. "Jay-Z feat. Kanye West" is also "Jay-Z" and
 * "Kanye West"; "Simon & Garfunkel" is also "Simon" and "Garfunkel". A slash or plus sign between short words stays in
 * the name ("AC/DC"). Entry and library names are cut alike, so an entry naming one of the artists matches.
 */
const creditWords = (credit: string): string[] => {
  const { primary, featured } = parseCredit(credit);
  const names = [credit, primary, ...featured].flatMap((name) => [name, ...name.split(CREDIT_SEPARATORS)]);
  return [...new Set(names.map(artistWordsForScoring).filter(Boolean))];
};

/**
 * The best fuzzy score of the artist credit whose words are `entryWords` (creditWords of the entry's artist) against
 * the names given (a stored name and its edited one; a missing one counts for nothing), 0 when there is none. The best
 * of every entry credit against every credit of the name. `read` keeps the credit words of a name, so a name shared by
 * many songs is split once.
 *
 * Words in any order (token_sort_ratio), not subset (token_set_ratio): the subset score is 100 whenever one name's
 * words all appear in the other, so "Queen" took "Queen Latifah", "Pink" took "Pink Floyd" and "Kate Bush" took "Bush".
 * Measured 2026-11-15 on 19 true pairs (with "the", case, accents, punctuation, credits) and 16 wrong ones ("Queen" /
 * "Queen Latifah", "Pink" / "Pink Floyd", "Bush" / "Kate Bush", "Prince" / "Prince Royce", ...), counting what reaches
 * 80 combined with an exact title (artist >= 50) and with a title of 80 (artist >= 80):
 *
 *   scoring                                     true >=50  true >=80  wrong >=50  wrong >=80
 *   token_set_ratio (before)                      19/19      19/19      15/16       10/16
 *   token_sort_ratio, whole name                  17/19      16/19      11/16        0/16
 *   token_sort_ratio + credits by parseCredit     18/19      18/19      11/16        0/16
 *   token_sort_ratio + credits + & and , / +      19/19      19/19      11/16        0/16
 *
 * parseCredit never splits "&", so "Jay-Z" / "Jay-Z & Kanye West" (100 before, 35 after) needed the extra separators.
 * The wrong pairs top out at 70 ("Genesis" / "Genesis Owusu"), but at 56 an exact title still reaches 80 combined
 * (0.6 * 100 + 0.4 * 56 = 82), so the artist also has its own floor (ARTIST_SCORE_FLOOR).
 */
const bestArtistScore = (entryWords: string[], names: (string | null)[], read: Map<string, string[]>): number =>
  Math.max(
    0,
    ...names.flatMap((name) => {
      if (!name) return [];
      let words = read.get(name);
      if (!words) read.set(name, (words = creditWords(name)));
      return entryWords.flatMap((entryName) => words.map((libraryName) => fuzz.token_sort_ratio(entryName, libraryName)));
    }),
  );

/**
 * The best fuzzy score of the title `text` against the titles given (a stored one and its edited one; a missing one
 * counts for nothing), 0 when there is none.
 *
 * Words in any order (token_sort_ratio), not subset (token_set_ratio): the subset score is 100 whenever one title's
 * words all appear in the other, so "Love" took "Love Me Do". Measured 2026-11-15 on 14 true pairs ("Hey Jude" /
 * "Hey Jude (Remastered 2015)", "Mr Brightside" / "Mr. Brightside", ...) and 14 wrong ones ("Love" / "Love Me Do",
 * "Help" / "Help Me Rhonda", "One" / "One More Time", ...): token_set_ratio passed 14/14 true and 14/14 wrong;
 * token_sort_ratio over normalizeTrackTitle passed 12/14 true and 0/14 wrong, the wrong ones topping out at 64
 * ("Yesterday" / "Yesterday Once More"). With an exact artist a song needs a title score of 66.7 to reach 80 combined.
 * The two true misses were featured credits ("Stan" / "Stan (feat. Dido)" 44, "Get Lucky" / "Get Lucky (feat. Pharrell
 * ...)" 33), so the credit is taken off both sides first.
 */
const bestTitleScore = (text: string, titles: (string | null)[]): number => {
  const words = titleWordsForScoring(text);
  return Math.max(0, ...titles.flatMap((title) => (title ? [fuzz.token_sort_ratio(words, titleWordsForScoring(title))] : [])));
};

/**
 * The library song each entry of an M3U file names, in the file's order (null for an entry with none), matched by file
 * path, then file name, then exact artist and title, then fuzzy metadata (0.6 title + 0.4 artist >= 80; see
 * bestTitleScore). The metadata tiers read the name a person edited an artist or song to as well as the stored one.
 */
export async function matchM3UEntries(entries: M3UEntry[]): Promise<Array<{ id: string } | null>> {
  const musicRoot = config.music.musicPath;
  const found: Array<{ id: string } | null> = [];
  const shownArtists = await ShownArtists.load();
  const readingsOf = entries.map((entry) => libraryPathReadings(entry.filePath, musicRoot));
  const reads = new M3UReads(readingsOf.flat());

  for (const [at, entry] of entries.entries()) {
    let track: { id: string } | null = null;

    // Tier 1: File path match
    // The library stores paths relative to the music folder ("Artist/Album/track.flac"); an M3U path is read the way
    // a music player reads it (see libraryPathReadings), then matched exactly, then by case alone.
    track = await reads.pathMatch(readingsOf[at]);

    // Tier 2: Filename match (the name as typed, then as a player reads it: see libraryFileNames), the case of letters
    // and the Unicode form ignored; a file of the name in exactly the case written comes before one in another case.
    // A file name alone is weak (many folders hold "01 - intro.mp3"): when the entry names an artist or a title, the
    // file's must agree, each compared as tier 3 compares it, by the stored or the edited name. An entry naming both
    // needs both to agree; one naming a single field needs that one; a bare entry has nothing to disagree with.
    // Of the songs that agree, the one sharing the most trailing folders with the entry's path wins, as Navidrome
    // picks it (longestSuffixMatches); of equally long hits, the one in exactly the case written wins. Every reading
    // of the file name is tried, the name as typed first: the first to name exactly one song is taken. The entry is
    // skipped as ambiguous only when some reading names several songs and none names exactly one (the lowest id
    // would be a guess), and no later tier guesses for it either.
    let ambiguous = false;
    const agrees = (t: { title: string; displayTitle: string | null; album: { artist: { name: string; identityKey: string; displayName: string | null } } }) =>
      (!entry.title || isTitled(t, entry.title)) && (!entry.artist || isByArtistNamed(t.album.artist, entry.artist));
    if (!track) {
      let namedSeveral = false;
      for (const fileName of libraryFileNames(entry.filePath, readingsOf[at])) {
        if (path.basename(fileName, path.extname(fileName)).length < MIN_WORD_LENGTH) continue;
        const agreeing = (await reads.songsNamed(fileName)).filter(agrees);
        const longest = longestSuffixMatches(agreeing, readingsOf[at]);
        const exactCase = longest.filter((t) => t.filePath === fileName || t.filePath.endsWith(`/${fileName}`));
        const best = longest.length > 1 && exactCase.length === 1 ? exactCase : longest;
        if (best.length > 1) namedSeveral = true;
        else if (best.length === 1) {
          track = best[0];
          break;
        }
      }
      ambiguous = !track && namedSeveral;
    }

    // Tier 3: Exact metadata match (artist + title from EXTINF)
    if (!track && !ambiguous && entry.artist && entry.title) {
      // The artist by its stored identity key, or by id when its edited name is the one named; the title by nameKey,
      // stored or edited: both fold case and accents in TypeScript.
      const entryTitle = entry.title;
      const entryArtist = entry.artist;
      const shownAs = shownArtists.named(entry.artist);
      const ofArtist = await reads.ofArtist.get(entry.artist, () =>
        prisma.track.findMany({
          where: {
            AND: [
              PLAYABLE_SONG,
              { album: { artist: { OR: [artistNamed(entryArtist), ...(shownAs.length > 0 ? [{ id: { in: shownAs } }] : [])] } } },
            ],
          },
          select: { id: true, title: true, displayTitle: true },
          orderBy: { id: "asc" },
        }),
      );
      track = ofArtist.find((t) => isTitled(t, entryTitle)) ?? null;
    }

    // Tier 4: Fuzzy metadata match (fuzzball >= 80 threshold)
    if (!track && !ambiguous && entry.artist && entry.title) {
      const dbArtist = normalizeArtistName(entry.artist);
      // The pool is the artists holding the entry's longest word (artistLookupWord), so "U2" and "Bo Burnham" reach
      // this tier and "The Beatles" does not pull in every artist whose name has "the"; the scores below decide.
      const lookupWord = artistLookupWord(entry.artist);
      if (lookupWord) {
        const candidates = await reads.holdingWord.get(lookupWord, () =>
          songsOfArtistsHoldingWord(
            lookupWord,
            { album: { include: { artist: { select: { name: true, displayName: true } } } } },
            shownArtists.holding(lookupWord),
          ),
        );

        let bestMatch: { id: string } | null = null;
        let bestScore = 0;
        let bestIsExact = false;
        const entryArtistWords = creditWords(entry.artist);
        const creditsRead = new Map<string, string[]>();

        // A tie goes to the song whose artist is the one named (not merely holding the same words), then to the
        // lowest id: the candidates come in id order, so the first of equals stays.
        for (const candidate of candidates) {
          // The title or artist name a person edited counts as well as the stored one.
          const titleScore = bestTitleScore(entry.title, [candidate.title, candidate.displayTitle]);
          const artistScore = bestArtistScore(entryArtistWords, [candidate.album.artist.name, candidate.album.artist.displayName], creditsRead);
          if (artistScore < ARTIST_SCORE_FLOOR) continue;
          const combined = titleScore * 0.6 + artistScore * 0.4;
          if (combined < 80) continue;
          const isExact = [candidate.album.artist.name, candidate.album.artist.displayName].some((n) => n && normalizeArtistName(n) === dbArtist);
          const tied = Math.abs(combined - bestScore) < 1e-9;
          if (combined > bestScore + 1e-9 || (tied && isExact && !bestIsExact)) {
            bestScore = combined;
            bestIsExact = isExact;
            bestMatch = { id: candidate.id };
          }
        }

        track = bestMatch;
      }
    }

    found.push(track);
  }
  return found;
}

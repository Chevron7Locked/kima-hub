/**
 * Matching a listed song (a title and an artist, as a source wrote them) to a playable song in the library. One ladder
 * for every caller that has no better key: the songs of the listed artist first, then, for a title long enough to be
 * distinctive, the songs of any artist with that title (compilations, Various Artists). The verdicts themselves come
 * from services/trackMatching; this module decides which songs are put in front of it.
 */
import { prisma } from "../../../utils/db";
import { stripTrackSuffix, normalizeTrackTitle } from "../../../utils/normalization";
import { matchTrackToLibrary, toMatchCandidates, type MatchCandidate, type MatchResult } from "../../trackMatching";
import { ShownArtists, candidatesByArtistFirstWord, firstArtistWord, tracksOfArtistsStartingWith, tracksTitledLike, MIN_TITLE_ONLY_LENGTH } from "./pools";

export interface Listing {
  title: string;
  artist: string;
}

/** A verdict, and which rung gave it. */
export interface EntryMatch extends MatchResult {
  via: "artist" | "title";
}

/** The songs of the artists some listings name, read once for all of them. */
export interface ArtistPool {
  of(artist: string): MatchCandidate[];
}

const ARTIST_OF_SONG = { album: { include: { artist: { select: { name: true, displayName: true } } } } };

export async function loadArtistPool(listings: Listing[]): Promise<ArtistPool> {
  const words = [...new Set(listings.map((l) => firstArtistWord(l.artist)))];
  if (words.length === 0) return { of: () => [] };
  const songs = await prisma.track.findMany({
    where: await tracksOfArtistsStartingWith(words, await ShownArtists.load()),
    include: ARTIST_OF_SONG,
  });
  const byWord = candidatesByArtistFirstWord(songs);
  return { of: (artist) => byWord.get(firstArtistWord(artist)) ?? [] };
}

/** Short titles ("Home", "Intro") name too many songs to be matched without an artist. */
const mayMatchByTitle = (listing: Listing): boolean => normalizeTrackTitle(listing.title).length >= MIN_TITLE_ONLY_LENGTH;

/** What one title-only read searches for: the first words of the title, its edition suffix dropped. */
const titleTerm = (listing: Listing): string => stripTrackSuffix(listing.title).split(" ").slice(0, 4).join(" ");

const byArtist = (listing: Listing, pool: ArtistPool): EntryMatch | null => {
  const match = matchTrackToLibrary(listing, pool.of(listing.artist));
  return match && { ...match, via: "artist" };
};

const byTitle = (listing: Listing, songs: MatchCandidate[]): EntryMatch | null => {
  const match = matchTrackToLibrary(listing, songs, { requireArtistMatch: false });
  return match && { ...match, via: "title" };
};

const titledLike = async (listings: Listing[]): Promise<MatchCandidate[]> =>
  (await tracksTitledLike(listings.map(titleTerm), ARTIST_OF_SONG)).flatMap(toMatchCandidates);

/** One listing against a pool: its artist's songs, then, if that finds nothing, its own read by title. */
export async function matchEntry(listing: Listing, pool: ArtistPool): Promise<EntryMatch | null> {
  const viaArtist = byArtist(listing, pool);
  if (viaArtist || !mayMatchByTitle(listing)) return viaArtist;
  return byTitle(listing, await titledLike([listing]));
}

/**
 * Every listing, in order, with its verdict (null for none). The artists' songs are read once. The title-only read is
 * where the two callers differ, because its candidate cap applies per read: "together" reads the leftovers' titles in
 * one search that shares the cap (an import building its playlist), "each" reads once per leftover so that no listing's
 * candidates are crowded out by another's (refreshing the entries a playlist is still waiting for).
 */
export async function matchEntries(listings: Listing[], { titleReads }: { titleReads: "together" | "each" }): Promise<Array<EntryMatch | null>> {
  const pool = await loadArtistPool(listings);

  if (titleReads === "each") {
    const matches: Array<EntryMatch | null> = [];
    for (const listing of listings) matches.push(await matchEntry(listing, pool));
    return matches;
  }

  const matches = listings.map((listing) => byArtist(listing, pool));
  const leftovers = listings.filter((listing, at) => !matches[at] && mayMatchByTitle(listing));
  if (leftovers.length === 0) return matches;
  const songs = await titledLike(leftovers);
  return listings.map((listing, at) => matches[at] ?? (mayMatchByTitle(listing) ? byTitle(listing, songs) : null));
}

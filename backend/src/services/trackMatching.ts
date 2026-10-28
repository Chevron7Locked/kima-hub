/**
 * The one track-matching ladder, used by the import preview, playlist build and
 * the reconcile sweep. It is pure: each caller supplies its own candidate pool.
 * ISRC matches are exact lookups the callers do themselves.
 */

import {
  normalizeApostrophes,
  stripTrackSuffix,
  normalizeTrackTitle,
  normalizeAlbumForMatching,
  stringSimilarity,
} from "../utils/normalization";
import { normalizeArtistName } from "./artistIdentity";
import { parseCredit } from "./artistIdentity";

/** The record being searched for (a Spotify track, or its stored pending row). */
export interface SourceTrack {
  title: string;
  /** Full credit string, e.g. "Artist feat. Someone". */
  artist: string;
  /** Album title; "Unknown Album" or missing means no album hint. */
  album?: string;
}

/** A library track a source could match. Only matching-relevant fields. */
export interface MatchCandidate {
  id: string;
  title: string;
  albumId: string;
  albumTitle: string;
  artistName: string;
}

export interface MatchResult {
  candidate: MatchCandidate;
  matchType: "exact" | "fuzzy";
  /** 0-100. */
  confidence: number;
}

/**
 * Match one source track against a pool; the first strategy that hits wins.
 * `requireArtistMatch` (default true) keeps exact, containment and prefix
 * matches to the same artist; without it a bare title must match exactly or at
 * similarity >= 85. The weighted title/artist blends scan the whole pool.
 */
export function matchTrackToLibrary(
  source: SourceTrack,
  candidates: MatchCandidate[],
  opts: { requireArtistMatch?: boolean } = {},
): MatchResult | null {
  if (candidates.length === 0) return null;

  const requireArtistMatch = opts.requireArtistMatch !== false;
  const primaryArtist = parseCredit(source.artist).primary || source.artist;
  const normPrimary = normalizeArtistName(primaryArtist);
  const normFull = normalizeArtistName(source.artist);
  const artistMatches = (c: MatchCandidate): boolean => {
    const key = normalizeArtistName(c.artistName);
    return key === normPrimary || key === normFull;
  };
  const strictPool = requireArtistMatch
    ? candidates.filter(artistMatches)
    : candidates;

  // Precompute the source's title forms once. A title with no letters or digits folds to nothing and matches only
  // its own text.
  const strippedTitle = stripTrackSuffix(source.title);
  const cleanedTitle = normalizeTrackTitle(source.title);
  const rawTitleLower = normalizeApostrophes(source.title).toLowerCase();
  const sameTitle = (c: MatchCandidate): boolean =>
    normalizeApostrophes(c.title).toLowerCase() === rawTitleLower ||
    (cleanedTitle !== "" && normalizeTrackTitle(c.title) === cleanedTitle);

  const albumUnknown = !source.album || source.album === "Unknown Album";
  const sourceAlbum = normalizeAlbumForMatching(source.album ?? "").toLowerCase();
  const albumAgrees = (c: MatchCandidate): boolean => {
    if (albumUnknown) return true;
    const dbAlbum = normalizeAlbumForMatching(c.albumTitle).toLowerCase();
    return (
      dbAlbum === sourceAlbum ||
      dbAlbum.includes(sourceAlbum) ||
      sourceAlbum.includes(dbAlbum)
    );
  };

  // 1. Exact title (raw or suffix-stripped). Album decides 100 vs 85:
  //    an album-having source matched on an album-disagreeing candidate is
  //    still an exact title hit, but only "probable".
  let titleWithoutAlbumAgreement: MatchCandidate | null = null;
  for (const c of strictPool) {
    if (!sameTitle(c)) continue;
    if (albumAgrees(c)) {
      return {
        candidate: c,
        matchType: "exact",
        confidence: albumUnknown ? 90 : 100,
      };
    }
    if (!titleWithoutAlbumAgreement) titleWithoutAlbumAgreement = c;
  }
  if (titleWithoutAlbumAgreement) {
    return {
      candidate: titleWithoutAlbumAgreement,
      matchType: "exact",
      confidence: 85,
    };
  }

  // 2. Normalized containment: "Sordid Affair" matches
  //    "Sordid Affair (Feat. Ryan James)". Confidence is the measured
  //    similarity, floored at 80 because containment is strong evidence.
  for (const c of cleanedTitle === "" ? [] : strictPool) {
    const cNorm = normalizeTrackTitle(c.title);
    if (cNorm === "" || cNorm === cleanedTitle) continue; // strategy 1 owns the equal case
    if (cNorm.startsWith(cleanedTitle) || cleanedTitle.startsWith(cNorm)) {
      return {
        candidate: c,
        matchType: "fuzzy",
        confidence: Math.max(
          stringSimilarity(cleanedTitle, normalizeTrackTitle(c.title)),
          80,
        ),
      };
    }
  }

  // 3. First-four-words containment plus a similarity floor. Catches
  //    candidates whose extra words sit BEFORE the shared stem
  //    ("The Song" vs "Original Song Version") only when they still share
  //    ≥80 similarity.
  if (strippedTitle.length >= 5) {
    const searchTerm = strippedTitle.split(" ").slice(0, 4).join(" ").toLowerCase();
    for (const c of strictPool) {
      if (!c.title.toLowerCase().includes(searchTerm)) continue;
      const sim = stringSimilarity(
        cleanedTitle,
        normalizeTrackTitle(c.title),
      );
      if (sim >= 80) {
        return { candidate: c, matchType: "fuzzy", confidence: sim };
      }
    }
  }

  // 4. Weighted fuzzy (title 60 / artist 40) over the WHOLE pool: this is
  //    where an artist sharing only the first word can still match.
  for (const c of candidates) {
    const score =
      stringSimilarity(cleanedTitle, normalizeTrackTitle(c.title)) * 0.6 +
      stringSimilarity(normalizeArtistName(source.artist), normalizeArtistName(c.artistName)) * 0.4;
    if (score >= 70) {
      return { candidate: c, matchType: "fuzzy", confidence: Math.round(score) };
    }
  }

  // 5. Prefix containment: the candidate starts with the stripped title's
  //    first ≤20 characters (titles longer than 10), ≥70 similarity.
  if (strippedTitle.length > 10) {
    const prefix = strippedTitle.substring(0, Math.min(20, strippedTitle.length)).toLowerCase();
    for (const c of strictPool) {
      if (!c.title.toLowerCase().startsWith(prefix)) continue;
      const sim = stringSimilarity(cleanedTitle, normalizeTrackTitle(c.title));
      if (sim >= 70) {
        return { candidate: c, matchType: "fuzzy", confidence: sim };
      }
    }
  }

  // 6. Last-resort weighted fuzzy (title 70 / artist 30) ≥65 over the pool.
  let best: MatchCandidate | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    const score =
      stringSimilarity(cleanedTitle, normalizeTrackTitle(c.title)) * 0.7 +
      stringSimilarity(normalizeArtistName(source.artist), normalizeArtistName(c.artistName)) * 0.3;
    if (score > bestScore && score >= 65) {
      bestScore = score;
      best = c;
    }
  }
  if (best) {
    return { candidate: best, matchType: "fuzzy", confidence: Math.round(bestScore) };
  }

  // 7. Title-only fallback (title-contains mode only): a candidate from ANY
  //    artist whose normalized title is ≥85 similar. This is what the
  //    title-only batch search exists for; in artist-gated mode it must not
  //    fire, or a wrong artist wins.
  if (!requireArtistMatch) {
    let titleBest: MatchCandidate | null = null;
    let titleBestScore = 0;
    for (const c of candidates) {
      const sim = stringSimilarity(cleanedTitle, normalizeTrackTitle(c.title));
      if (sim > titleBestScore && sim >= 85) {
        titleBestScore = sim;
        titleBest = c;
      }
    }
    if (titleBest) {
      return { candidate: titleBest, matchType: "fuzzy", confidence: Math.round(titleBestScore) };
    }
  }

  return null;
}
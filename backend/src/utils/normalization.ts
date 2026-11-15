import { nameWords } from "../services/nameFold";

export function normalizeApostrophes(str: string): string {
  return str
    .replace(/['\u2018\u2019`\u2032\u02BC]/g, "'")
    .replace(/[\u201C\u201D]/g, '"');
}

export function stripTrackSuffix(str: string): string {
  return (
    normalizeApostrophes(str)
      .replace(
        /\s*-\s*(\d{4}\s+)?(remaster(ed)?|deluxe|bonus|single|radio edit|remix|acoustic|live|mono|stereo|version|edition|mix)\b(\s+\d{4})?(\s+(version|edition|mix))?.*$/i,
        "",
      )
      .replace(/\s*-\s*\d{4}\s*$/, "")
      .replace(
        /\s*\([^)]*(?:live at|live from|recorded at|performed at)[^)]*\)\s*/gi,
        " ",
      )
      .replace(/\s*\([^)]*remaster[^)]*\)\s*/gi, " ")
      .replace(/\s*\([^)]*(?:radio edit|radio mix|remix|acoustic|bonus track|clean|explicit|single edit|album edit|edit)\s*\)\s*/gi, " ")
      .replace(/\s*\([^)]*version[^)]*\)\s*/gi, " ")
      .replace(/\s*\([^)]*edition[^)]*\)\s*/gi, " ")
      .replace(/\s*\(\s*live\s*(\d{4})?\s*\)\s*/gi, " ")
      .replace(/\s*\[[^\]]*\]\s*/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

export function normalizeTrackTitle(str: string): string {
  return nameWords(stripTrackSuffix(str));
}

/**
 * A title without its featured-artist credit: "Stan (feat. Dido)", "Stan [ft. Dido]", "Stan - feat. Dido" and
 * "Stan feat. Dido" are "Stan". A title that is only a credit is kept whole. (The other callers' strippers also cut
 * "with", which is a word in real titles, so this one does not.)
 */
export function stripFeaturedCredit(str: string): string {
  const stripped = str
    .replace(/\s*[([]\s*(?:feat|ft|featuring)\b\.?[^)\]]*[)\]]/gi, " ")
    .replace(/\s+[-–—]\s*(?:feat|ft|featuring)\b\.?\s.*$/i, "")
    .replace(/\s+(?:feat\.?|featuring|ft\.)\s.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return stripped || str;
}

/**
 * A song title as the words that tell it from another, for scoring: no case, accents, punctuation, edition notes or
 * featured credit. A title that is only bracketed text keeps its words rather than scoring as empty.
 */
export function titleWordsForScoring(str: string): string {
  return normalizeTrackTitle(stripFeaturedCredit(str)) || nameWords(str);
}

export function normalizeAlbumForMatching(str: string): string {
  return stripTrackSuffix(str).trim();
}

// Strips leading articles on top of the track-title normalizer; keeps
// "The Beatles" and "Beatles" scoring as one artist.
export function normalizeForMatching(str: string): string {
  return normalizeTrackTitle(str.replace(/^(the|a|an)\s+/i, ""));
}

/** 0-100. A name with no letters or digits is similar only to its own text. */
export function stringSimilarity(a: string, b: string): number {
  const s1 = nameWords(a);
  const s2 = nameWords(b);

  if (s1 === "" || s2 === "") return a.trim() !== "" && a.trim() === b.trim() ? 100 : 0;
  if (s1 === s2) return 100;

  if (s1.includes(s2) || s2.includes(s1)) {
    const longer = Math.max(s1.length, s2.length);
    const shorter = Math.min(s1.length, s2.length);
    return Math.round((shorter / longer) * 100);
  }

  const words1 = new Set(s1.split(" "));
  const words2 = new Set(s2.split(" "));
  const intersection = [...words1].filter((w) => words2.has(w)).length;
  const union = new Set([...words1, ...words2]).size;

  return Math.round((intersection / union) * 100);
}

export function normalizeString(str: string): string {
  return (
    str
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\w\s]/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

export function normalizeApostrophes(str: string): string {
  return str
    .replace(/['\u2018\u2019`\u2032\u02BC]/g, "'")
    .replace(/[\u201C\u201D]/g, '"');
}

export function stripTrackSuffix(str: string): string {
  return (
    normalizeApostrophes(str)
      .replace(
        /\s*-\s*(\d{4}\s+)?(remaster(ed)?|deluxe|bonus|single|radio edit|remix|acoustic|live|mono|stereo|version|edition|mix)(\s+\d{4})?(\s+(version|edition|mix))?.*$/i,
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
  return normalizeString(stripTrackSuffix(str));
}

export function normalizeAlbumForMatching(str: string): string {
  return stripTrackSuffix(str).trim();
}

export function stringSimilarity(a: string, b: string): number {
  const s1 = normalizeString(a);
  const s2 = normalizeString(b);

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

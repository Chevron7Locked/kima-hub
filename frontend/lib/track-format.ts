/**
 * Foobar2000-style title formatting for track display.
 *
 * Supported syntax:
 *   %field%           — substitute field value (empty string if missing)
 *   [block]           — hide entire block if any %field% inside resolved empty
 *   $if2(a, b)        — return a if non-empty, else b
 *   $filepart(path)   — filename without directory or extension
 *
 * Available fields: title, artist, album, filename
 *
 * Reference: https://wiki.hydrogenaudio.org/index.php?title=Foobar2000:Title_Formatting_Reference
 */

export interface FormatTrack {
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  filename?: string | null;
}

function filepart(path: string | null | undefined): string {
  if (!path) return "";
  const base = path.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

function resolveField(name: string, track: FormatTrack): string {
  switch (name.toLowerCase()) {
    case "title":    return track.title ?? "";
    case "artist":   return track.artist ?? "";
    case "album":    return track.album ?? "";
    case "filename": return filepart(track.filename);
    default:         return "";
  }
}

function findMatchingClose(str: string, start: number, open: string, close: string): number {
  let depth = 1;
  for (let i = start; i < str.length; i++) {
    if (str[i] === open) depth++;
    else if (str[i] === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function splitAtTopLevelComma(str: string): [string, string] | null {
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === "(") depth++;
    else if (str[i] === ")") depth--;
    else if (str[i] === "," && depth === 0) {
      return [str.slice(0, i), str.slice(i + 1)];
    }
  }
  return null;
}

function evalFormat(fmt: string, track: FormatTrack): string {
  let result = "";
  let i = 0;

  while (i < fmt.length) {
    // [conditional block]
    if (fmt[i] === "[") {
      const close = findMatchingClose(fmt, i + 1, "[", "]");
      if (close === -1) { result += fmt[i++]; continue; }
      const inner = fmt.slice(i + 1, close);
      const fieldRefs = [...inner.matchAll(/%([^%]+)%/g)];
      const anyEmpty = fieldRefs.some((m) => resolveField(m[1], track) === "");
      if (!anyEmpty) result += evalFormat(inner, track);
      i = close + 1;
      continue;
    }

    // $function(...)
    if (fmt[i] === "$") {
      const fnMatch = fmt.slice(i).match(/^\$(\w+)\(/);
      if (fnMatch) {
        const bodyStart = i + fnMatch[0].length;
        const bodyEnd = findMatchingClose(fmt, bodyStart, "(", ")");
        if (bodyEnd === -1) { result += fmt[i++]; continue; }
        const body = fmt.slice(bodyStart, bodyEnd);
        const fnName = fnMatch[1].toLowerCase();

        if (fnName === "if2") {
          const parts = splitAtTopLevelComma(body);
          if (parts) {
            const a = evalFormat(parts[0].trim(), track);
            result += a !== "" ? a : evalFormat(parts[1].trim(), track);
          } else {
            result += evalFormat(body, track);
          }
        } else if (fnName === "filepart") {
          result += filepart(evalFormat(body.trim(), track));
        }

        i = bodyEnd + 1;
        continue;
      }
      result += fmt[i++];
      continue;
    }

    // %field%
    if (fmt[i] === "%") {
      const end = fmt.indexOf("%", i + 1);
      if (end === -1) { result += fmt[i++]; continue; }
      result += resolveField(fmt.slice(i + 1, end), track);
      i = end + 1;
      continue;
    }

    // literal character
    result += fmt[i++];
  }

  return result;
}

/**
 * Format a track title using a fb2k-style format string.
 * Returns track.title when format is empty/null.
 */
export function formatTrackDisplay(
  track: FormatTrack,
  format: string | null | undefined,
): string {
  if (!format?.trim()) return track.title ?? "";
  const result = evalFormat(format, track);
  return result || (track.title ?? "");
}

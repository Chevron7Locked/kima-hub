

import { posix } from "path";


/**
 * `value` with percent-escapes decoded, or `value` itself when it holds a malformed escape (a name with a stray "%").
 * An encoded slash (%2F) stays as written: a file name cannot hold a "/", so it is never a folder either, and decoding
 * it would turn one name into two path segments.
 */
export function decoded(value: string): string {
    return value
        .split(/(%2f)/i)
        .map((part, at) => {
            if (at % 2 === 1) return part;
            try {
                return decodeURIComponent(part);
            } catch {
                return part;
            }
        })
        .join("");
}

/**
 * `path` relative to the music folder `root`, or null when it is not under it: a path under `root` itself, or under the
 * conventional "/music" a container mounts it at, with `.` and `..` segments resolved. A relative path is already
 * relative. The playlist's own folder is not known (the upload carries the file's content and its name, never where it
 * lived), so leading `./` and `../` climb back toward the music folder and no further: playlists live at or under it,
 * and the library match settles whether the clamped path is real.
 */
export function underMusicFolder(path: string, root: string): string | null {
    const prefix = (root.endsWith("/") ? root : `${root}/`).toLowerCase();
    let rest: string;
    if (path.toLowerCase().startsWith(prefix)) rest = path.slice(prefix.length);
    else if (/^\/music\//i.test(path)) rest = path.replace(/^\/music\//i, "");
    else if (path.startsWith("/") || /^[a-z]:\//i.test(path)) return null;
    else rest = path;
    if (/(^|\/)\.\.?(\/|$)/.test(rest)) {
        rest = posix.normalize(rest);
        while (rest.startsWith("../")) rest = rest.slice(3);
        if (rest === ".." || rest === ".") return null;
    }
    return rest;
}

/**
 * The library paths an M3U entry's path may stand for, most literal first: the path as typed, then as a music player
 * reads it: `\` as `/`, a `file://` URI (a host such as `localhost` dropped) and percent-escapes decoded. Each reading
 * also comes relative to the music folder (library paths are stored that way) before it stands as written, so a path
 * that matched as typed keeps matching and the first of these that names a song wins.
 */
export function libraryPathReadings(filePath: string, root: string): string[] {
    const slashed = filePath.replace(/\\/g, "/");
    const readings: string[] = [filePath, slashed];
    if (/^file:\/\//i.test(slashed)) {
        const afterScheme = slashed.replace(/^file:\/\//i, "");
        // "file://localhost/x" has a host before its path; "file:///x" has none.
        const pathStart = afterScheme.indexOf("/");
        const uriPath = pathStart === -1 ? "" : afterScheme.slice(pathStart);
        // file:///C:/Music/a.flac names the drive, not a folder called "C:".
        readings.push(decoded(uriPath).replace(/^\/([a-z]:\/)/i, "$1"));
    } else {
        readings.push(decoded(slashed));
    }
    const candidates: string[] = [];
    for (const reading of readings) {
        const relative = underMusicFolder(reading, root);
        if (relative !== null) candidates.push(relative);
        candidates.push(reading);
    }
    return [...new Set(candidates)];
}

/**
 * The other Unicode form of `text` (composed or decomposed), when it has one: macOS writes accented names decomposed
 * (NFD) and Linux libraries keep them composed (NFC), and players take the two as the same name. Empty for text whose
 * two forms are alike.
 */
export function unicodeForms(text: string): string[] {
    const forms = [text.normalize("NFC"), text.normalize("NFD")];
    return forms.filter((form) => form !== text);
}

/** The most spellings `caseSpellings` gives for one text. */
export const SPELLINGS_MAX = 8;

/**
 * `text` with its ASCII letters lower-cased and each non-ASCII letter written as it is, in lower case and in upper case:
 * what Postgres's `lower()` can return for a stored name that differs from `text` by letter case alone. The database
 * runs on SQL_ASCII, where `lower()` folds ASCII letters only, so "Café" and "CAFÉ" can be told apart there and the
 * stored spelling has to be asked for. Past `SPELLINGS_MAX` spellings, only the text as written, all lower and all upper.
 */
export function caseSpellings(text: string): string[] {
    const asciiLower = (c: string) => (/[A-Z]/.test(c) ? c.toLowerCase() : c);
    let spellings = [""];
    for (const c of text) {
        const forms = /[^\x00-\x7f]/.test(c) ? [...new Set([c, c.toLowerCase(), c.toUpperCase()])] : [asciiLower(c)];
        if (spellings.length * forms.length > SPELLINGS_MAX) {
            const nonAscii = (f: (s: string) => string) => [...text].map((ch) => (/[^\x00-\x7f]/.test(ch) ? f(ch) : asciiLower(ch))).join("");
            return [...new Set([nonAscii((ch) => ch), nonAscii((ch) => ch.toLowerCase()), nonAscii((ch) => ch.toUpperCase())])];
        }
        spellings = spellings.flatMap((s) => forms.map((f) => s + f));
    }
    return spellings;
}

/**
 * The file names an M3U entry's path may stand for, most literal first: the name of the path as typed, then of each of
 * its readings (see libraryPathReadings), so a name written percent-encoded or after a `\` is the name a player reads.
 */
export function libraryFileNames(filePath: string, readings: string[]): string[] {
    return [...new Set([filePath, ...readings].map((path) => posix.basename(path)))];
}

/** A path's segments for comparing: no empty, `.` or `..` segment (a leading `/`, `./` or `../` is no folder), letter case and Unicode form ignored. */
export function segmentsOf(path: string): string[] {
    return posix
        .normalize(path)
        .split("/")
        .filter((segment) => segment !== "" && segment !== "." && segment !== "..")
        .map((segment) => segment.normalize("NFC").toLowerCase());
}

/** How many segments, counted from the file name backwards, a library path and one reading of an entry's path share. */
export function sharedTrailingSegments(libraryPath: string, reading: string): number {
    const ours = segmentsOf(libraryPath);
    const theirs = segmentsOf(reading);
    let shared = 0;
    while (shared < ours.length && shared < theirs.length && ours[ours.length - 1 - shared] === theirs[theirs.length - 1 - shared]) shared++;
    return shared;
}

/**
 * Of `songs` (all of the entry's file name), those whose library path shares the most trailing path segments with any
 * reading of the entry's path, as Navidrome picks a file for a playlist path: the longest matching suffix wins. A bare
 * file name is a path of one segment, so it shares one with every song of that name. Several songs returned are
 * equally good answers: the caller skips them rather than guess.
 */
export function longestSuffixMatches<T extends { filePath: string }>(songs: T[], readings: string[]): T[] {
    const shared = songs.map((song) => Math.max(0, ...readings.map((reading) => sharedTrailingSegments(song.filePath, reading))));
    const best = Math.max(0, ...shared);
    return best === 0 ? [] : songs.filter((_, at) => shared[at] === best);
}


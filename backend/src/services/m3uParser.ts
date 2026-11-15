import { posix } from "path";

export interface M3UEntry {
    filePath: string;
    artist: string | null;
    title: string | null;
    durationSeconds: number | null;
}

/** An M3U import in which no entry matched a playable song in the library: it makes no playlist. */
export class M3UNothingMatched extends Error {
    constructor(readonly total: number) {
        super(`none of the ${total} ${total === 1 ? "entry" : "entries"} in this file matched a song in your library`);
        this.name = "M3UNothingMatched";
    }
}

interface ParseOptions {
    maxEntries?: number;
}

export function parseM3U(content: string, options: ParseOptions = {}): M3UEntry[] {
    const { maxEntries = 10000 } = options;

    if (content.includes("\0")) {
        throw new Error("M3U content contains null bytes");
    }

    const lines = content.replace(/\r\n/g, "\n").split("\n");
    const entries: M3UEntry[] = [];
    let pendingMeta: { artist: string | null; title: string | null; duration: number | null } | null = null;

    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;

        if (line === "#EXTM3U") continue;

        if (line.startsWith("#EXTINF:")) {
            const afterHash = line.slice(8);
            const commaIdx = afterHash.indexOf(",");
            if (commaIdx === -1) continue;

            const duration = parseInt(afterHash.slice(0, commaIdx), 10);
            const display = afterHash.slice(commaIdx + 1).trim();

            const sepIdx = display.indexOf(" - ");
            if (sepIdx > 0) {
                pendingMeta = {
                    artist: display.slice(0, sepIdx).trim(),
                    title: display.slice(sepIdx + 3).trim(),
                    duration: isNaN(duration) ? null : duration,
                };
            } else {
                pendingMeta = { artist: null, title: display || null, duration: isNaN(duration) ? null : duration };
            }
            continue;
        }

        if (line.startsWith("#")) continue;

        const filePath = line.replace(/\\/g, "/");

        entries.push({
            filePath,
            artist: pendingMeta?.artist ?? null,
            title: pendingMeta?.title ?? null,
            durationSeconds: pendingMeta?.duration ?? null,
        });
        pendingMeta = null;

        if (entries.length > maxEntries) {
            throw new Error(`M3U file exceeds maximum of ${maxEntries} entries`);
        }
    }

    return entries;
}

/** `value` with percent-escapes decoded, or `value` itself when it holds a malformed escape (a name with a stray "%"). */
function decoded(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

/**
 * `path` relative to the music folder `root`, or null when it is not under it: a path under `root` itself, or under the
 * conventional "/music" a container mounts it at, with `.` and `..` segments resolved. A relative path is already
 * relative. The playlist's own folder is not known (the upload carries the file's content and its name, never where it
 * lived), so leading `./` and `../` climb back toward the music folder and no further: playlists live at or under it,
 * and the library match settles whether the clamped path is real.
 */
function underMusicFolder(path: string, root: string): string | null {
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

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
const windows1252 = new TextDecoder("windows-1252");

/**
 * An uploaded playlist file's text, read the way `.m3u` and `.m3u8` files are read: as UTF-16 when it opens with a UTF-16
 * byte order mark (what Windows Notepad's "Unicode" saves), as UTF-8 when it opens with a UTF-8 byte order mark (dropped)
 * or is valid UTF-8, otherwise as Windows-1252, the "Latin-1" every player takes it for.
 */
export function decodeM3U(bytes: Buffer): string {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return Buffer.from(bytes.subarray(2)).swap16().toString("utf16le");
    if (bytes.subarray(0, 3).equals(UTF8_BOM)) return bytes.subarray(3).toString("utf-8");
    try {
        return strictUtf8.decode(bytes);
    } catch {
        return windows1252.decode(bytes);
    }
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
const SPELLINGS_MAX = 8;

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

import { posix } from "path";

export interface M3UEntry {
    filePath: string;
    artist: string | null;
    title: string | null;
    durationSeconds: number | null;
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

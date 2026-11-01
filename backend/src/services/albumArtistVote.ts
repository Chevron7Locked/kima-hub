/**
 * Which artist an album is filed under, decided once per album rather than per song.
 *
 * Each file names a candidate: its album artist, else its track artist, else its folder. One album is the songs of
 * one album folder (disc subfolders such as "CD 2" belong to their album's folder) under one album tag; a song with
 * no album tag is an album of its own. The most common candidate wins when it covers every song, or more than one song
 * and at least a quarter of them (beets' rule). With no winner each song keeps its own artist, unless the album is
 * tagged a compilation: then it is Various Artists, as is a compilation whose songs carry no album artist
 * (Navidrome's rule). So one song tagged with a guest as album artist no longer becomes its own album.
 */
import path from "path";
import type { ICommonTagsResult } from "music-metadata";
import { albumIdentityKey } from "./albumIdentity";
import { artistIdentityKey, parseCredit } from "./artistIdentity";
import {
    canonicalizeVariousArtists,
    extractAlbumFromRelativePath,
    extractArtistFromRelativePath,
    sanitizeTagString,
} from "../utils/artistNormalization";

export const VARIOUS_ARTISTS = "Various Artists";

/** The quarter of an album's songs its most common artist must cover (beets' SINGLE_ARTIST_THRESH). */
const LEAD_SHARE = 0.25;

/** A disc subfolder of an album folder: "CD 1", "Disc 2", "Disk03", "Digital Media 02". */
const DISC_FOLDER = /^(?:cd|dis[ck]|digital media|vinyl|side)[\s._-]*\d+\b/i;

/** Characters a tag can carry that are not part of a name: byte-order marks and zero-width marks. */
const INVISIBLE = /[﻿​-‍⁠]/g;

export interface ArtistCandidate {
    name: string;
    mbid?: string;
}

export interface FileCredit {
    /** The album folder plus the album title: the songs that are one album. */
    groupKey: string;
    albumTitle: string;
    candidate: ArtistCandidate;
    /** Whether the candidate came from an album-artist tag. */
    fromAlbumArtist: boolean;
    compilation: boolean;
}

/**
 * The names an artist tag carries. A multi-valued tag gives several; one ID3 frame can hold several too, separated by
 * NUL, and the tag reader hands those over as one string, so it is split here before anything strips the NUL.
 */
export function tagValues(single: string | undefined, multi: readonly string[] | undefined): string[] {
    const raw = multi && multi.length > 1 ? multi : single != null ? [single] : multi ?? [];
    return raw
        .flatMap((value) => String(value).split("\0"))
        .map((value) => sanitizeTagString(value.replace(INVISIBLE, "")))
        .filter(Boolean);
}

/**
 * The first name of a tag with its MusicBrainz id. A tag's ids follow its credits' order, so the first id is the
 * first name's only when there is one id per credited artist, featured ones ("A feat. B") included.
 */
function firstCredited(names: string[], ids: readonly string[] | undefined): ArtistCandidate | null {
    if (names.length === 0) return null;
    const credit = parseCredit(names[0]);
    const name = credit.primary || names[0];
    const credited = names.reduce((count, each) => count + 1 + parseCredit(each).featured.length, 0);
    if (ids && ids.length === credited) return { name, mbid: ids[0] };

    // One joint name tagged with one id per artist in it ("A & B" with two ids, as MusicBrainz taggers write a
    // joint credit): the ids prove it is several artists, not one band with an "&" in its name (one id).
    if (names.length === 1 && ids && ids.length > 1) {
        const parts = names[0].split(JOINT_CREDIT).map((p) => p.trim()).filter(Boolean);
        if (parts.length === ids.length) return { name: parts[0], mbid: ids[0] };
    }
    return { name };
}

/** How a joint credit joins its artists' names. Used only when the tag's ids show how many artists it names. */
const JOINT_CREDIT = /\s*,\s*|\s*;\s*|\s+\/\s+|\s+(?:&|and|x|with|vs\.?|feat\.?|ft\.?|featuring)\s+/i;

/** The album folder a file belongs to: its own folder, or the one above when its own is a disc subfolder. */
export function albumFolder(relativePath: string): string {
    const dir = path.dirname(relativePath);
    return DISC_FOLDER.test(path.basename(dir)) ? path.dirname(dir) : dir;
}

export function albumTitleOf(common: ICommonTagsResult, relativePath: string): string {
    return sanitizeTagString(common.album) || extractAlbumFromRelativePath(relativePath) || "Unknown Album";
}

/** What one file says about its album's artist. */
export function fileCredit(common: ICommonTagsResult, relativePath: string): FileCredit {
    const albumTitle = albumTitleOf(common, relativePath);
    const albumArtist = firstCredited(tagValues(common.albumartist, common.albumartists), common.musicbrainz_albumartistid);
    const trackArtist = albumArtist ? null : firstCredited(tagValues(common.artist, common.artists), common.musicbrainz_artistid);
    let candidate: ArtistCandidate = albumArtist ?? trackArtist ?? {
        name: extractArtistFromRelativePath(relativePath) ?? "Unknown Artist",
    };

    // Soulseek downloads under Singles/ often carry compilation tags: the folder's artist beats "Various Artists".
    if (canonicalizeVariousArtists(candidate.name) === VARIOUS_ARTISTS && relativePath.startsWith("Singles/")) {
        const folderArtist = extractArtistFromRelativePath(relativePath);
        if (folderArtist && canonicalizeVariousArtists(folderArtist) !== VARIOUS_ARTISTS) candidate = { name: folderArtist };
    }

    const albumTag = sanitizeTagString(common.album);
    return {
        // A song with no album tag shares no album with its neighbours, which may be any loose files.
        groupKey: albumTag ? `${albumFolder(relativePath)}\n${albumIdentityKey(albumTag)}` : `file\n${relativePath}`,
        albumTitle,
        candidate,
        fromAlbumArtist: albumArtist !== null,
        // Under Singles/ the folder names the artist, compilation tags or not (the override above).
        compilation: Boolean(common.compilation) && !relativePath.startsWith("Singles/"),
    };
}

/** "A (feat. B)" is A: a parenthesised featured credit does not make a second artist. */
function withoutFeaturedClause(name: string): string {
    return name.replace(/\s*[(\[]\s*(?:feat\.?|ft\.?|featuring)\s[^)\]]*[)\]]\s*$/i, "");
}

/** The separators the splitter removed before 1.10 cut names at ("Coheed and Cambria" became "Coheed"). */
const OLD_CUTS = [" & ", " and ", " with ", ", "];

/** Whether `name` is `full` cut by the old splitter: its first words, up to one of those separators. */
export function isOldCut(name: string, full: string): boolean {
    const lower = full.toLowerCase();
    return OLD_CUTS.some((sep) => lower.startsWith(name.toLowerCase() + sep));
}

/** The identity keys of the names an old cut of `full` could have left ("A & B and C" gives A's and "A & B"'s). */
export function leadNameKeys(full: string): string[] {
    const keys = new Set<string>();
    const lower = full.toLowerCase();
    for (const sep of OLD_CUTS) {
        for (let at = lower.indexOf(sep); at > 0; at = lower.indexOf(sep, at + 1)) keys.add(artistIdentityKey(full.slice(0, at)));
    }
    return [...keys].filter(Boolean);
}

/**
 * Whether an album under `artist` stays there when its files name `candidate`: the artist has a MusicBrainz id, the
 * files name a joint credit with no id, and the artist's name is that credit's first words. Nothing in the tags says
 * the credit is a band, and moving the album would trade the lead's photo and id for neither. The re-file and the
 * scanner both ask this, so they agree on where such an album sits.
 */
export function keepsLeadArtist(artist: { name: string; mbid: string | null }, candidate: ArtistCandidate): boolean {
    return Boolean(artist.mbid) && !candidate.mbid && isOldCut(artist.name, candidate.name);
}

/**
 * The artist one album's songs elect, or null when none leads and each song keeps its own. `credits` are that album's
 * files, in a stable order (by path).
 */
export function electAlbumArtist(credits: readonly FileCredit[]): ArtistCandidate | null {
    const total = credits.length;
    if (total === 0) return null;
    // Tagged a compilation by most songs, and the songs really have more than one artist: a lone artist's album with
    // a stray flag is that artist's.
    const compilation =
        credits.filter((c) => c.compilation).length * 2 > total &&
        new Set(credits.map((c) => artistIdentityKey(withoutFeaturedClause(c.candidate.name)) || c.candidate.name)).size > 1;
    if (compilation && !credits.some((c) => c.fromAlbumArtist)) return { name: VARIOUS_ARTISTS };

    const votes = new Map<string, FileCredit[]>();
    for (const credit of credits) {
        const key = artistIdentityKey(credit.candidate.name) || credit.candidate.name;
        const voters = votes.get(key);
        if (voters) voters.push(credit);
        else votes.set(key, [credit]);
    }
    // Most votes first; a tie goes to the one named first.
    const [, winners] = [...votes.entries()].reduce((best, entry) => (entry[1].length > best[1].length ? entry : best));
    const share = winners.length;
    if (share !== total && !(share > 1 && share / total >= LEAD_SHARE)) return compilation ? { name: VARIOUS_ARTISTS } : null;

    const mostCommon = (values: string[]) => {
        const counts = new Map<string, number>();
        for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
        return [...counts.entries()].reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0];
    };
    const name = mostCommon(winners.map((c) => c.candidate.name));
    const ids = winners.map((c) => c.candidate.mbid).filter((id): id is string => Boolean(id));
    return ids.length > 0 ? { name, mbid: mostCommon(ids) } : { name };
}

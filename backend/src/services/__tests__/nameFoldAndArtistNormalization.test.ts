/**
 * nameKey (the shared name fold), normalizeArtistName and the artistNormalization utilities.
 */

jest.mock('../../utils/db', () => ({
    prisma: {
        artist: { findFirst: jest.fn() },
        downloadJob: { findMany: jest.fn() },
        discoveryAlbum: { findFirst: jest.fn() },
        album: { findFirst: jest.fn() },
        track: { findMany: jest.fn(), deleteMany: jest.fn(), update: jest.fn() },
        playlistItem: { findMany: jest.fn() },
        playlistPendingTrack: { upsert: jest.fn() },
    },
}));

jest.mock('../../utils/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { nameKey } from '../nameFold';
import { normalizeArtistName } from '../artistIdentity';
import {
    canonicalizeVariousArtists,
    sanitizeTagString,
    parseArtistFromPath,
    extractArtistFromRelativePath,
} from '../../utils/artistNormalization';

// ---------------------------------------------------------------------------
// nameKey: the one name fold (nameFold), as Discover's records and an album's names are compared
// ---------------------------------------------------------------------------

describe('nameKey', () => {
    it('ignores case, accents, spaces and punctuation', () => {
        expect(nameKey('  Alice  In   Chains ')).toBe(nameKey('alice in chains'));
        expect(nameKey('Café')).toBe('cafe');
        expect(nameKey('Alt\u2013J')).toBe(nameKey('alt-j'));
        expect(nameKey("It\u2019s")).toBe(nameKey("it's"));
        expect(nameKey('Tool!')).toBe('tool');
    });

    it('keeps the letters of every script, so different names in other scripts stay different', () => {
        expect(nameKey('Кино')).toBe('кино');
        expect(nameKey('米津玄師')).toBe('米津玄師');
        expect(nameKey('Кино')).not.toBe(nameKey('米津玄師'));
    });

    it('gives a name with no letters or digits no key', () => {
        expect(nameKey('!!!')).toBe('');
        expect(nameKey(null)).toBe('');
    });
});

// ---------------------------------------------------------------------------
// normalizeArtistName
// ---------------------------------------------------------------------------

describe('normalizeArtistName', () => {
    it('lowercases and strips diacritics', () => {
        expect(normalizeArtistName('Ólafur Arnalds')).toBe('olafur arnalds');
    });

    it('normalizes & to "and"', () => {
        expect(normalizeArtistName('Of Mice & Men')).toBe('of mice and men');
    });

    it('collapses multiple spaces', () => {
        expect(normalizeArtistName('The  National')).toBe('the national');
    });

    it('handles null-like input gracefully', () => {
        expect(normalizeArtistName(null as any)).toBe('');
    });

    it('handles empty string', () => {
        expect(normalizeArtistName('')).toBe('');
    });
});

// ---------------------------------------------------------------------------
// canonicalizeVariousArtists
// ---------------------------------------------------------------------------

describe('canonicalizeVariousArtists', () => {
    it('canonicalizes "VA" to "Various Artists"', () => {
        expect(canonicalizeVariousArtists('VA')).toBe('Various Artists');
    });

    it('canonicalizes "V.A." to "Various Artists"', () => {
        expect(canonicalizeVariousArtists('V.A.')).toBe('Various Artists');
    });

    it('canonicalizes "V/A" to "Various Artists"', () => {
        expect(canonicalizeVariousArtists('V/A')).toBe('Various Artists');
    });

    it('canonicalizes "Various" to "Various Artists"', () => {
        expect(canonicalizeVariousArtists('Various')).toBe('Various Artists');
    });

    it('canonicalizes "Various Artist" (singular) to "Various Artists"', () => {
        expect(canonicalizeVariousArtists('Various Artist')).toBe('Various Artists');
    });

    it('canonicalizes "<Various Artists>" (angle brackets) to "Various Artists"', () => {
        expect(canonicalizeVariousArtists('<Various Artists>')).toBe('Various Artists');
    });

    it('leaves real artist names unchanged', () => {
        expect(canonicalizeVariousArtists('Radiohead')).toBe('Radiohead');
        expect(canonicalizeVariousArtists('Vampire Weekend')).toBe('Vampire Weekend');
    });
});

// ---------------------------------------------------------------------------
// sanitizeTagString
// ---------------------------------------------------------------------------

describe('sanitizeTagString', () => {
    it('returns empty string for null', () => {
        expect(sanitizeTagString(null)).toBe('');
    });

    it('returns empty string for undefined', () => {
        expect(sanitizeTagString(undefined)).toBe('');
    });

    it('strips null bytes', () => {
        expect(sanitizeTagString('Track\x00Name')).toBe('TrackName');
    });

    it('strips ASCII control characters', () => {
        expect(sanitizeTagString('Track\x08Name')).toBe('TrackName');
    });

    it('preserves normal Unicode (accents, CJK, emoji)', () => {
        expect(sanitizeTagString('Björk')).toBe('Björk');
        expect(sanitizeTagString('音楽')).toBe('音楽');
    });

    it('trims leading and trailing whitespace', () => {
        expect(sanitizeTagString('  Track  ')).toBe('Track');
    });
});

// ---------------------------------------------------------------------------
// parseArtistFromPath
// ---------------------------------------------------------------------------

describe('parseArtistFromPath', () => {
    it('extracts artist from "Artist - Album" pattern', () => {
        expect(parseArtistFromPath('Radiohead - OK Computer')).toBe('Radiohead');
    });

    it('extracts artist from "Artist - Album (Year)" pattern', () => {
        expect(parseArtistFromPath('Tool - Lateralus (2001)')).toBe('Tool');
    });

    it('returns null for empty string', () => {
        expect(parseArtistFromPath('')).toBeNull();
    });

    it('returns null when folder name has no extractable artist', () => {
        // A bare album name with no separator
        expect(parseArtistFromPath('Unknown')).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// extractArtistFromRelativePath
// ---------------------------------------------------------------------------

describe('extractArtistFromRelativePath', () => {
    it('extracts artist from standard Artist/Album/Track.ext layout (grandparent folder)', () => {
        const result = extractArtistFromRelativePath('Radiohead/OK Computer/01 - Airbag.flac');
        expect(result).toBe('Radiohead');
    });

    it('returns null for a bare filename with no folder hierarchy', () => {
        const result = extractArtistFromRelativePath('track.mp3');
        expect(result).toBeNull();
    });
});

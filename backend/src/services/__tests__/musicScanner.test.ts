/**
 * MusicScannerService -- pure logic unit tests
 *
 * Tests the private helper methods on MusicScannerService via a thin
 * subclass that exposes them, and the exported pure utility functions
 * from artistNormalization that the scanner uses heavily.
 *
 * We do NOT test scanLibrary or processAudioFile -- those require real
 * files and a database; they belong to integration tests.
 */

// All mocks must be before imports
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

jest.mock('../../services/coverArtExtractor', () => ({
    CoverArtExtractor: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../../services/deezer', () => ({
    deezerService: {},
}));

jest.mock('../../services/artistCountsService', () => ({
    backfillAllArtistCounts: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../services/imageStorage', () => ({
    checkLocalArtistImage: jest.fn(),
}));

// music-metadata is pure ESM; provide a CJS-compatible stub
jest.mock('music-metadata', () => ({ parseFile: jest.fn() }), { virtual: true });

// p-queue is mapped to a CJS mock in jest.config.js -- no extra mock needed

import { MusicScannerService } from '../musicScanner';
import {
    normalizeArtistName,
    canonicalizeVariousArtists,
    extractPrimaryArtist,
    sanitizeTagString,
    collapseForComparison,
    parseArtistFromPath,
    extractArtistFromRelativePath,
} from '../../utils/artistNormalization';

// Expose private methods for direct testing
class TestableMusicScanner extends MusicScannerService {
    public isDiscovery(relativePath: string): boolean {
        return (this as any).isDiscoveryPath(relativePath);
    }

    public normalize(str: string): string {
        return (this as any).normalizeForMatching(str);
    }
}

const scanner = new TestableMusicScanner();

// ---------------------------------------------------------------------------
// isDiscoveryPath
// ---------------------------------------------------------------------------

describe('MusicScannerService.isDiscoveryPath', () => {
    it('returns true for paths starting with "discovery/"', () => {
        expect(scanner.isDiscovery('discovery/Artist/Album/01.flac')).toBe(true);
    });

    it('returns true for paths starting with "discover/"', () => {
        expect(scanner.isDiscovery('discover/Artist/Album/01.mp3')).toBe(true);
    });

    it('returns true for mixed-case "Discovery/" prefix', () => {
        expect(scanner.isDiscovery('Discovery/Radiohead/OK Computer/01.flac')).toBe(true);
    });

    it('returns true for mixed-case "DISCOVER/" prefix', () => {
        expect(scanner.isDiscovery('DISCOVER/Tool/Lateralus/09.flac')).toBe(true);
    });

    it('returns false for standard library paths', () => {
        expect(scanner.isDiscovery('Artist/Album/01.flac')).toBe(false);
    });

    it('returns false for paths containing "discovery" mid-string', () => {
        // "nodiscovery/" does not start with discovery/
        expect(scanner.isDiscovery('music/discovery/Artist/01.flac')).toBe(false);
    });

    it('returns false for Singles/ paths', () => {
        expect(scanner.isDiscovery('Singles/Artist - Track.mp3')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// normalizeForMatching
// ---------------------------------------------------------------------------

describe('MusicScannerService.normalizeForMatching', () => {
    it('lowercases input', () => {
        expect(scanner.normalize('Radiohead')).toBe('radiohead');
    });

    it('trims leading and trailing whitespace', () => {
        expect(scanner.normalize('  Tool  ')).toBe('tool');
    });

    it('strips diacritics (café -> cafe)', () => {
        expect(scanner.normalize('café')).toBe('cafe');
    });

    it('normalizes various dash forms to hyphen', () => {
        // em dash, en dash -> hyphen
        const result = scanner.normalize('Alt\u2013J');
        expect(result).toBe('alt-j');
    });

    it('strips unicode apostrophe forms not in the keep-set', () => {
        // U+2019 right single quote is not in the character class [''´`], so
        // it falls through to the final strip step and is removed
        expect(scanner.normalize("it\u2019s")).toBe('its');
    });

    it('collapses multiple internal spaces', () => {
        expect(scanner.normalize('Alice  In   Chains')).toBe('alice in chains');
    });

    it('removes characters outside word/space/quote/dash set', () => {
        expect(scanner.normalize('Tool!')).toBe('tool');
        expect(scanner.normalize('Artist (feat. Someone)')).toBe('artist feat someone');
    });
});

// ---------------------------------------------------------------------------
// normalizeArtistName (exported from artistNormalization, used by scanner)
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
// extractPrimaryArtist
// ---------------------------------------------------------------------------

describe('extractPrimaryArtist', () => {
    it('extracts primary from "feat." collaborations', () => {
        expect(extractPrimaryArtist('Artist A feat. Artist B')).toBe('Artist A');
    });

    it('extracts primary from "ft." collaborations', () => {
        expect(extractPrimaryArtist('Artist A ft. Artist B')).toBe('Artist A');
    });

    it('extracts primary from "featuring" collaborations', () => {
        expect(extractPrimaryArtist('Artist A featuring Artist B')).toBe('Artist A');
    });

    it('extracts primary from "x" hip-hop collaboration separator', () => {
        expect(extractPrimaryArtist('Artist A x Artist B')).toBe('Artist A');
    });

    it('preserves "Of Mice & Men" as a band name', () => {
        expect(extractPrimaryArtist('Of Mice & Men')).toBe('Of Mice & Men');
    });

    it('preserves "Earth, Wind & Fire" as a band name', () => {
        expect(extractPrimaryArtist('Earth, Wind & Fire')).toBe('Earth, Wind & Fire');
    });

    it('preserves "The Naked and Famous" as a band name', () => {
        expect(extractPrimaryArtist('The Naked and Famous')).toBe('The Naked and Famous');
    });

    it('splits "CHVRCHES & Robert Smith" as collaboration (both parts >= 2 words)', () => {
        expect(extractPrimaryArtist('CHVRCHES & Robert Smith')).toBe('CHVRCHES');
    });

    it('returns "Unknown Artist" for empty string', () => {
        expect(extractPrimaryArtist('')).toBe('Unknown Artist');
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
// collapseForComparison
// ---------------------------------------------------------------------------

describe('collapseForComparison', () => {
    it('removes all spaces from a normalized name', () => {
        expect(collapseForComparison('dead mau5')).toBe('deadmau5');
    });

    it('handles names with no spaces', () => {
        expect(collapseForComparison('radiohead')).toBe('radiohead');
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

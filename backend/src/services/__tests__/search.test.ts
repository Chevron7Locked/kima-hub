/**
 * SearchService -- queryToTsquery() unit tests
 *
 * queryToTsquery is private on SearchService, but its behavior is fully
 * observable through the public search methods which call it and fall back
 * to LIKE search when it returns an empty string.  We test the function
 * indirectly via a small subclass that exposes it, which avoids coupling
 * to the private implementation while still testing every branch.
 */

// All mocks must be before imports
jest.mock('../../utils/db', () => ({
    prisma: {
        artist: { findMany: jest.fn() },
        album: { findMany: jest.fn(), count: jest.fn() },
        track: { findMany: jest.fn() },
        podcast: { findMany: jest.fn() },
        podcastEpisode: { findMany: jest.fn() },
        audiobook: { findMany: jest.fn() },
        $queryRaw: jest.fn(),
    },
}));

jest.mock('../../utils/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../utils/redis', () => ({
    redisClient: { get: jest.fn().mockResolvedValue(null), setex: jest.fn().mockResolvedValue('OK') },
}));

import { SearchService } from '../search';

// Expose the private method for direct testing
class TestableSearchService extends SearchService {
    public tsquery(query: string): string {
        return (this as any).queryToTsquery(query);
    }
}

const svc = new TestableSearchService();

describe('SearchService.queryToTsquery', () => {
    describe('single terms', () => {
        it('converts a single word to prefix tsquery form', () => {
            expect(svc.tsquery('radiohead')).toBe('radiohead:*');
        });

        it('handles a single uppercase word', () => {
            expect(svc.tsquery('Radiohead')).toBe('Radiohead:*');
        });

        it('handles a numeric term', () => {
            expect(svc.tsquery('1984')).toBe('1984:*');
        });
    });

    describe('multi-word queries', () => {
        it('joins two terms with &', () => {
            expect(svc.tsquery('radio head')).toBe('radio:* & head:*');
        });

        it('joins three terms with & between each', () => {
            expect(svc.tsquery('alice in chains')).toBe('alice:* & in:* & chains:*');
        });

        it('collapses multiple spaces into separate terms', () => {
            expect(svc.tsquery('tool   lateralus')).toBe('tool:* & lateralus:*');
        });
    });

    describe('& operator handling', () => {
        it('converts & surrounded by spaces to "and" term', () => {
            // "of mice & men" -> "of mice and men" -> four terms
            const result = svc.tsquery('of mice & men');
            expect(result).toBe('of:* & mice:* & and:* & men:*');
        });
    });

    describe('special character stripping', () => {
        it('strips semicolons and SQL injection chars', () => {
            expect(svc.tsquery("'; DROP TABLE tracks; --")).toBe('DROP:* & TABLE:* & tracks:*');
        });

        it('strips leading/trailing punctuation from terms', () => {
            expect(svc.tsquery('!hello!')).toBe('hello:*');
        });

        it('strips parentheses', () => {
            expect(svc.tsquery('tool (band)')).toBe('tool:* & band:*');
        });

        it('strips hyphens from terms', () => {
            expect(svc.tsquery('alt-J')).toBe('altJ:*');
        });

        it('strips apostrophes from terms', () => {
            expect(svc.tsquery("it's")).toBe('its:*');
        });
    });

    describe('empty / whitespace / null-like input', () => {
        it('returns empty string for empty string', () => {
            expect(svc.tsquery('')).toBe('');
        });

        it('returns empty string for whitespace-only string', () => {
            expect(svc.tsquery('   ')).toBe('');
        });

        it('returns empty string when all chars are non-word', () => {
            // Every character is stripped, leaving no terms
            expect(svc.tsquery('!@#$%^*()')).toBe('');
        });
    });

    describe('normalizeCacheQuery', () => {
        it('lowercases and collapses whitespace', () => {
            const { normalizeCacheQuery } = require('../search');
            expect(normalizeCacheQuery('  Radio HEAD  ')).toBe('radio head');
        });

        it('handles leading and trailing spaces', () => {
            const { normalizeCacheQuery } = require('../search');
            expect(normalizeCacheQuery('  tool  ')).toBe('tool');
        });
    });
});

describe('SearchService.searchArtists', () => {
    const { prisma } = require('../../utils/db');

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('returns empty array for empty query', async () => {
        const result = await svc.searchArtists({ query: '' });
        expect(result).toEqual([]);
        expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('returns empty array for whitespace-only query', async () => {
        const result = await svc.searchArtists({ query: '   ' });
        expect(result).toEqual([]);
    });

    it('falls back to LIKE search when tsquery returns empty', async () => {
        // All-special-chars query -> empty tsquery -> fallback path
        (prisma.artist.findMany as jest.Mock).mockResolvedValue([]);
        const result = await svc.searchArtists({ query: '!!!' });
        expect(result).toEqual([]);
        expect(prisma.artist.findMany).toHaveBeenCalled();
    });

    it('uses $queryRaw for normal queries', async () => {
        const mockResult = [{ id: '1', name: 'Radiohead', mbid: null, heroUrl: null, rank: 0.8 }];
        (prisma.$queryRaw as jest.Mock).mockResolvedValue(mockResult);

        const result = await svc.searchArtists({ query: 'radiohead' });
        expect(result).toEqual(mockResult);
        expect(prisma.$queryRaw).toHaveBeenCalled();
    });

    it('falls back to LIKE search when $queryRaw throws', async () => {
        (prisma.$queryRaw as jest.Mock).mockRejectedValue(new Error('DB error'));
        (prisma.artist.findMany as jest.Mock).mockResolvedValue([]);

        const result = await svc.searchArtists({ query: 'radiohead' });
        expect(result).toEqual([]);
        expect(prisma.artist.findMany).toHaveBeenCalled();
    });
});

/**
 * SearchService.queryToTsquery, through a subclass that exposes it, and the artist search against the real database.
 */

// All mocks must be before imports
jest.mock('../../utils/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../utils/redis', () => ({
    redisClient: { get: jest.fn().mockResolvedValue(null), setex: jest.fn().mockResolvedValue('OK') },
}));

import { SearchService } from '../search';
import { prisma } from '../../utils/db';

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
    const P = 'zz-search-';

    async function wipe() {
        await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
        await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
        await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    }

    /** An artist with one playable song, so the search can offer it. */
    async function seedArtist(id: string, name: string, albumOpts: { corrupt?: boolean } = {}) {
        await prisma.artist.create({ data: { id: `${P}${id}`, name, identityKey: `${P}${id}` } });
        await prisma.album.create({
            data: { id: `${P}${id}-alb`, artistId: `${P}${id}`, title: 'Record', identityKey: `${P}${id}-alb`, rgMbid: `${P}${id}-alb`, primaryType: 'Album' },
        });
        await prisma.track.create({
            data: {
                id: `${P}${id}-t`, albumId: `${P}${id}-alb`, title: 'Song', trackNo: 1, duration: 200,
                filePath: `/tmp/${P}${id}.flac`, fileModified: new Date(), fileSize: 1000, corrupt: albumOpts.corrupt ?? false,
            },
        });
    }

    beforeAll(wipe);
    afterAll(wipe);
    beforeEach(async () => {
        jest.restoreAllMocks();
        await wipe();
    });

    it('returns empty array for empty query', async () => {
        await seedArtist('a1', 'Zzradioheadtest');
        const spy = jest.spyOn(prisma, '$queryRaw');
        expect(await svc.searchArtists({ query: '' })).toEqual([]);
        expect(spy).not.toHaveBeenCalled();
    });

    it('returns empty array for whitespace-only query', async () => {
        await seedArtist('a1', 'Zzradioheadtest');
        expect(await svc.searchArtists({ query: '   ' })).toEqual([]);
    });

    it('falls back to LIKE search when tsquery returns empty', async () => {
        // All-special-chars query -> empty tsquery -> fallback path
        await seedArtist('a1', 'zz!!! chk');
        await seedArtist('a2', 'Zzradioheadtest');

        const result = await svc.searchArtists({ query: '!!!' });

        expect(result.map((r) => r.id)).toEqual([`${P}a1`]);
        expect(result[0]).toMatchObject({ name: 'zz!!! chk', rank: 0 });
    });

    it('finds an artist by full-text search and ranks it', async () => {
        await seedArtist('a1', 'Zzradioheadtest');
        await seedArtist('a2', 'Someone Else');

        const result = await svc.searchArtists({ query: 'zzradioheadtest' });

        expect(result.map((r) => r.id)).toEqual([`${P}a1`]);
        expect(result[0]).toMatchObject({ name: 'Zzradioheadtest', mbid: null, heroUrl: null });
        expect(result[0].rank).toBeGreaterThan(0);
    });

    it('offers only artists with a playable song', async () => {
        await seedArtist('a1', 'Zzradioheadtest', { corrupt: true });

        expect(await svc.searchArtists({ query: 'zzradioheadtest' })).toEqual([]);
    });

    it('falls back to LIKE search when the full-text query throws', async () => {
        await seedArtist('a1', 'Zzradioheadtest');
        jest.spyOn(prisma, '$queryRaw').mockRejectedValueOnce(new Error('DB error'));

        const result = await svc.searchArtists({ query: 'zzradioheadtest' });

        expect(result.map((r) => r.id)).toEqual([`${P}a1`]);
        expect(result[0].rank).toBe(0);
    });

    it('falls back to LIKE search when full-text finds nothing, so a partial word still matches', async () => {
        await seedArtist('a1', 'Zzradioheadtest');

        // "adioheadte" is no prefix of any word in the name, so the full-text query finds nothing
        const result = await svc.searchArtists({ query: 'adioheadte' });

        expect(result.map((r) => r.id)).toEqual([`${P}a1`]);
    });
});

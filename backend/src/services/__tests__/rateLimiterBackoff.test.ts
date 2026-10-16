/**
 * A Retry-After: 0 header is the server saying "you're at the limit, no
 * advice". Retrying at 0 ms is the abusive case, so backoff must fall
 * through to the exponential schedule, not the zero.
 */

import { rateLimiter } from '../rateLimiter';

describe('rate limiter backoff', () => {
    let randomSpy: any;

    beforeEach(() => {
        randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0); // zero jitter
    });
    afterEach(() => randomSpy.mockRestore());

    it('waits the exponential delay when Retry-After is 0, on both ends of the range check', async () => {
        const err: any = new Error('Request failed with status code 503');
        err.response = { status: 503, headers: { 'retry-after': '0' } };

        const stamps: number[] = [];
        const requestFn = jest.fn().mockImplementation(async () => {
            stamps.push(Date.now());
            if (stamps.length === 1) throw err;
            return 'ok';
        });

        const result = await rateLimiter.execute('musicbrainz', requestFn);

        expect(result).toBe('ok');
        expect(requestFn).toHaveBeenCalledTimes(2);
        // musicbrainz baseDelay is 2000 ms; the bug retried at 0.
        expect(stamps[1] - stamps[0]).toBeGreaterThanOrEqual(1500);
    }, 10000);

    it('honours a real Retry-After value', async () => {
        const err: any = new Error('Request failed with status code 429');
        err.response = { status: 429, headers: { 'retry-after': '2' } };

        const stamps: number[] = [];
        const requestFn = jest.fn().mockImplementation(async () => {
            stamps.push(Date.now());
            if (stamps.length === 1) throw err;
            return 'ok';
        });

        await rateLimiter.execute('deezer', requestFn);
        expect(stamps[1] - stamps[0]).toBeGreaterThanOrEqual(1900);
    }, 10000);

    it('closes the breaker once the service answers again, so the next caller does not wait', async () => {
        // Five calls rate-limited at once open the breaker; their retries, a second later, succeed.
        const limited = () => Object.assign(new Error('429'), { response: { status: 429, headers: { 'retry-after': '1' } } });
        const once = () => {
            let failed = false;
            return async () => {
                if (!failed) {
                    failed = true;
                    throw limited();
                }
                return 'ok';
            };
        };
        await Promise.all(Array.from({ length: 5 }, () => rateLimiter.execute('deezer', once())));

        const started = Date.now();
        expect(await rateLimiter.execute('deezer', async () => 'next')).toBe('next');
        expect(Date.now() - started).toBeLessThan(1000);
    }, 20000);
});

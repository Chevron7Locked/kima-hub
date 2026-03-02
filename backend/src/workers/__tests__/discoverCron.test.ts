import * as fs from 'fs';
import * as path from 'path';

describe('Discover Queue Dedup', () => {
    describe('discoverCron.ts', () => {
        const source = fs.readFileSync(
            path.resolve(__dirname, '../discoverCron.ts'), 'utf-8'
        );

        it('should include jobId in discoverQueue.add call', () => {
            expect(source).toMatch(/discoverQueue\.add\([\s\S]*?jobId\s*:/);
        });

        it('should use discover-weekly prefix in jobId', () => {
            expect(source).toContain('discover-weekly-');
        });
    });

    describe('discover.ts route', () => {
        const source = fs.readFileSync(
            path.resolve(__dirname, '../../routes/discover.ts'), 'utf-8'
        );

        it('should include jobId in discoverQueue.add call', () => {
            // Find the manual trigger add call (not the scheduled one)
            const addCalls = source.match(/discoverQueue\.add\([\s\S]*?\)/g) || [];
            const hasJobId = addCalls.some(call => call.includes('jobId'));
            expect(hasJobId).toBe(true);
        });
    });
});

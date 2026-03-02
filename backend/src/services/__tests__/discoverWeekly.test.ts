import * as fs from 'fs';
import * as path from 'path';

describe('DiscoverWeekly Status Guards', () => {
    describe('discoveryAlbum upsert', () => {
        const source = fs.readFileSync(
            path.resolve(__dirname, '../discoverWeekly.ts'), 'utf-8'
        );

        it('should NOT set status in the discoveryAlbum upsert update branch', () => {
            // Find the discoveryAlbum.upsert call
            const upsertPos = source.indexOf('discoveryAlbum.upsert(');
            expect(upsertPos).toBeGreaterThan(-1);

            // Extract the upsert call region (roughly 100 lines after upsert start)
            const upsertRegion = source.slice(upsertPos, upsertPos + 2000);

            // Find the update: { block
            const updateStart = upsertRegion.indexOf('update: {');
            expect(updateStart).toBeGreaterThan(-1);

            // Find the opening brace of the update block, then match to closing
            const braceStart = upsertRegion.indexOf('{', updateStart);
            expect(braceStart).toBeGreaterThan(-1);
            let braceCount = 0;
            let updateEnd = braceStart;
            for (let i = braceStart; i < upsertRegion.length; i++) {
                if (upsertRegion[i] === '{') braceCount++;
                if (upsertRegion[i] === '}') braceCount--;
                if (braceCount === 0) { updateEnd = i; break; }
            }

            const updateBlock = upsertRegion.slice(updateStart, updateEnd + 1);

            // The update block should NOT contain a status assignment
            expect(updateBlock).not.toMatch(/status\s*:/);
        });
    });

    describe('checkBatchCompletion', () => {
        const source = fs.readFileSync(
            path.resolve(__dirname, '../discoverWeekly.ts'), 'utf-8'
        );

        it('should re-check batch status after Lidarr wait', () => {
            // Find checkBatchCompletion method
            const methodStart = source.indexOf('async checkBatchCompletion(');
            expect(methodStart).toBeGreaterThan(-1);

            const methodRegion = source.slice(methodStart, methodStart + 10000);

            // Should contain a fresh batch status re-read after the wait
            expect(methodRegion).toMatch(/freshBatch.*findUnique/s);
        });
    });
});

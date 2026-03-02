import * as fs from 'fs';
import * as path from 'path';

describe('Notification Retry Dedup', () => {
    const source = fs.readFileSync(
        path.resolve(__dirname, '../notifications.ts'), 'utf-8'
    );

    it('should check for existing active jobs before creating download jobs', () => {
        // Count dedup checks (findFirst for downloadJob with status filter)
        const dedupChecks = (source.match(/existingActiveJob.*findFirst/g) || []).length;
        // Should have at least 3 dedup checks (one per retry handler)
        expect(dedupChecks).toBeGreaterThanOrEqual(3);
    });

    it('should return deduplicated response when active job exists', () => {
        const dedupResponses = (source.match(/deduplicated:\s*true/g) || []).length;
        expect(dedupResponses).toBeGreaterThanOrEqual(3);
    });

    it('should skip dedup for retry_ prefixed targetMbids', () => {
        expect(source).toContain("startsWith('retry_')");
    });
});

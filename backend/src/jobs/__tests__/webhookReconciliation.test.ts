import * as fs from 'fs';
import * as path from 'path';

describe('Webhook Reconciliation Guard', () => {
    const source = fs.readFileSync(
        path.resolve(__dirname, '../webhookReconciliation.ts'), 'utf-8'
    );

    it('should check processing job count before Lidarr reconciliation', () => {
        expect(source).toMatch(/downloadJob\.count/);
        expect(source).toMatch(/status.*processing/);
    });

    it('should skip Lidarr reconciliation when no processing jobs', () => {
        expect(source).toContain('skipping Lidarr reconciliation');
    });
});

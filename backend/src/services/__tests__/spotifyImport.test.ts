import * as fs from 'fs';
import * as path from 'path';

describe('SpotifyImport Status Guards', () => {
    const source = fs.readFileSync(
        path.resolve(__dirname, '../spotifyImport.ts'), 'utf-8'
    );

    it('should check for cancelled status before setting downloading in processImport', () => {
        // Find the processImport method region
        const processImportStart = source.indexOf('private async processImport(');
        const processImportEnd = source.indexOf('private async ', processImportStart + 1);
        const processImportBody = source.slice(processImportStart, processImportEnd > 0 ? processImportEnd : undefined);

        // The cancel check should appear BEFORE the downloading assignment
        const cancelCheckPos = processImportBody.indexOf("job.status === \"cancelled\"");
        const downloadingPos = processImportBody.indexOf("job.status = \"downloading\"");

        expect(cancelCheckPos).toBeGreaterThan(-1);
        expect(downloadingPos).toBeGreaterThan(-1);
        expect(cancelCheckPos).toBeLessThan(downloadingPos);
    });
});

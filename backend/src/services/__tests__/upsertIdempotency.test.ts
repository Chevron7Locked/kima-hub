import * as fs from 'fs';
import * as path from 'path';

describe('Upsert Idempotency', () => {
    describe('musicScanner ownedAlbum', () => {
        const source = fs.readFileSync(
            path.resolve(__dirname, '../musicScanner.ts'), 'utf-8'
        );

        it('should use ownedAlbum.upsert instead of create', () => {
            expect(source).toContain('ownedAlbum.upsert(');
            expect(source).not.toMatch(/ownedAlbum\.create\(/);
        });
    });

    describe('audioStreaming transcodedFile', () => {
        const source = fs.readFileSync(
            path.resolve(__dirname, '../audioStreaming.ts'), 'utf-8'
        );

        it('should use transcodedFile.upsert instead of create', () => {
            expect(source).toContain('transcodedFile.upsert(');
            expect(source).not.toMatch(/transcodedFile\.create\(/);
        });
    });
});

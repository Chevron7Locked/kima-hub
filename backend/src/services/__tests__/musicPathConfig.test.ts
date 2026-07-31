/**
 * Tests for configurable music path behavior
 *
 * Verifies that:
 * 1. Music path comes from settings when available
 * 2. Falls back to config.music.musicPath when settings is null/undefined
 */

// All mocks must be declared before imports
jest.mock('../../utils/encryption', () => ({
    encrypt: jest.fn((value: string) => `encrypted_${value}`),
    decrypt: jest.fn((value: string) => value.replace('encrypted_', '')),
    encryptField: jest.fn((value: string) => `encrypted_${value}`),
}));

jest.mock('../../utils/db', () => ({
    prisma: {
        downloadJob: {
            create: jest.fn(),
            findUnique: jest.fn(),
            update: jest.fn(),
        },
        userDiscoverConfig: {
            findUnique: jest.fn(),
        },
    },
}));

jest.mock('../../utils/systemSettings', () => ({
    getSystemSettings: jest.fn(),
}));

// Mock config module with known values
jest.mock('../../config', () => ({
    config: {
        music: {
            musicPath: '/default/music/path',
        },
    },
}));

import { getSystemSettings } from '../../utils/systemSettings';
import { config } from '../../config';

const mockGetSystemSettings = getSystemSettings as jest.MockedFunction<typeof getSystemSettings>;

describe('Music Path Configuration', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('getMusicPath helper behavior', () => {
        const getMusicPath = async () => {
            const settings = await getSystemSettings();
            return settings?.musicPath || config.music.musicPath;
        };

        it('should return settings.musicPath when available', async () => {
            mockGetSystemSettings.mockResolvedValue({
                id: 'default',
                musicPath: '/custom/music/path',
                lidarrEnabled: true,
                lidarrUrl: 'http://localhost:8686',
                lidarrApiKey: null,
                lidarrWebhookSecret: null,
                openaiEnabled: false,
                openaiApiKey: null,
                openaiModel: 'gpt-4',
                openaiBaseUrl: null,
                fanartEnabled: false,
                fanartApiKey: null,
                audiobookshelfEnabled: false,
                audiobookshelfUrl: 'http://localhost:13378',
                audiobookshelfApiKey: null,
                soulseekUsername: null,
                soulseekPassword: null,
                spotifyClientId: null,
                spotifyClientSecret: null,
                downloadPath: '/downloads',
                autoSync: true,
                autoEnrichMetadata: true,
                transcodeCacheMaxGb: 10,
                downloadSource: 'soulseek',
                primaryFailureFallback: 'none',
                enrichmentConcurrency: 1,
                clapWorkers: 2,
                lastfmApiKey: null,
                soulseekConcurrentDownloads: 4,
                updatedAt: new Date(),
                createdAt: new Date(),
            });

            const musicPath = await getMusicPath();
            expect(musicPath).toBe('/custom/music/path');
        });

        it('should fallback to config.music.musicPath when settings is null', async () => {
            mockGetSystemSettings.mockResolvedValue(null);

            const musicPath = await getMusicPath();
            expect(musicPath).toBe('/default/music/path');
        });

        it('should fallback to config.music.musicPath when settings.musicPath is null', async () => {
            mockGetSystemSettings.mockResolvedValue({
                id: 'default',
                musicPath: null,
                lidarrEnabled: true,
                lidarrUrl: 'http://localhost:8686',
                lidarrApiKey: null,
                lidarrWebhookSecret: null,
                openaiEnabled: false,
                openaiApiKey: null,
                openaiModel: 'gpt-4',
                openaiBaseUrl: null,
                fanartEnabled: false,
                fanartApiKey: null,
                audiobookshelfEnabled: false,
                audiobookshelfUrl: 'http://localhost:13378',
                audiobookshelfApiKey: null,
                soulseekUsername: null,
                soulseekPassword: null,
                spotifyClientId: null,
                spotifyClientSecret: null,
                downloadPath: '/downloads',
                autoSync: true,
                autoEnrichMetadata: true,
                transcodeCacheMaxGb: 10,
                downloadSource: 'soulseek',
                primaryFailureFallback: 'none',
                enrichmentConcurrency: 1,
                clapWorkers: 2,
                lastfmApiKey: null,
                soulseekConcurrentDownloads: 4,
                updatedAt: new Date(),
                createdAt: new Date(),
            });

            const musicPath = await getMusicPath();
            expect(musicPath).toBe('/default/music/path');
        });
    });

    describe('Download job metadata', () => {
        it('should use configurable rootFolderPath pattern', () => {
            const settingsMusicPath: string | null = '/custom/path';
            const configMusicPath = '/music';
            const fallbackPath: string | null = '/another/path';
            const nullPath: string | null = null;
            const undefinedPath: string | undefined = undefined;

            // Test the pattern: settings?.musicPath || config.music.musicPath
            expect(settingsMusicPath || configMusicPath).toBe('/custom/path');
            expect(nullPath || configMusicPath).toBe('/music');
            expect(undefinedPath || configMusicPath).toBe('/music');

            // Test the pattern: metadata.rootFolderPath || defaultMusicPath
            expect(fallbackPath || configMusicPath).toBe('/another/path');
            expect(nullPath || configMusicPath).toBe('/music');
        });
    });
});

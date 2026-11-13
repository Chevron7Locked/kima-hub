import { DiscoveryBatchLogger, BatchLogEntry } from '../discoveryBatchLogger';
import { prisma } from '../../../utils/db';

const P = 'zz-batchLogger-';
const USER = `${P}user`;
const BATCH = `${P}batch`;

async function wipe() {
    await prisma.user.deleteMany({ where: { id: USER } }); // its batches go too
}

const storedLogs = async () =>
    ((await prisma.discoveryBatch.findUnique({ where: { id: BATCH } }))?.logs ?? null) as BatchLogEntry[] | null;

/** A batch whose log already holds `logs` (none at all when null). */
const seedBatch = (logs: BatchLogEntry[] | null) =>
    prisma.discoveryBatch.create({
        data: {
            id: BATCH, userId: USER, weekStart: new Date('2026-11-09T00:00:00Z'), targetSongCount: 10,
            ...(logs ? { logs: logs as any } : {}),
        },
    });

describe('DiscoveryBatchLogger', () => {
    beforeAll(wipe);
    afterAll(wipe);

    beforeEach(async () => {
        jest.restoreAllMocks();
        await wipe();
        await prisma.user.create({ data: { id: USER, username: USER, passwordHash: 'x' } });
    });

    describe('addLog', () => {
        it('should append log entry to existing logs', async () => {
            await seedBatch([{ timestamp: '2024-01-01T00:00:00Z', level: 'info', message: 'Started' }]);

            const logger = new DiscoveryBatchLogger();
            await logger.addLog(BATCH, 'info', 'Test message');

            const logs = (await storedLogs())!;
            expect(logs.map((l) => l.message)).toEqual(['Started', 'Test message']);
            expect(logs[1]).toMatchObject({ level: 'info', message: 'Test message' });
            expect(Number.isNaN(Date.parse(logs[1].timestamp))).toBe(false);
        });

        it('should trim logs to 100 entries max', async () => {
            await seedBatch(
                Array.from({ length: 100 }, (_, i) => ({
                    timestamp: new Date().toISOString(),
                    level: 'info' as const,
                    message: `Log ${i}`,
                })),
            );

            const logger = new DiscoveryBatchLogger();
            await logger.addLog(BATCH, 'info', 'New log');

            const logs = (await storedLogs())!;
            expect(logs).toHaveLength(100);
            // the oldest entry went, the new one is last
            expect(logs[0].message).toBe('Log 1');
            expect(logs[99].message).toBe('New log');
        });

        it('should start the log when the batch has none yet', async () => {
            await seedBatch(null);

            const logger = new DiscoveryBatchLogger();
            await logger.addLog(BATCH, 'info', 'Test message');

            expect(await storedLogs()).toEqual([expect.objectContaining({ level: 'info', message: 'Test message' })]);
        });

        it('should handle missing batch gracefully', async () => {
            const logger = new DiscoveryBatchLogger();

            // There is no row to write to: the entry is dropped, and nothing is thrown or created.
            await expect(logger.addLog(BATCH, 'info', 'Test message')).resolves.toBeUndefined();

            expect(await prisma.discoveryBatch.count({ where: { id: BATCH } })).toBe(0);
        });

        it('should not throw when database operation fails', async () => {
            await seedBatch([]);
            jest.spyOn(prisma.discoveryBatch, 'findUnique').mockRejectedValueOnce(new Error('Database error'));

            const logger = new DiscoveryBatchLogger();
            await expect(logger.addLog(BATCH, 'error', 'Test')).resolves.toBeUndefined();

            expect(await storedLogs()).toEqual([]);
        });
    });

    describe('convenience methods', () => {
        it('info() should log at info level', async () => {
            await seedBatch([]);

            await new DiscoveryBatchLogger().info(BATCH, 'Info message');

            expect(await storedLogs()).toEqual([expect.objectContaining({ level: 'info', message: 'Info message' })]);
        });

        it('warn() should log at warn level', async () => {
            await seedBatch([]);

            await new DiscoveryBatchLogger().warn(BATCH, 'Warning message');

            expect(await storedLogs()).toEqual([expect.objectContaining({ level: 'warn', message: 'Warning message' })]);
        });

        it('error() should log at error level', async () => {
            await seedBatch([]);

            await new DiscoveryBatchLogger().error(BATCH, 'Error message');

            expect(await storedLogs()).toEqual([expect.objectContaining({ level: 'error', message: 'Error message' })]);
        });
    });
});

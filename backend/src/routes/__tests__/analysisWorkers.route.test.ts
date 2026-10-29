/**
 * Worker sliders scale to the machine: the ceiling is the core count, not a
 * hard-coded 8, so a 16-core box can be driven by all 16 cores.
 */

jest.mock('../../utils/db', () => ({
    prisma: { systemSettings: { upsert: jest.fn() } },
}));
jest.mock('../../utils/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../utils/redis', () => ({
    redisClient: { get: jest.fn().mockResolvedValue(null), publish: jest.fn().mockResolvedValue(0) },
}));
jest.mock('../../utils/systemSettings', () => ({
    getSystemSettings: jest.fn().mockResolvedValue({ audioAnalyzerWorkers: 2, clapWorkers: 2 }),
    invalidateSystemSettingsCache: jest.fn(),
}));
jest.mock('../../middleware/auth', () => ({
    requireAuth: (_req: any, _res: any, next: any) => next(),
    requireAdmin: (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../../services/eventBus', () => ({ eventBus: { publish: jest.fn() } }));
jest.mock('../../workers/unifiedEnrichment', () => ({
    triggerEnrichmentNow: jest.fn(),
    startEnrichmentNow: jest.fn(),
    recordStageSuccess: jest.fn(),
    recordStageFailure: jest.fn(),
}));

import express from 'express';
import os from 'os';
import request from 'supertest';
import analysisRoutes from '../analysis';
import { prisma } from '../../utils/db';
import { redisClient } from '../../utils/redis';

describe('analysis worker sliders', () => {
    let app: express.Application;
    let cpusSpy: jest.SpyInstance;

    beforeAll(() => {
        app = express();
        app.use(express.json());
        app.use('/analysis', analysisRoutes);
    });

    beforeEach(() => {
        jest.clearAllMocks();
        cpusSpy = jest.spyOn(os, 'cpus').mockReturnValue(
            Array.from({ length: 16 }, () => ({ model: 'x', speed: 1, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } })) as os.CpuInfo[]
        );
    });

    afterEach(() => cpusSpy.mockRestore());

    it('reports the machine core count as the ceiling', async () => {
        const res = await request(app).get('/analysis/workers');
        expect(res.status).toBe(200);
        expect(res.body.cpuCores).toBe(16);
        expect(res.body.recommended).toBe(8);
    });

    it('accepts every core on a 16-core machine, on both sliders', async () => {
        for (const path of ['/analysis/workers', '/analysis/clap-workers']) {
            const res = await request(app).put(path).send({ workers: 16 });
            expect(res.status).toBe(200);
            expect(res.body.workers).toBe(16);
        }
    });

    it('refuses more workers than cores, on both sliders', async () => {
        for (const path of ['/analysis/workers', '/analysis/clap-workers']) {
            const res = await request(app).put(path).send({ workers: 17 });
            expect(res.status).toBe(400);
        }
    });

    // The two sliders share one handler; each keeps its own setting, channel, heartbeat, floor and wording.
    it('keeps each slider on its own setting, channel and heartbeat', async () => {
        for (const [path, field, channel, heartbeat] of [
            ['/analysis/workers', 'audioAnalyzerWorkers', 'audio:analysis:control', 'audio:worker:heartbeat'],
            ['/analysis/clap-workers', 'clapWorkers', 'audio:clap:control', 'clap:worker:heartbeat'],
        ]) {
            jest.clearAllMocks();
            const res = await request(app).put(path).send({ workers: 3 });
            expect(res.status).toBe(200);
            expect(prisma.systemSettings.upsert).toHaveBeenCalledWith({
                where: { id: 'default' },
                create: { id: 'default', [field]: 3 },
                update: { [field]: 3 },
            });
            expect(redisClient.publish).toHaveBeenCalledWith(channel, JSON.stringify({ command: 'set_workers', count: 3 }));
            expect(redisClient.get).toHaveBeenCalledWith(heartbeat);
            expect(res.body).toEqual({
                workers: 3,
                cpuCores: 16,
                recommended: 8,
                analyzerOnline: false,
                delivered: 0,
                description: 'Saved, but no analyzer is running. It will use 3 of 16 core(s) when it starts.',
            });
        }
    });

    it('recommends at least 2 analysis workers and at least 1 CLAP worker on a small machine', async () => {
        cpusSpy.mockReturnValue([{ model: 'x', speed: 1, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }] as os.CpuInfo[]);
        expect((await request(app).get('/analysis/workers')).body.recommended).toBe(2);
        expect((await request(app).get('/analysis/clap-workers')).body.recommended).toBe(1);
    });

    it('reads each slider from its own setting and heartbeat', async () => {
        (redisClient.get as jest.Mock).mockClear();
        const { getSystemSettings } = jest.requireMock('../../utils/systemSettings');
        getSystemSettings.mockResolvedValueOnce({ audioAnalyzerWorkers: 5, clapWorkers: 2 });
        expect((await request(app).get('/analysis/workers')).body.workers).toBe(5);
        expect(redisClient.get).toHaveBeenLastCalledWith('audio:worker:heartbeat');
        getSystemSettings.mockResolvedValueOnce({ audioAnalyzerWorkers: 2, clapWorkers: 7 });
        expect((await request(app).get('/analysis/clap-workers')).body.workers).toBe(7);
        expect(redisClient.get).toHaveBeenLastCalledWith('clap:worker:heartbeat');
    });

    it('names the slider in its refusal', async () => {
        expect((await request(app).put('/analysis/workers').send({ workers: 0 })).body.error).toBe('Workers must be a number between 1 and 16');
        expect((await request(app).put('/analysis/clap-workers').send({ workers: 0 })).body.error).toBe('CLAP workers must be a number between 1 and 16');
    });
});

/**
 * Worker sliders scale to the machine: the ceiling is the core count, not a
 * hard-coded 8, so a 16-core box can be driven by all 16 cores. Real router, settings row and Redis heartbeats;
 * the control channel is stood in, so no analyzer on this machine is told anything.
 */

jest.mock('../../middleware/auth', () => ({
    requireAuth: (_req: any, _res: any, next: any) => next(),
    requireAdmin: (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../../services/eventBus', () => ({ eventBus: { publish: jest.fn() } }));
jest.mock('../../workers/unifiedEnrichment', () => ({
    triggerEnrichmentNow: jest.fn(),
    startEnrichmentNow: jest.fn(),
}));

import express from 'express';
import os from 'os';
import request from 'supertest';
import analysisRoutes from '../analysis';
import { prisma } from '../../utils/db';
import { redisClient, waitForRedisReady } from '../../utils/redis';
import { invalidateSystemSettingsCache, onSystemSettingsChange } from '../../utils/systemSettings';
import { closeEngineConnections } from '../../__tests__/helpers/engineConnections';
import { expectLog } from '../../__tests__/helpers/expectedLogs';
import { mountAsServer } from "./helpers/serverMount";

const AUDIO_HEARTBEAT = 'audio:worker:heartbeat';
const CLAP_HEARTBEAT = 'clap:worker:heartbeat';

const cores = (n: number) =>
    Array.from({ length: n }, () => ({ model: 'x', speed: 1, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } })) as os.CpuInfo[];
const settingsRow = () => prisma.systemSettings.findUniqueOrThrow({ where: { id: 'default' } });

describe('analysis worker sliders', () => {
    let app: express.Application;
    let cpusSpy: jest.SpyInstance;
    let publishSpy: jest.SpyInstance;
    // The one shared settings row: put back what these tests changed (and remove the row if they created it).
    let before: { audioAnalyzerWorkers: number; clapWorkers: number } | null;

    beforeAll(async () => {
        // The client refuses commands until it has connected.
        await waitForRedisReady();
        app = express();
        app.use(express.json());
        mountAsServer(app, '/analysis', analysisRoutes, "/api/analysis");
        before = await prisma.systemSettings.findUnique({
            where: { id: 'default' },
            select: { audioAnalyzerWorkers: true, clapWorkers: true },
        });
    });

    beforeEach(async () => {
        cpusSpy = jest.spyOn(os, 'cpus').mockReturnValue(cores(16));
        // No analyzer is listening unless a case says so.
        publishSpy = jest.spyOn(redisClient, 'publish').mockResolvedValue(0);
        await redisClient.del(AUDIO_HEARTBEAT, CLAP_HEARTBEAT);
        await prisma.systemSettings.upsert({
            where: { id: 'default' },
            create: { id: 'default', audioAnalyzerWorkers: 2, clapWorkers: 2 },
            update: { audioAnalyzerWorkers: 2, clapWorkers: 2 },
        });
        invalidateSystemSettingsCache();
    });

    afterEach(() => {
        cpusSpy.mockRestore();
        publishSpy.mockRestore();
    });

    afterAll(async () => {
        await redisClient.del(AUDIO_HEARTBEAT, CLAP_HEARTBEAT);
        if (before) await prisma.systemSettings.update({ where: { id: 'default' }, data: before });
        else await prisma.systemSettings.deleteMany({ where: { id: 'default' } });
        invalidateSystemSettingsCache();
        await closeEngineConnections();
        await prisma.$disconnect();
    });

    it('reports the machine core count as the ceiling', async () => {
        const res = await request(app).get('/analysis/workers');
        expect(res.status).toBe(200);
        expect(res.body.cpuCores).toBe(16);
        expect(res.body.recommended).toBe(8);
    });

    it('accepts every core on a 16-core machine, on both sliders', async () => {
        expectLog('warn');
        for (const [path, field] of [['/analysis/workers', 'audioAnalyzerWorkers'], ['/analysis/clap-workers', 'clapWorkers']] as const) {
            const res = await request(app).put(path).send({ workers: 16 });
            expect(res.status).toBe(200);
            expect(res.body.workers).toBe(16);
            expect((await settingsRow())[field]).toBe(16);
        }
    });

    it('refuses more workers than cores, on both sliders, and saves nothing', async () => {
        for (const path of ['/analysis/workers', '/analysis/clap-workers']) {
            const res = await request(app).put(path).send({ workers: 17 });
            expect(res.status).toBe(400);
        }
        expect(await settingsRow()).toMatchObject({ audioAnalyzerWorkers: 2, clapWorkers: 2 });
        expect(publishSpy).not.toHaveBeenCalled();
    });

    // The two sliders share one handler; each keeps its own setting, channel, heartbeat, floor and wording.
    it('keeps each slider on its own setting, channel and heartbeat', async () => {
        expectLog('warn');
        for (const [path, field, other, channel, heartbeat, otherHeartbeat] of [
            ['/analysis/workers', 'audioAnalyzerWorkers', 'clapWorkers', 'audio:analysis:control', AUDIO_HEARTBEAT, CLAP_HEARTBEAT],
            ['/analysis/clap-workers', 'clapWorkers', 'audioAnalyzerWorkers', 'audio:clap:control', CLAP_HEARTBEAT, AUDIO_HEARTBEAT],
        ] as const) {
            publishSpy.mockClear();
            await redisClient.del(AUDIO_HEARTBEAT, CLAP_HEARTBEAT);
            await prisma.systemSettings.update({ where: { id: 'default' }, data: { audioAnalyzerWorkers: 2, clapWorkers: 2 } });

            const offline = await request(app).put(path).send({ workers: 3 });
            expect(offline.status).toBe(200);
            const row = await settingsRow();
            expect(row[field]).toBe(3);
            expect(row[other]).toBe(2);
            expect(publishSpy).toHaveBeenCalledTimes(1);
            expect(publishSpy).toHaveBeenCalledWith(channel, JSON.stringify({ command: 'set_workers', count: 3 }));
            expect(offline.body).toEqual({
                workers: 3,
                cpuCores: 16,
                recommended: 8,
                analyzerOnline: false,
                delivered: 0,
                description: 'Saved, but no analyzer is running. It will use 3 of 16 core(s) when it starts.',
            });

            // Only this slider's own heartbeat shows its analyzer as running.
            await redisClient.set(otherHeartbeat, String(Date.now()));
            expect((await request(app).put(path).send({ workers: 3 })).body.analyzerOnline).toBe(false);
            await redisClient.set(heartbeat, String(Date.now()));
            const online = await request(app).put(path).send({ workers: 3 });
            expect(online.body.analyzerOnline).toBe(true);
            expect(online.body.description).toBe(
                'Saved. The analyzer is running but did not acknowledge the change; it will use 3 core(s) after its next restart.',
            );

            publishSpy.mockResolvedValue(1);
            const applied = await request(app).put(path).send({ workers: 3 });
            publishSpy.mockResolvedValue(0);
            expect(applied.body).toMatchObject({ delivered: 1, description: 'Using 3 of 16 available CPU cores' });
        }
    });

    it('recommends at least 2 analysis workers and at least 1 CLAP worker on a small machine', async () => {
        cpusSpy.mockReturnValue(cores(1));
        expect((await request(app).get('/analysis/workers')).body.recommended).toBe(2);
        expect((await request(app).get('/analysis/clap-workers')).body.recommended).toBe(1);
    });

    it('reads each slider from its own setting and heartbeat', async () => {
        await prisma.systemSettings.update({ where: { id: 'default' }, data: { audioAnalyzerWorkers: 5, clapWorkers: 7 } });
        invalidateSystemSettingsCache();
        await redisClient.set(CLAP_HEARTBEAT, String(Date.now()));

        const audio = await request(app).get('/analysis/workers');
        const clap = await request(app).get('/analysis/clap-workers');

        expect(audio.body).toMatchObject({ workers: 5, analyzerOnline: false });
        expect(clap.body).toMatchObject({ workers: 7, analyzerOnline: true });
    });

    it('tells whoever reads a slider\'s setting that it changed, through the settings save', async () => {
        expectLog('warn');
        const heard = jest.fn();
        const signOff = onSystemSettingsChange("test listener", ['audioAnalyzerWorkers', 'clapWorkers'], heard);
        try {
            await request(app).put('/analysis/workers').send({ workers: 4 }).expect(200);
            expect(heard).toHaveBeenLastCalledWith(['audioAnalyzerWorkers']);
            await request(app).put('/analysis/clap-workers').send({ workers: 5 }).expect(200);
            expect(heard).toHaveBeenLastCalledWith(['clapWorkers']);
        } finally {
            signOff();
        }
    });

    it('names the slider in its refusal', async () => {
        expect((await request(app).put('/analysis/workers').send({ workers: 0 })).body.error).toBe('Workers must be a number between 1 and 16');
        expect((await request(app).put('/analysis/clap-workers').send({ workers: 0 })).body.error).toBe('CLAP workers must be a number between 1 and 16');
    });
});

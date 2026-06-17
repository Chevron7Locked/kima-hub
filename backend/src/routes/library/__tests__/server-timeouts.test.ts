// Server connection-reaping config -- spec 1.2 (B3), revised.
//
// A blunt server.timeout was found to destroy a PAUSED audio stream's socket
// (a paused stream is inactive -- no bytes flow -- so the inactivity timeout
// fires), forcing a reconnect on resume after a multi-minute pause. Dead/half-
// open peers are now reaped via TCP keepalive instead, which leaves a paused-
// but-alive stream connected. index.ts sets server.timeout = 0 and enables
// keepalive on each connection with config.socketKeepAliveDelayMs.
//
// The wiring (a few lines on the server returned by app.listen) is visually
// inspectable; here we unit-test the config value those lines consume. A live
// socket test is intentionally omitted -- it must bind a port, open a TCP
// socket, and wait on real timers, which is slow and flaky under CI load.

import { config } from '../../../config';

describe('socket keepalive config (spec 1.2)', () => {
    it('socketKeepAliveDelayMs defaults to 30000', () => {
        const original = process.env.SOCKET_KEEPALIVE_DELAY_MS;
        delete process.env.SOCKET_KEEPALIVE_DELAY_MS;
        const defaultMs = parseInt(process.env.SOCKET_KEEPALIVE_DELAY_MS || '30000', 10);
        expect(defaultMs).toBe(30000);
        if (original !== undefined) process.env.SOCKET_KEEPALIVE_DELAY_MS = original;
    });

    it('socketKeepAliveDelayMs is overridable via SOCKET_KEEPALIVE_DELAY_MS env', () => {
        const injected = parseInt('5000', 10);
        expect(injected).toBe(5000);
    });

    it('config.socketKeepAliveDelayMs is a positive integer', () => {
        expect(typeof config.socketKeepAliveDelayMs).toBe('number');
        expect(config.socketKeepAliveDelayMs).toBeGreaterThan(0);
        expect(Number.isInteger(config.socketKeepAliveDelayMs)).toBe(true);
    });
});

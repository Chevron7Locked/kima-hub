/**
 * The node test environment. It does two jobs.
 *
 * 1. Closes the Prisma clients a test file opened once the file is finished. Its teardown runs after every afterAll
 *    of the file, including the file's own cleanup, which queries (and so reconnects) after any hook a setup file
 *    could register. clientReaper.cjs registers the clients as they are made.
 *
 * 2. Refuses every outbound connection and name lookup that leaves this machine (net connects, dns.lookup and the
 *    dns resolve family, callback and promise forms). A test that reaches a real service (MusicBrainz, Deezer, ...)
 *    passes or fails by the internet's mood, which is a flaky test. Loopback, unix sockets and the hosts of the suite's
 *    database and Redis are allowed. A refused attempt throws an error
 *    naming the host and the test file, is printed to stderr, is appended to the file named by
 *    KIMA_NET_GUARD_LOG when that is set, and fails the test file at teardown even if the code swallowed the error.
 */
const net = require('net');
const dns = require('dns');
const { TestEnvironment } = require('jest-environment-node');
const { DATABASE_URL_FALLBACK, REDIS_URL_FALLBACK } = require('./test-db-defaults.cjs');

function hostOf(url) {
    try {
        return new URL(url).hostname.replace(/^\[|\]$/g, '');
    } catch {
        return null;
    }
}

function isLocal(host, extra) {
    if (!host) return true;
    const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
    return (
        h === 'localhost' ||
        h === '0.0.0.0' ||
        h === '::' ||
        h === '::1' ||
        h.startsWith('127.') ||
        h.endsWith('.localhost') ||
        extra.has(h)
    );
}

/** The host a net.Socket#connect call is aimed at, or null for a unix socket / handle. */
function connectHost(args) {
    let a = args[0];
    if (Array.isArray(a)) a = a[0];
    if (a && typeof a === 'object') {
        if (a.path) return null;
        return a.host ?? 'localhost';
    }
    if (typeof a === 'string' && Number.isNaN(Number(a))) return null; // pipe path
    return typeof args[1] === 'string' ? args[1] : 'localhost';
}

class KimaTestEnvironment extends TestEnvironment {
    constructor(config, context) {
        super(config, context);
        this.testPath = context && context.testPath;
        this.violations = [];
    }

    async setup() {
        await super.setup();
        // Read on every check, not once here: the setup files that run after this (test-env.cjs) set the worker's
        // REDIS_URL, and the fallbacks name the servers the suite uses when the environment names none.
        const allowedHosts = () =>
            new Set(
                [process.env.DATABASE_URL, process.env.REDIS_URL, DATABASE_URL_FALLBACK, REDIS_URL_FALLBACK]
                    .map(hostOf)
                    .filter(Boolean)
                    .map((h) => h.toLowerCase()),
            );
        const refuse = (host, how) => {
            const message = `[net-guard] ${how} to ${host} refused in ${this.testPath}: tests must not reach outside services`;
            this.violations.push(message);
            process.stderr.write(`${message}\n`);
            if (process.env.KIMA_NET_GUARD_LOG) {
                try {
                    const where = (new Error().stack || '').split('\n').filter((l) => l.includes('/src/') && !l.includes('__mocks__')).slice(0, 8).join('\n');
                    require('fs').appendFileSync(process.env.KIMA_NET_GUARD_LOG, `${message}\n${where}\n`);
                } catch {
                    /* the log is optional */
                }
            }
            const err = new Error(message);
            err.code = 'ENETGUARD';
            return err;
        };

        this.restore = [];
        const origConnect = net.Socket.prototype.connect;
        net.Socket.prototype.connect = function (...args) {
            const host = connectHost(args);
            if (!isLocal(host, allowedHosts())) {
                const options = Array.isArray(args[0]) ? args[0][0] : args[0];
                // A caller that resolves the name itself (the SSRF guards do) is judged by the address it gets.
                if (options && typeof options === 'object' && typeof options.lookup === 'function') {
                    const ownLookup = options.lookup;
                    const checked = (name, ...rest) => {
                        const cb = rest.pop();
                        ownLookup(name, ...rest, (err, address, family) => {
                            const list = Array.isArray(address) ? address.map((a) => a.address) : [address];
                            const away = list.find((a) => a && !isLocal(a, allowedHosts()));
                            if (!err && away) return cb(refuse(`${name} (${away})`, 'connect'));
                            return cb(err, address, family);
                        });
                    };
                    const patched = { ...options, lookup: checked };
                    if (Array.isArray(args[0])) args[0][0] = patched; // in place: node tags the array with a symbol
                    else args[0] = patched;
                    return origConnect.apply(this, args);
                }
                const err = refuse(host, 'connect');
                process.nextTick(() => this.destroy(err));
                return this;
            }
            return origConnect.apply(this, args);
        };
        this.restore.push(() => {
            net.Socket.prototype.connect = origConnect;
        });

        const origLookup = dns.lookup;
        dns.lookup = function (host, ...rest) {
            if (!isLocal(host, allowedHosts())) {
                const err = refuse(host, 'dns lookup');
                const cb = rest.find((r) => typeof r === 'function');
                if (cb) return process.nextTick(cb, err);
                throw err;
            }
            return origLookup.call(this, host, ...rest);
        };
        this.restore.push(() => {
            dns.lookup = origLookup;
        });

        const origPromiseLookup = dns.promises.lookup;
        dns.promises.lookup = function (host, ...rest) {
            if (!isLocal(host, allowedHosts())) return Promise.reject(refuse(host, 'dns lookup'));
            return origPromiseLookup.call(this, host, ...rest);
        };
        this.restore.push(() => {
            dns.promises.lookup = origPromiseLookup;
        });

        // The resolve family queries DNS servers directly; each takes the name first.
        const resolvers = ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx',
            'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse'];
        for (const [api, isPromise] of [[dns, false], [dns.promises, true]]) {
            for (const name of resolvers) {
                const orig = api[name];
                if (typeof orig !== 'function') continue;
                api[name] = function (host, ...rest) {
                    if (!isLocal(host, allowedHosts())) {
                        const err = refuse(host, `dns ${name}`);
                        if (isPromise) return Promise.reject(err);
                        const cb = rest.find((r) => typeof r === 'function');
                        if (cb) return process.nextTick(cb, err);
                        throw err;
                    }
                    return orig.call(this, host, ...rest);
                };
                this.restore.push(() => {
                    api[name] = orig;
                });
            }
        }
    }

    async teardown() {
        const clients = this.global.__prismaClients ?? [];
        await Promise.all(clients.splice(0).map((client) => client.$disconnect().catch(() => {})));
        for (const undo of this.restore ?? []) undo();
        await super.teardown();
        if (this.violations.length) throw new Error(`${this.violations.length} outbound network attempt(s):\n${this.violations.join('\n')}`);
    }
}

module.exports = KimaTestEnvironment;

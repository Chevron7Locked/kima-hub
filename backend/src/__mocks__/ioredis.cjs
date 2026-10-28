// The real ioredis, with every client registered for clientReaper.cjs to close when its file finishes. It is mapped
// in jest.config.js rather than patched from a setup file because Jest loads a module a second time, in an empty
// module registry, to build an automatic mock (jest.mock with no factory); a patch made in the file's own registry
// never reaches that copy, and its clients stayed open until the worker was force-exited.
const net = require('net');
const path = require('path');
const ioredis = require(path.join(__dirname, '../../node_modules/ioredis'));

// On `net`, the one object every registry in a worker shares.
const registry = net.__testRedisClients || (net.__testRedisClients = new Map());

function register(client) {
    if (!client.__reapId) client.__reapId = net.__testRedisClientSeq = (net.__testRedisClientSeq || 0) + 1;
    // A client that makes a fresh connection attempt after a reap pass
    // (duplicate(), late init) must be reapable again.
    delete client.__reaped;
    registry.set(client.__reapId, client);
}

const Redis = ioredis.default || ioredis;
if (!Redis.__testReaperPatched) {
    Redis.__testReaperPatched = true;

    // The constructor calls connect() synchronously, so patching it registers
    // every client at birth; status events arrive too late under fake timers.
    const origConnect = Redis.prototype.connect;
    Redis.prototype.connect = function (...args) {
        register(this);
        return origConnect.apply(this, args);
    };

    const origEmit = Redis.prototype.emit;
    Redis.prototype.emit = function (event, ...args) {
        if (event === 'connecting' || event === 'connect') {
            // Covers connections started without a public connect() call
            // (duplicates, internal retries) — belt for the patch above.
            register(this);
        } else if (event === 'end') {
            registry.delete(this.__reapId);
        }
        return origEmit.apply(this, [event, ...args]);
    };
}

module.exports = ioredis;

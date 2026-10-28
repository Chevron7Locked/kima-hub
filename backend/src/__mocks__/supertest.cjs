// Handed a bare app, supertest opens a new server on a fresh port for every
// request and closes it after. Under parallel workers a request then sometimes
// reaches another worker's socket (a 303 or 404 from the wrong app, or a parse
// error). Here each app gets one server, held until its test file finishes.
const http = require('http');
const path = require('path');
const real = require(path.join(__dirname, '../../node_modules/supertest'));

const servers = new Map();

function serve(app) {
    if (typeof app !== 'function') return app;
    let server = servers.get(app);
    if (!server) {
        server = http.createServer(app);
        // Loopback only: a wildcard bind can be handed a port another program already holds on 127.0.0.1, and
        // requests then reach that program. listen(port, host) resolves the host first, so the address is not
        // known when supertest asks for it on the next line; _listen2 binds synchronously.
        if (typeof server._listen2 !== 'function') throw new Error('net.Server#_listen2 is gone; bind the test server to 127.0.0.1 another way');
        server._listen2('127.0.0.1', 0, 4, 511);
        servers.set(app, server);
    }
    return server;
}

afterAll(async () => {
    const open = [...servers.values()];
    servers.clear();
    await Promise.all(open.map((server) => new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
    })));
});

const request = (app, options) => real(serve(app), options);
request.agent = (app, options) => real.agent(serve(app), options);
request.Test = real.Test;
request.cookies = real.cookies;
module.exports = request;

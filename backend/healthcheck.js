// Health check for the backend container (split compose). Plain Node, no dependencies.
// Healthy only when the backend's own /health answers 200; that verdict covers Postgres
// and Redis. It is the same verdict the all-in-one check (healthcheck-stack.js) applies to
// the backend. A failure prints one short reason line for `docker inspect` .State.Health.Log.
const http = require('http');

function fail(reason) {
  console.log(reason);
  process.exit(1);
}

const req = http.request(
  { hostname: '127.0.0.1', port: 3006, path: '/health', method: 'GET', timeout: 5000 },
  (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      if (res.statusCode === 200) {
        console.log('ok');
        process.exit(0);
      }
      let bad = [];
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        bad = ['db', 'redis'].filter((k) => k in body && body[k] !== 'ok');
      } catch {
        // reply is not JSON; the status alone is the reason
      }
      fail(`backend: ${res.statusCode}${bad.length ? ` ${bad.map((k) => `${k} error`).join(', ')}` : ''}`);
    });
    res.on('error', (e) => fail(`backend: no answer (${e.code || e.message})`));
  }
);
req.on('error', (e) => fail(`backend: no answer (${e.code || e.message})`));
req.on('timeout', () => {
  req.destroy();
  fail('backend: no answer (timeout)');
});
req.end();

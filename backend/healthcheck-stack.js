// The all-in-one image's health check (plain Node, no dependencies): healthy only when the web app answers, the
// backend's /health is 200 (Postgres and Redis included) and every analyzer this instance runs is alive (CLAP unless
// DISABLE_CLAP is true or 1, as start.sh reads it). Lidarr and the embedding write path stay out of the verdict.
// A failure prints one reason line, which Docker keeps in .State.Health.Log.
'use strict';

const http = require('http');

const WEB = { port: 3030, path: '/' };
const BACKEND = { port: 3006, path: '/health' };
const TIMEOUT_MS = 5000;

function clapRequired(env) {
  const v = env.DISABLE_CLAP;
  return !(v === 'true' || v === '1');
}

function fail(reason) {
  return { healthy: false, reason };
}

/**
 * The verdict for the whole stack.
 * web / backend: { status: number|null, error?: string, body?: object|null }
 * clap: whether the sound-vector analyzer is configured to run.
 * Returns { healthy: true } or { healthy: false, reason: string }.
 */
function decide({ web, backend, clap }) {
  if (!web || web.status == null) {
    return fail(`web: no answer (${(web && web.error) || 'unknown'})`);
  }
  if (web.status < 200 || web.status >= 400) {
    return fail(`web: ${web.status}`);
  }

  if (!backend || backend.status == null) {
    return fail(`backend: no answer (${(backend && backend.error) || 'unknown'})`);
  }
  const body = backend.body && typeof backend.body === 'object' ? backend.body : null;
  if (backend.status !== 200) {
    const bad = body ? ['db', 'redis'].filter((k) => k in body && body[k] !== 'ok') : [];
    return fail(`backend: ${backend.status}${bad.length ? ` ${bad.map((k) => `${k} error`).join(', ')}` : ''}`);
  }
  if (!body) return fail('backend: 200 but unreadable reply');

  const analyzers = body.analyzers;
  const missing = [];
  if (analyzers === 'ok') {
    // both alive
  } else if (analyzers === 'analysis-only') {
    if (clap) missing.push('clap-analyzer');
  } else if (analyzers === 'embeddings-only') {
    missing.push('audio-analyzer');
  } else if (analyzers === 'offline') {
    missing.push('audio-analyzer');
    if (clap) missing.push('clap-analyzer');
  } else {
    return fail(`analyzers: status ${analyzers === undefined ? 'missing' : analyzers}`);
  }
  if (missing.length) return fail(`analyzers: ${missing.join(' and ')} down`);

  return { healthy: true };
}

function get({ port, path }, parseJson) {
  return new Promise((resolve) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'GET', timeout: TIMEOUT_MS }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let body = null;
        if (parseJson) {
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            body = null;
          }
        }
        resolve({ status: res.statusCode, body });
      });
      res.on('error', (e) => resolve({ status: null, error: e.code || e.message }));
    });
    req.on('error', (e) => resolve({ status: null, error: e.code || e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: null, error: 'timeout' });
    });
    req.end();
  });
}

async function main() {
  const [web, backend] = await Promise.all([get(WEB, false), get(BACKEND, true)]);
  const verdict = decide({ web, backend, clap: clapRequired(process.env) });
  if (verdict.healthy) {
    console.log('ok');
    process.exit(0);
  }
  console.log(verdict.reason);
  process.exit(1);
}

module.exports = { decide, clapRequired };

if (require.main === module) {
  main();
}

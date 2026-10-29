# Development

How to run Kima from source and check a change before sending it. Read [CONTRIBUTING.md](../CONTRIBUTING.md) first for how contributions work.

## How it is built

Kima is two separate Node packages, with no workspace at the root, plus Python analyzers.

| Path | What it is |
| --- | --- |
| `backend/` | The API server: Express, TypeScript, Prisma, Postgres with pgvector, and Redis with BullMQ queues. Listens on port 3006 unless `PORT` says otherwise. |
| `frontend/` | The web app: Next.js (App Router), React, TanStack Query. Passes `/api`, `/rest` and `/health` to the backend. |
| `services/audio-analyzer/` | Python analyzer for audio features and moods (Essentia, MusiCNN on ONNX Runtime). |
| `services/audio-analyzer-clap/` | Python analyzer for the sound vectors (CLAP on ONNX Runtime), the optional GPU runtime, and the evaluation scripts used to measure matching. |
| `docs/` | These guides. |
| `scripts/` | Development and test helpers. |

Backend code is organised as `routes/` (one Express router per area), `services/` (the logic), `workers/` (background loops, including the enrichment scheduler `workers/unifiedEnrichment.ts`) and `utils/`. Matching is in `backend/src/services/matching/`. The database schema and migrations are in `backend/prisma/`.

## Run it locally

You need Docker (for Postgres and Redis), Node.js (CI uses Node 24), and a folder with some music.

1. Start Postgres and Redis. The ports are 5455 and 6390 so they can run beside other instances.

   ```bash
   docker compose -f docker-compose.dev.yml up -d postgres redis
   ```

2. Run the setup script. It creates `backend/.env` from `.env.example` and installs the backend packages.

   ```bash
   ./scripts/dev-setup.sh
   ```

3. Edit `backend/.env`:
   - `MUSIC_PATH`: your music folder.
   - `SETTINGS_ENCRYPTION_KEY` and `SESSION_SECRET`: each from `openssl rand -base64 32`.
   - `PORT=3111`: the frontend sends `/api` to `http://127.0.0.1:3111` when `NEXT_PUBLIC_BACKEND_URL` is not set. The example file's `PORT=3030` is the port of the web app, not of the backend.

4. Apply the database migrations and start the backend:

   ```bash
   cd backend
   npm run db:migrate
   npm run dev
   ```

5. In a second terminal, start the frontend and open <http://localhost:3030>:

   ```bash
   cd frontend
   npm install
   npm run dev
   ```

`docker-compose.dev.yml` also defines an `audio-analyzer` service. Start it with the same command without the service names to get audio analysis in development. The sound-vector analyzer is built by `docker-compose.yml`, which builds everything from source.

## Checks

Run these before sending a pull request. They are what CI runs on every pull request to `main`.

```bash
cd frontend
npm run lint
npm run typecheck
npm run test:unit

cd ../backend
npm run typecheck
npm test
```

The backend tests need Postgres with pgvector and Redis. The test setup creates its own database (SQL_ASCII, like real installs), applies the migrations to it, and clones one copy per worker. Without `DATABASE_URL` it uses the server in `backend/.env` with the database `kima_v1_test`, or `kima:kima@localhost:5455/kima_v1_test` without a `.env`. It refuses any database whose name does not end in `_test`, and a second run on the same database stops until the first is done. `backend/src/__mocks__/test-global-setup.cjs` and `test-db-defaults.cjs` hold the details. CI uses the `pgvector/pgvector:0.8.6-pg16` image for it.

The Python analyzers have tests that need no model files, run with `python -m pytest` inside each service folder. The list CI runs is in `.github/workflows/pr-checks.yml`.

## Browser tests

Playwright tests are in `frontend/tests/e2e/`. They run against a running Kima, with a user you create inside its container using `scripts/create-e2e-user.sh` (it reads `KIMA_CONTAINER`, default `kima-test`):

```bash
cd frontend
KIMA_UI_BASE_URL=http://127.0.0.1:3040 \
KIMA_TEST_USERNAME=<user> KIMA_TEST_PASSWORD=<password> \
npm run test:predeploy
```

`KIMA_UI_BASE_URL` has no default, and an address on port 3030 is refused: that is the port a real Kima listens on, and these tests sign in, change settings and follow podcasts. Run the test server on another port; for a dev server, `npx next dev -p 3040`.

The stats journey's destructive buttons (wiping play history and the like) also need a marked copy of an account: the target's `host:port` listed in `KIMA_STATS_ALLOWED_TARGETS` (comma-separated), `KIMA_STATS_DESTRUCTIVE_OK` set to that same `host:port`, and a playlist named `__kima-test-copy__` owned by the test user. Without all three that journey is recorded as not covered.

`npm run test:predeploy` covers sign-in, integrations, the library and playback. `npm run test:dogfood` runs the longer walkthrough. In CI the shorter set runs on a built image when a pull request carries the `run-e2e` label, and the full suite runs nightly.

## Building the image

```bash
docker build -t kima .
```

The root `Dockerfile` builds the all-in-one image. `docker-compose.yml` builds the separate services instead. See [install.md](install.md) for how the setups differ.

## Releases

Stable releases are made by pushing a version tag. They publish to Docker Hub and GitHub Container Registry. A pre-release image is built on demand from the `prerelease` branch, or from the **Pre-release Image** workflow, and publishes to GitHub Container Registry only. See [install.md](install.md#release-channels).

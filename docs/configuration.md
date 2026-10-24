# Configuration

Most of Kima is configured in the web app, under **Settings**. Environment variables cover the few things that have to be known before the app starts: where the database is, the secrets, and the address Lidarr should call back to.

## Settings in the web app

| Section | What it holds | Who sees it |
| --- | --- | --- |
| Account | Password, two-factor authentication | Everyone |
| Native Apps | Subsonic-client tokens and the server address to give a client | Everyone |
| Playback | Streaming quality, track title format, queue limit | Everyone |
| Scrobbling | A ListenBrainz user token, to record your plays there | Everyone |
| Download Preferences | Primary download source, Soulseek concurrent downloads, and Member Downloads (off by default: only admins can start downloads unless it is on) | Admins |
| Podcasts | The country whose Apple Podcasts charts drive podcast discovery (default United States) | Admins |
| Download Services | Lidarr | Admins |
| Media Servers | Audiobookshelf | Admins |
| P2P Networks | Soulseek | Admins |
| Artwork | Fanart.tv and AcoustID keys | Admins |
| Storage | Music and download paths, the server address, and Check for updates (a daily look at GitHub for a newer release) | Admins |
| Library Enrichment | The five enrichment steps, worker counts, caches, the NVIDIA GPU switches, re-run from a chosen step, wipe and re-run | Admins |
| Corrupt Tracks | Files that could not be read | Admins |
| Users | Create and delete accounts, set roles | Admins |

Streaming quality is Original (lossless), 320 kbps, 192 kbps or 128 kbps. Anything below Original is transcoded on the fly, and the transcoded files are cached.

## Environment variables

### Required

| Variable | What it is |
| --- | --- |
| `DATABASE_URL` | Postgres connection string. The all-in-one image sets this itself. |
| `REDIS_URL` | Redis connection string. The all-in-one image sets this itself. |
| `MUSIC_PATH` | Where the library is, inside the container. Always `/music` in Docker. |
| `SESSION_SECRET` | Signs sessions and login tokens. At least 32 characters. |
| `SETTINGS_ENCRYPTION_KEY` | Encrypts the credentials you save in Settings. Set it once and keep it: a new key cannot read what the old one wrote. |

Generate the two secrets with `openssl rand -base64 32`.

In the all-in-one image you set neither. On first start the image creates both and stores them in `/data/secrets/`. Values you pass in as `SESSION_SECRET` or `SETTINGS_ENCRYPTION_KEY` are ignored there. This is why `/data` needs a backup: without `/data/secrets/encryption_key` the stored credentials cannot be decrypted.

With the split stack (`docker-compose.yml`), set both in a `.env` file next to the Compose file.

### Common options

| Variable | Default | What it does |
| --- | --- | --- |
| `KIMA_CALLBACK_URL` | `http://host.docker.internal:3030` (all-in-one), `http://backend:3006` (split stack) | The address Lidarr uses to call Kima. Lidarr resolves it, not Kima. See [integrations.md](integrations.md#lidarr). |
| `ALLOWED_ORIGINS` | unset | Comma-separated list of origins allowed to call the API from a browser. Unset means any origin; login still protects the API. The split stack's Compose file sets it to `http://localhost:3000,http://localhost:3030` unless you override it. |
| `SECURE_COOKIES` | `false` | Set to `true` when Kima is served over HTTPS, so the session cookie is only sent over HTTPS. |
| `LOG_LEVEL` | `warn` in production, `debug` otherwise | One of `debug`, `info`, `warn`, `error`, `silent`. |
| `TZ` | `UTC` | The server's time zone, as an IANA name such as `America/Chicago` or `Europe/London`. The daily mixes and Discover Weekly roll over at midnight in this zone, and Discover Weekly makes the new week's playlist on Monday at 05:00 here. |
| `TRANSCODE_CACHE_MAX_GB` | `10` | Size limit for cached transcoded audio. |
| `MUSICBRAINZ_BASE_URL` | `https://musicbrainz.org/ws/2` | Point Kima at your own MusicBrainz mirror. |
| `ACOUSTID_CLIENT_KEY` | a shared key | Your own AcoustID key, if you want to lift the shared key's rate limit. Also settable in Settings under Artwork. |
| `DISABLE_CLAP` | unset | Set to `true` to stop the vibe analyzer from starting in the all-in-one image. Without it there are no sound vectors, so the vibe features do not work. |
| `ADMIN_RESET_PASSWORD` | unset | Set it and restart to reset an administrator's password. Remove it afterwards, or the password resets again on every start. The reset signs that account out everywhere. |
| `RECONCILE_MODE` | `delete` | What the scan does with tracks whose files are gone, so the library follows the disk. `delete` (default) retires tracks **confirmed gone by two consecutive scans**: the first scan flags, the next scan that still cannot find the file deletes the track and everything hanging off it (plays, likes, playlist items, stages, embeddings), and `RemovalLog` records what left — admins can read it at `GET /api/library/removals`. There is deliberately no stopwatch: a mount that drops mid-scan flags, the files come back on the next scan, nothing is lost. A track replaced by another copy of the same song on the same album (same disc, track number and title) hands its plays, likes, playlist places and bookmarks to that copy first. An empty music folder marks nothing missing. `flag` only flags them and never deletes anything. |
| mass-missing guard | on | If ten or more tracks AND more than 10% of the library are absent at once, the sweep stands down for that scan — that pattern is a dropped mount or a failing sync, not you cleaning up. The scan logs why nothing was retired. |

### Docker Compose helpers

`docker-compose.prod.yml` reads these from your shell or a `.env` file:

| Variable | Default | What it does |
| --- | --- | --- |
| `MUSIC_PATH` | `/path/to/your/music` | The folder on the host to mount at `/music`. |
| `PORT` | `3030` | The port on the host. |
| `VERSION` | `latest` | The image tag. |
| `DOCKERHUB_USERNAME` | `chevron7locked` | The image namespace. |

### Audio analysis (split stack)

These are read by `docker-compose.yml`. In the all-in-one image the analyzers use the image's own settings, and you change worker counts in Settings under Library Enrichment.

| Variable | Default | What it does |
| --- | --- | --- |
| `AUDIO_ANALYSIS_WORKERS` | `2` | Audio analysis workers, until you set a number in Settings. Each needs about 1 to 1.5 GB of memory, up to 2 to 3 GB at peak. |
| `AUDIO_ANALYSIS_THREADS_PER_WORKER` | `1` | Threads per analysis worker. |
| `AUDIO_BRPOP_TIMEOUT` | `30` | Seconds the analyzer waits for work before checking again. |
| `AUDIO_MODEL_IDLE_TIMEOUT` | `300` | Seconds before an idle analyzer unloads its models. `0` keeps them loaded. |
| `CLAP_WORKERS` | `2` | Vibe embedding workers. |
| `CLAP_THREADS_PER_WORKER` | `1` | Threads per vibe embedding worker. |
| `CLAP_MODEL_IDLE_TIMEOUT` | `300` | Seconds before an idle vibe analyzer unloads its model. |

Audio analysis reads the middle 90 seconds of each song, or the whole song when it is shorter. The vibe analyzer takes five 10-second samples spread across the song and averages them into one sound vector.

### Public vibe feed

Off unless you turn it on. When it is on, one user's library map and live listening are served at `/api/public/vibe` to a server you name, and every request must carry a bearer token.

| Variable | What it is |
| --- | --- |
| `KIMA_PUBLIC_VIBE` | `true` turns the feed on. |
| `KIMA_PUBLIC_VIBE_TOKEN` | The bearer token. At least 32 characters; `openssl rand -hex 32` makes one. |
| `KIMA_PUBLIC_VIBE_USER` | The username whose library and listening are shared. |

If the token or the user is missing, the routes stay off and the log says why.

## Reaching Kima from outside your network

Put a reverse proxy with HTTPS in front of port 3030, and set `SECURE_COOKIES=true`. The browser talks to the web app on 3030, which passes `/api` requests to the API server, so one address is enough.

If you restrict origins, list every address people use to open Kima:

```env
ALLOWED_ORIGINS=http://localhost:3030,https://kima.example.com
```

With the split stack you can also build the web app with `NEXT_PUBLIC_API_URL` set, so the browser calls an API address directly. Leave it empty unless you need that. It is fixed when the web app is built.

## Ports

| Port | What | Where |
| --- | --- | --- |
| 3030 | Web app. The only port you publish. | All setups |
| 3006 | API server | Inside the all-in-one image; published by the split stack |
| 5432 | Postgres | Inside the all-in-one image; published by the split stack |
| 6379 | Redis | Inside the all-in-one image; published by the split stack |
| 5455, 6390 | Postgres and Redis for development | `docker-compose.dev.yml` |

## Storage paths

| Path in the image | What it holds |
| --- | --- |
| `/music` | Your library |
| `/data/postgres` | The database |
| `/data/redis` | Redis data |
| `/data/secrets` | The generated session secret and encryption key |
| `/data/cache` | Cover art and transcoded audio |

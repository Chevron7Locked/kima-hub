# Install and update

This page covers every way to run Kima, how to update it, and how to pick between stable and pre-release images. The short version is in the [README](../README.md#quick-start).

## Which setup

Kima ships as one Docker image that holds the web app, the API server, Postgres, Redis and the two audio analyzers. That image is what most people want. The other Compose files in the repository are variations on it.

| File | What it runs | Use it when |
| --- | --- | --- |
| `docker run chevron7locked/kima` | The all-in-one image | You want the simplest install |
| `docker-compose.prod.yml` | The all-in-one image, with the options in a Compose file | You prefer Compose to a long `docker run` line |
| `docker-compose.server.yml` | The all-in-one image plus Lidarr, Prowlarr, FlareSolverr, qBittorrent and SABnzbd | You want the download tools started alongside Kima |
| `docker-compose.services.yml` | Only those download tools, with no Kima | You want to add them next to an existing install |
| `docker-compose.yml` | Separate backend, frontend, Postgres, Redis and analyzer containers, built from this repository, plus Lidarr, Prowlarr, FlareSolverr, qBittorrent and SABnzbd | You want to build from source or run the parts apart |
| `docker-compose.dev.yml` | Only Postgres, Redis and the audio analyzer, for development | You are working on the code (see [development.md](development.md)) |

The image is published for `linux/amd64` and `linux/arm64`.

## The all-in-one image

```bash
docker run -d \
  --name kima \
  -p 3030:3030 \
  -v /path/to/your/music:/music \
  -v kima_data:/data \
  chevron7locked/kima:latest
```

Open `http://localhost:3030` and create your account. The first account you create becomes the administrator.

Two folders matter:

- `/music` is your library.
- `/data` holds the database, the caches and the secrets Kima generates on first start. Back it up. If you lose it you lose your users, playlists and play history, and the stored credentials can no longer be read.

### With Docker Compose

```yaml
services:
    kima:
        image: chevron7locked/kima:latest
        container_name: kima
        ports:
            - "3030:3030"
        volumes:
            - /path/to/your/music:/music
            - kima_data:/data
        extra_hosts:
            - "host.docker.internal:host-gateway"
        restart: unless-stopped

volumes:
    kima_data:
```

The `extra_hosts` line lets Lidarr reach Kima on Linux. You only need it if you use Lidarr (see [integrations.md](integrations.md#lidarr)).

### Bind-mounting `/data` on Linux

A named volume is simpler. If you bind-mount `/data` instead, create the folders the database and Redis use before the first start:

```bash
mkdir -p /path/to/kima-data/postgres /path/to/kima-data/redis
```

If the startup log reports a permission error, change the owner of the host folder to the user and group ID that the log names.

### What runs inside

A process supervisor starts Postgres, Redis, the API server, the web app and the two analyzers. Only port 3030 is exposed. The API server listens on 3006 and Postgres and Redis on their usual ports, all inside the container.

Docker's health check for the container covers all of it: the web app, the API server's `/health` (which checks Postgres and Redis), the audio analyzer and the sound-vector analyzer (not checked when `DISABLE_CLAP` is `true` or `1`). The container gets 300 seconds to start before failures count. If your own Compose file has a `healthcheck:` block, see [administration.md](administration.md#health-check).

## Updating

```bash
docker compose pull
docker compose up -d
```

With plain `docker run`, pull the image, remove the container and run the same command again. Your data stays in `/data`.

Every update runs any new database migrations when the container starts. Updating from 1.11 to 1.12 also redoes your library's enrichment in the background: the update removes the old sound vectors and analyses every song again, then works out new sound vectors and moods. Your music, playlists, plays, likes, edits, identification and artists stay. Search by sound fills in as songs are done; similar tracks, the vibe map and the mood stations come back once every song has its new sound vector; see the [README](../README.md#how-songs-are-analysed) for timings. From 1.10 or earlier, read the 1.11.0 entry in [CHANGELOG.md](../CHANGELOG.md) first. Migrations do not roll back, so take a copy of the `/data` volume before a major update if you might want to go back.

## Release channels

### Stable

Stable releases are published to Docker Hub and to GitHub's container registry when a version tag is pushed.

```bash
docker pull chevron7locked/kima:latest
# or one version
docker pull chevron7locked/kima:v1.12.1
```

### Pre-release

A release candidate, such as 1.12.0-rc1, is published to Docker Hub and GitHub's container registry, with release notes on the [releases page](https://github.com/Chevron7Locked/kima-hub/releases). It is tagged `:prerelease` and by its own name, such as `:v1.12.0-rc1`, and a running one shows that version, such as `1.12.0-rc1`. It never moves `:latest`.

```bash
docker pull chevron7locked/kima:prerelease
```

Between release candidates the maintainer can also publish a build to GitHub's container registry only. It moves `ghcr.io/chevron7locked/kima:prerelease`, has a tag with its commit, such as `:prerelease-a1b2c3d`, for pinning a build or naming it in a bug report, and shows its version with `-prerelease` after it. Docker Hub's `:prerelease` stays on the last release candidate. Pull those with the `ghcr.io/` prefix (`ghcr.io/chevron7locked/kima:prerelease`), in Compose too: without it Docker reads Docker Hub.

```yaml
services:
    kima:
        image: chevron7locked/kima:prerelease
```

Pre-releases can be unstable. A pre-release applies new database migrations on its first start, and an older image cannot read a database after that. Point it at a fresh data volume and a different port to run it beside your real instance, or back up first.

The old `nightly` image is no longer built. If you still run it, move to a stable release or to the pre-release channel.

## Installing on a phone

Kima is a progressive web app, so a browser can install it to the home screen. It gets Kima's name and icons and opens full screen. The app also offers shortcuts to Vibe, Search and Library.

- Android: open your Kima server in Chrome, open the menu, and choose Add to Home Screen or Install app.
- iPhone and iPad: open your Kima server in Safari, tap Share, and choose Add to Home Screen.

On a television, open Kima in the TV's browser. Kima detects Android TV, Fire TV and Google TV user agents and switches to a layout for a remote control. Adding `?tv=1` to the address forces that layout.

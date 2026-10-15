# Install and update

This page covers every way to run Kima, how to update it, and how to pick between stable and pre-release images. The short version is in the [README](../README.md#quick-start).

## Which setup

Kima ships as one Docker image that holds the web app, the API server, Postgres, Redis and the two audio analyzers. That image is what most people want. The other Compose files in the repository are variations on it.

| File | What it runs | Use it when |
| --- | --- | --- |
| `docker run chevron7locked/kima` | The all-in-one image | You want the simplest install |
| `docker-compose.prod.yml` | The all-in-one image, with the options in a Compose file | You prefer Compose to a long `docker run` line |
| `docker-compose.server.yml` | The all-in-one image plus Lidarr, Prowlarr, FlareSolverr, qBittorrent and NZBGet | You want the download tools started alongside Kima |
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

## Updating

```bash
docker compose pull
docker compose up -d
```

With plain `docker run`, pull the image, remove the container and run the same command again. Your data stays in `/data`.

Every update runs any new database migrations when the container starts. Migrations do not roll back, so take a copy of the `/data` volume before a major update if you might want to go back.

## Release channels

### Stable

Stable releases are published to Docker Hub and to GitHub's container registry when a version tag is pushed.

```bash
docker pull chevron7locked/kima:latest
# or one version
docker pull chevron7locked/kima:v1.12.0
```

### Pre-release

A pre-release is an unreleased build that the maintainer publishes on purpose. It goes to GitHub's container registry only; Docker Hub carries stable releases.

```bash
docker pull ghcr.io/chevron7locked/kima:prerelease
```

`:prerelease` always points at the newest one. Each build also has a tag with its commit, such as `:prerelease-a1b2c3d`, for pinning a build or naming it in a bug report. A running pre-release shows its version with `-prerelease` after it, so you can tell which channel it came from.

In Compose the registry prefix is required. Docker assumes Docker Hub when there is none, and the pre-release is not there:

```yaml
services:
    kima:
        image: ghcr.io/chevron7locked/kima:prerelease
```

Pre-releases can be unstable. A pre-release applies new database migrations on its first start, and an older image cannot read a database after that. Point it at a fresh data volume and a different port to run it beside your real instance, or back up first.

The old `nightly` image is no longer built. If you still run it, move to a stable release or to the pre-release channel.

## Installing on a phone

Kima is a progressive web app, so a browser can install it to the home screen. It gets Kima's name and icons and opens full screen. The app also offers shortcuts to Vibe, Search and Library.

- Android: open your Kima server in Chrome, open the menu, and choose Add to Home Screen or Install app.
- iPhone and iPad: open your Kima server in Safari, tap Share, and choose Add to Home Screen.

On a television, open Kima in the TV's browser. Kima detects Android TV, Fire TV and Google TV user agents and switches to a layout for a remote control. Adding `?tv=1` to the address forces that layout.

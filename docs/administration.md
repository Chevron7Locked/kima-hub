# Administration

Day-to-day running of a Kima server. Most of this is in **Settings**, and most of it is for administrators only.

## Library enrichment

Enrichment is how Kima works out what is in your library. It runs in the background after a scan and covers six steps. Songs on Discover albums are not enriched until a like moves their album into your library (see [Using Kima](using-kima.md#discover)).

| Step | What it does |
| --- | --- |
| Song Identification | Which recording each song is. Kima tries the MusicBrainz tag in the file first, then an AcoustID fingerprint made on this server, then the album's track list, the ISRC (the recording's standard code) and a search by name that checks the title. The progress list shows the fingerprints as their own line. |
| Artist Metadata | Bios, photos, genres and similar artists from Wikipedia, Fanart.tv, Deezer, MusicBrainz and ListenBrainz |
| Audio Analysis | Tempo, key, energy, danceability, and the valence and arousal behind a song's feel, read from the middle 90 seconds of each file |
| Vibe Embeddings | The sound vector for each song, from the CLAP music model |
| Moods | The moods Kima learns for each song, scored from its sound vector, behind the mood mixes, mood stations and song tags |
| Similarity | The matches between songs, and the vibe map, from sound, feel and artist genre |

**Settings > Library Enrichment** shows each step's progress and has these buttons:

- **Sync New:** sync Audiobookshelf (when connected) and start enrichment now instead of waiting for its next run. It does not scan the music folder.
- **Retry what didn't work:** run every incomplete song again. Complete songs are skipped and nothing is deleted.
- **Start over on everything** (admin): process the whole library again. Existing matches are kept and nothing is deleted. It takes about as long as a first enrichment (see [How songs are analysed](../README.md#how-songs-are-analysed)).
- **Re-run from** (admin): pick a step (identification, artists, audio analysis, sound vectors, moods, or similarity and the map) and redo it and everything after it. Every re-run but moods lays out a fresh vibe map. Upgrading from 1.11 needs no button. The update analyses your songs again and gives them new sound vectors in the background.
- **Wipe and re-run** (admin): clear what Kima worked out about your music (which recording each track is, audio analysis, vibe data, moods, the vibe map, artist bios and similar artists) and work it out again. Your music, playlists, plays, likes and edits stay. It takes about as long as a first enrichment (see [How songs are analysed](../README.md#how-songs-are-analysed)), and the vibe map comes back when it finishes. Use it after upgrading to 1.11 or later from 1.10 or earlier, which changes how everything is worked out. One run also covers 1.12's new analysis window.
- **Pause**, **Resume** and **Stop** appear while enrichment is running.

The **Auto sync library** switch below them keeps library changes up to date automatically.

### Speed

- **Metadata Fetch Speed** (1 to 5) sets how many MusicBrainz and metadata requests run at once.
- **Audio Analysis Workers** and **Vibe Embedding Workers** set how many songs are processed at once on the processor. Audio analysis goes up to the number of cores. Each audio analysis worker needs about 1 to 1.5 GB of memory, and up to 2 to 3 GB at its peak, so more workers than your memory allows will slow things down rather than speed them up.
- **Run audio analysis and sound vectors at the same time** is off by default: Kima analyses your songs first, then makes their sound vectors, so each job has the machine to itself. Turning it on asks first, because both jobs then share the processor and the graphics card.
- An NVIDIA graphics card can take over vibe embeddings and audio analysis, on Linux with an x86-64 processor only (see [gpu.md](gpu.md)).

### Caches and clean-up

- **Transcode cache size** sets how much disk the transcode cache may use. The cache holds streams converted to a lower quality. A change applies when saved.
- Under **Maintenance Operations**: **Clear All Caches**, **Cleanup Stale Jobs**, **Re-file Albums by Tags** (see below) and, when analysis has failures, **Retry Failed Analysis.**

### Re-file albums by tags

Older versions could file an album under the wrong artist: a band name cut at "and", "&" or "with", or an album split off under one song's guest. **Re-file Albums by Tags** (Maintenance Operations, admin) reads every song's tags again and moves each album to the artist its songs name, joining it to that artist's copy of the album when there is one. Artists left with no albums are removed. Albums you edited and Discover's albums stay where they are, and plays, likes and playlists stay with their songs. It runs after any library scan, one at a time, and the result appears in your notifications. On a server set up before 1.12, the 1.12 "what's new" window offers the same button to administrators.

## Corrupt tracks

**Settings > Corrupt Tracks** lists files that could not be read in the last scan. **Clear the corrupt marks** removes the marks without deleting anything; the next scan reads each file again and marks the ones that are still broken.

## Users

**Settings > Users** creates accounts with a username, a password of at least 6 characters and a role of User or Admin, and deletes them. Administrators see the server-wide settings; users see only their own. Each account has its own plays, playlists and Subsonic tokens.

If you are locked out of every administrator account, see `ADMIN_RESET_PASSWORD` in [configuration.md](configuration.md#common-options).

## Job queues

Kima runs its background work through job queues. A dashboard for them (Bull Board) is at `/api/admin/queues` on your server's address, for signed-in administrators.

## Admin tools without a button

These endpoints have no screen in the app; call them with a token an administrator made in **Settings > Native Apps**, sent in the `X-API-Key` header.

| Endpoint | What it does |
| --- | --- |
| `POST /api/enrichment/retry` with `{"ids": [...]}` | Tries the listed enrichment failures again (ids from `GET /api/enrichment/failures`). |
| `POST /api/soulseek/connect`, `POST /api/soulseek/disconnect` | Opens or drops the server's one Soulseek connection, which every listener shares. Connecting needs Soulseek set up in Settings first. |
| `GET /api/webhooks/lidarr/verify` | Answers `{"status":"ok"}` with Kima's version, to check that Lidarr can reach Kima. Needs no sign-in. |

## Backups

Everything Kima keeps apart from your music is in `/data` inside the container: the database, Redis, the generated secrets and the caches. See [configuration.md](configuration.md#storage-paths). Back up the volume or the folder mounted there. Stop the container first so the database files are consistent.

Keep the copy of `/data/secrets` with the database. Without the encryption key, the credentials saved in Settings cannot be read.

## Health check

The all-in-one image reports itself healthy only when the whole stack is: the web app answers, the API server's `/health` is OK (which covers Postgres and Redis), the audio analyzer is running and the sound-vector analyzer is running. The sound-vector check is skipped when `DISABLE_CLAP` is `true` or `1`. A check that fails prints one line saying which part failed; `docker inspect --format '{{json .State.Health}}' kima` shows it. The container gets 300 seconds after it starts before failures count. If you wrote your own `healthcheck:` block in a Compose file, replace it with `test: ["CMD", "node", "/app/healthcheck.js"]` and `start_period: 300s` to get the same check. The all-in-one Compose files in this repository (`docker-compose.prod.yml` and `docker-compose.server.yml`) already do. The split `docker-compose.yml` has separate checks for each service instead, and the backend's checks cover only the backend.

## Logs

`docker logs kima` shows what Kima is doing. The `LOG_LEVEL` variable sets how much; see [configuration.md](configuration.md#common-options).

## Updating

See [install.md](install.md#updating).

# Administration

Day-to-day running of a Kima server. Most of this is in **Settings**, and most of it is for administrators only.

## Library enrichment

Enrichment is how Kima works out what is in your library. It runs in the background after a scan and covers six steps:

| Step | What it does |
| --- | --- |
| Song Identification | Which recording each song is, from its MusicBrainz tag, an AcoustID fingerprint made on this server, and MusicBrainz |
| Artist Metadata | Bios, photos, genres and similar artists from Wikipedia, Fanart.tv, Deezer, MusicBrainz and ListenBrainz |
| Audio Analysis | Tempo, key, energy, danceability, and the valence and arousal behind a song's feel, read from the middle 90 seconds of each file |
| Vibe Embeddings | The sound vector for each song, from the CLAP music model |
| Moods | The 22 learned moods for each song, scored from its sound vector, behind the mood mixes, stations and song tags |
| Similarity | The matches between songs, and the vibe map, from sound, feel and artist genre |

**Settings > Library Enrichment** shows each step's progress and has these buttons:

- **Sync New:** sync the library (and Audiobookshelf, when connected) and enrich what is new.
- **Retry what didn't work:** run every incomplete song again. Complete songs are skipped and nothing is deleted.
- **Start over on everything** (admin): process the whole library again. Existing matches are kept and nothing is deleted. It takes about as long as a first enrichment (see [How it is worked out](../README.md#how-it-is-worked-out)).
- **Re-run from** (admin): pick a step (identification, artists, audio analysis, sound vectors, moods, or similarity and the map) and redo it and everything after it. Every re-run but moods lays out a fresh vibe map. Upgrading from 1.11 needs no button: the update analyses your songs again and gives them new sound vectors on its own.
- **Wipe and re-run** (admin): clear what Kima worked out about your music (which recording each track is, audio analysis, vibe data, the vibe map, artist bios and similar artists) and work it out again. Your music, playlists, plays, likes and edits stay. It takes about as long as a first enrichment (see [How it is worked out](../README.md#how-it-is-worked-out)), and the vibe map comes back when it finishes. Use it after upgrading to 1.11 or later from 1.10 or earlier, which changes how everything is worked out; one run also covers 1.12's new analysis window.
- **Pause**, **Resume** and **Stop** appear while enrichment is running.

The **Auto sync library** switch below them keeps library changes up to date automatically.

### Speed

- **Metadata Fetch Speed** (1 to 5) sets how many MusicBrainz and metadata requests run at once.
- **Audio Analysis Workers** and **Vibe Embedding Workers** set how many songs are processed at once on the processor. Audio analysis goes up to the number of cores. Each audio analysis worker needs about 1 to 1.5 GB of memory, and up to 2 to 3 GB at its peak, so more workers than your memory allows will slow things down rather than speed them up.
- An NVIDIA graphics card can take over vibe embeddings and audio analysis; see [gpu.md](gpu.md).

### Caches and clean-up

- **User cache size** and **Transcode cache size** set how much disk each cache may use. The transcode cache holds streams converted to a lower quality; a change to its size needs a restart.
- Under **Maintenance Operations**: **Clear All Caches**, **Cleanup Stale Jobs** and, when analysis has failures, **Retry Failed Analysis.**

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

## Logs

`docker logs kima` shows what Kima is doing. The `LOG_LEVEL` variable sets how much; see [configuration.md](configuration.md#common-options).

## Updating

See [install.md](install.md#updating).

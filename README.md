# Lidify

[![Docker Image](https://img.shields.io/docker/v/chevron7locked/lidify?label=Docker&sort=semver)](https://hub.docker.com/r/chevron7locked/lidify)
[![GitHub Release](https://img.shields.io/github/v/release/Chevron7Locked/lidify?label=Release)](https://github.com/Chevron7Locked/lidify/releases)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

A self-hosted, on-demand audio streaming platform that brings the Spotify experience to your personal music library.

Lidify is built for music lovers who want the convenience of streaming services without sacrificing ownership of their library. Point it at your music collection, and Lidify handles the rest: artist discovery, personalized playlists, podcast subscriptions, and seamless integration with tools you already use like Lidarr and Audiobookshelf.

![Lidify Home Screen](assets/screenshots/desktop-home.png)

---

## A Note on Native Apps

Once the core experience is solid and properly tested, a native mobile app (likely React Native) is on the roadmap. The PWA works great for most cases for now.

Thanks for your patience while I work through this.

---

## Table of Contents

-   [Features](#features)
    -   [The Vibe System](#the-vibe-system)
    -   [Playlist Import](#playlist-import)
-   [Mobile Support](#mobile-support)
-   [Quick Start](#quick-start)
-   [Configuration](#configuration)
-   [Integrations](#integrations)
-   [Using Lidify](#using-lidify)
-   [Administration](#administration)
-   [Architecture](#architecture)
-   [Roadmap](#roadmap)
-   [License](#license)
-   [Acknowledgments](#acknowledgments)

---

## Features

### Your Music, Your Way

-   **Stream your library** - FLAC, MP3, AAC, OGG, and other common formats work out of the box
-   **Automatic cataloging** - Lidify scans your library and enriches it with metadata from MusicBrainz and Last.fm
-   **Audio transcoding** - Stream at original quality or transcode on-the-fly (320kbps, 192kbps, or 128kbps)
-   **Ultra-wide support** - Library grid scales up to 8 columns on large displays

<p align="center">
  <img src="assets/screenshots/desktop-library.png" alt="Library View" width="800">
</p>

### Discovery and Playlists

-   **Made For You mixes** - Programmatically generated playlists based on your library:
    -   Era mixes (Your 90s, Your 2000s, etc.)
    -   Genre mixes
    -   Top tracks
    -   Rediscover forgotten favorites
    -   Similar artist recommendations
-   **Library Radio Stations** - One-click radio modes for instant listening:
    -   Shuffle All (your entire library)
    -   Workout (high energy tracks)
    -   Discovery (lesser-played gems)
    -   Favorites (most played)
    -   Dynamic genre and decade stations generated from your library
-   **Discover Weekly** - Weekly playlists of new music tailored to your listening habits (requires Lidarr)
-   **Artist recommendations** - Find similar artists based on what you already love
-   **Artist name resolution** - Smart alias lookup via Last.fm (e.g., "of mice" → "Of Mice & Men")
-   **Discography sorting** - Sort artist albums by year or date added
-   **Deezer previews** - Preview tracks you don't own before adding them to your library
-   **Vibe matching** - Find tracks that match your current mood (see [The Vibe System](#the-vibe-system))

### Podcasts

-   **Subscribe via RSS** - Search iTunes for podcasts and subscribe directly
-   **Track progress** - Pick up where you left off across devices
-   **Episode management** - Browse episodes, mark as played, and manage your subscriptions
-   **Mobile skip buttons** - Jump ±30 seconds on mobile for easy navigation

<p align="center">
  <img src="assets/screenshots/desktop-podcasts.png" alt="Podcasts" width="800">
</p>

### Audiobooks

-   **Audiobookshelf integration** - Connect your existing Audiobookshelf instance
-   **Unified experience** - Browse and listen to audiobooks alongside your music
-   **Progress sync** - Your listening position syncs with Audiobookshelf
-   **Mobile skip buttons** - Jump ±30 seconds on mobile for easy chapter navigation

<p align="center">
  <img src="assets/screenshots/desktop-audiobooks.png" alt="Audiobooks" width="800">
</p>

### The Vibe System

Lidify's standout feature for music discovery. While playing any track, activate vibe mode to find similar music in your library.

-   **Vibe Button** - Tap while playing any track to activate vibe mode
-   **Audio Analysis** - Real-time radar chart showing Energy, Mood, Groove, and Tempo
-   **Keep The Vibe Going** - Automatically queues tracks that match your current vibe
-   **Match Scoring** - See how well each track matches with percentage scores
-   **ML Mood Detection** - Tracks are classified across 7 moods: Happy, Sad, Relaxed, Aggressive, Party, Acoustic, Electronic
-   **Mood Mixer** - Create custom playlists by adjusting mood sliders or using presets like Workout, Chill, or Focus

<p align="center">
  <img src="assets/screenshots/vibe-overlay.png" alt="Vibe Overlay" width="800">
</p>
<p align="center">
  <img src="assets/screenshots/mood-mixer.png" alt="Mood Mixer" width="800">
</p>

### Playlist Import

Import playlists from Spotify and Deezer, or browse and discover new music directly.

-   **Spotify Import** - Paste any Spotify playlist URL to import tracks
-   **Deezer Import** - Same functionality for Deezer playlists
-   **Smart Preview** - See which tracks are already in your library, which albums can be downloaded, and which have no matches
-   **Selective Download** - Choose exactly which albums to add to your library
-   **Browse Deezer** - Explore Deezer's featured playlists and radio stations directly in-app

<p align="center">
  <img src="assets/screenshots/deezer-browse.png" alt="Browse Deezer" width="800">
</p>
<p align="center">
  <img src="assets/screenshots/spotify-import-preview.png" alt="Import Preview" width="800">
</p>

### Multi-User Support

-   **Separate accounts** - Each user gets their own playlists, listening history, and preferences
-   **Admin controls** - Manage users and system settings from the web interface
-   **Two-factor authentication** - Secure accounts with TOTP-based 2FA

### Custom Playlists

-   **Create and curate** - Build your own playlists from your library
-   **Share with others** - Make playlists public for other users on your instance
-   **Save mixes** - Convert any auto-generated mix into a permanent playlist

### Mobile and TV

-   **Progressive Web App (PWA)** - Install Lidify on your phone or tablet for a native-like experience
-   **Android TV** - Fully optimized 10-foot interface with D-pad/remote navigation
-   **Responsive Web** - Works on any device with a modern browser

<p align="center">
  <img src="assets/screenshots/mobile-home.png" alt="Mobile Home" width="280">
  <img src="assets/screenshots/mobile-player.png" alt="Mobile Player" width="280">
  <img src="assets/screenshots/mobile-library.png" alt="Mobile Library" width="280">
</p>

---

## Mobile Support

### Progressive Web App (PWA)

Lidify works as a PWA on mobile devices, giving you a native app-like experience without needing to download from an app store.

**To install on Android:**

1. Open your Lidify server in Chrome
2. Tap the menu (⋮)
3. Select "Add to Home Screen" or "Install app"

**To install on iOS:**

1. Open your Lidify server in Safari
2. Tap the Share button
3. Select "Add to Home Screen"

**PWA Features:**

-   Full streaming functionality
-   Background audio playback
-   Lock screen and notification media controls (iOS Control Center and Android notifications)
-   Offline caching for faster loads
-   Installable icon on home screen

### Android TV

Lidify includes a dedicated interface optimized for television displays:

-   Large artwork and readable text from across the room
-   Full D-pad and remote navigation support
-   Persistent Now Playing bar for quick access to playback controls
-   Simplified navigation focused on browsing and playback

The TV interface is automatically enabled when accessing Lidify from an Android TV device's browser.

---

## Quick Start

### One Command Install

```bash
docker run -d \
  --name lidify \
  -p 3030:3030 \
  -v /path/to/your/music:/music \
  -v lidify_data:/data \
  chevron7locked/lidify:latest
```

That's it! Open http://localhost:3030 and create your account.

### What's Included

The Lidify container includes everything you need:

-   **Web Interface** (port 3030)
-   **API Server** (internal)
-   **PostgreSQL Database** (internal)
-   **Redis Cache** (internal)

### Configuration Options

```bash
docker run -d \
  --name lidify \
  -p 3030:3030 \
  -v /path/to/your/music:/music \
  -v lidify_data:/data \
  -e SESSION_SECRET=your-secret-key \
  -e TZ=America/New_York \
  --add-host=host.docker.internal:host-gateway \
  chevron7locked/lidify:latest
```

| Variable         | Description            | Default        |
| ---------------- | ---------------------- | -------------- |
| `SESSION_SECRET` | Session encryption key | Auto-generated |
| `TZ`             | Timezone               | UTC            |

### Using Docker Compose

Create a `docker-compose.yml` file:

```yaml
services:
    lidify:
        image: chevron7locked/lidify:latest
        container_name: lidify
        ports:
            - "3030:3030"
        volumes:
            - /path/to/your/music:/music
            - lidify_data:/data
        environment:
            - TZ=America/New_York
        # Required for Lidarr webhook integration on Linux
        extra_hosts:
            - "host.docker.internal:host-gateway"
        restart: unless-stopped

volumes:
    lidify_data:
```

Then run:

```bash
docker compose up -d
```

**Updating with Docker Compose:**

```bash
docker compose pull
docker compose up -d
```

### Bind-mounting `/data` on Linux

Named volumes are recommended. If you bind-mount `/data`, make sure required subdirectories exist and are writable by the container service users.

```bash
mkdir -p /path/to/lidify-data/postgres /path/to/lidify-data/redis
```

If startup logs report a permission error, `chown` the host path to the UID/GID shown in the logs (for example, the postgres user).

---

Lidify will begin scanning your music library automatically. Depending on the size of your collection, this may take a few minutes to several hours.

---

## Release Channels

Lidify offers two release channels to match your stability preferences:

### 🟢 Stable (Recommended)

Production-ready releases. Updated when new stable versions are released.

```bash
docker pull chevron7locked/lidify:latest
# or specific version
docker pull chevron7locked/lidify:v1.2.0
```

### 🔴 Nightly (Development)

Latest development build. Built on every push to main.

⚠️ **Not recommended for production** - may be unstable or broken.

```bash
docker pull chevron7locked/lidify:nightly
```

**For contributors:** See [`CONTRIBUTING.md`](CONTRIBUTING.md) for information on submitting pull requests and contributing to Lidify.

---

## Configuration

### Environment Variables

The unified Lidify container handles most configuration automatically. Here are the available options:

| Variable                            | Default                            | Description                                                                 |
| ----------------------------------- | ---------------------------------- | --------------------------------------------------------------------------- |
| `SESSION_SECRET`                    | Auto-generated                     | Session encryption key (recommended to set for persistence across restarts) |
| `SETTINGS_ENCRYPTION_KEY`           | Required                           | Encryption key for stored credentials (generate with `openssl rand -base64 32`) |
| `TZ`                                | `UTC`                              | Timezone for the container                                                  |
| `PORT`                              | `3030`                             | Port to access Lidify                                                       |
| `LIDIFY_CALLBACK_URL`               | `http://host.docker.internal:3030` | URL for Lidarr webhook callbacks (see [Lidarr integration](#lidarr))        |
| `AUDIO_ANALYSIS_WORKERS`            | `2`                                | Number of parallel workers for audio analysis (1-8)                         |
| `AUDIO_ANALYSIS_THREADS_PER_WORKER` | `1`                                | Threads per worker for TensorFlow/FFT operations (1-4)                      |
| `LOG_LEVEL`                         | `warn` (prod) / `debug` (dev)      | Logging verbosity: debug, info, warn, error, silent                         |
| `DOCS_PUBLIC`                       | `false`                            | Set to `true` to allow public access to API docs in production              |

The music library path is configured via Docker volume mount (`-v /path/to/music:/music`).

#### External Access

If you're accessing Lidify from outside your local network (via reverse proxy, for example), set the API URL:

```env
NEXT_PUBLIC_API_URL=https://lidify-api.yourdomain.com
```

And add your domain to the allowed origins:

```env
ALLOWED_ORIGINS=http://localhost:3030,https://lidify.yourdomain.com
```

---

## Security Considerations

### Environment Variables

Lidify uses several sensitive environment variables. Never commit your `.env` file.

| Variable                  | Purpose                        | Required          |
| ------------------------- | ------------------------------ | ----------------- |
| `SESSION_SECRET`          | Session encryption (32+ chars) | Yes               |
| `SETTINGS_ENCRYPTION_KEY` | Encrypts stored credentials    | Yes               |
| `SOULSEEK_USERNAME`       | Soulseek login                 | If using Soulseek |
| `SOULSEEK_PASSWORD`       | Soulseek password              | If using Soulseek |
| `LIDARR_API_KEY`          | Lidarr integration             | If using Lidarr   |
| `OPENAI_API_KEY`          | AI features                    | Optional          |
| `LASTFM_API_KEY`          | Artist recommendations         | Optional          |
| `FANART_API_KEY`          | Artist images                  | Optional          |

### Authentication & Session Security

-   **JWT tokens** - Access tokens expire after 24 hours; refresh tokens after 30 days
-   **Token refresh** - Automatic token refresh via `/api/auth/refresh` endpoint
-   **Password changes** - Changing your password invalidates all existing sessions
-   **Session cookies** - Secured with `httpOnly`, `sameSite=strict`, and `secure` (in production)
-   **Encryption validation** - Encryption key is validated on startup to prevent insecure defaults

### Webhook Security

-   **Lidarr webhooks** - Support signature verification with configurable secret
-   Configure the webhook secret in Settings → Lidarr for additional security

### Admin Dashboard Security

-   **Bull Board** - Job queue dashboard at `/admin/queues` requires authenticated admin user
-   **API Documentation** - Swagger docs at `/api-docs` require authentication in production (unless `DOCS_PUBLIC=true`)

### VPN Configuration (Optional)

If using Mullvad VPN for Soulseek:

-   Place WireGuard config in `backend/mullvad/` (gitignored)
-   Never commit VPN credentials or private keys
-   The `*.conf` and `key.txt` patterns are already in .gitignore

### Generating Secrets

```bash
# Generate a secure session secret
openssl rand -base64 32

# Generate encryption key
openssl rand -base64 32
```

### Network Security

-   Lidify is designed for self-hosted LAN use
-   For external access, use a reverse proxy with HTTPS
-   Configure `ALLOWED_ORIGINS` for your domain

---

## Integrations

Lidify works beautifully on its own, but it becomes even more powerful when connected to other services.

### Lidarr

Connect Lidify to your Lidarr instance to request and download new music directly from the app.

**What you get:**

-   Browse artists and albums you don't own
-                 Request downloads with a single click
-   Discover Weekly playlists that automatically download new recommendations
-   Automatic library sync when Lidarr finishes importing

**Setup:**

1. Go to Settings in Lidify
2. Navigate to the Lidarr section
3. Enter your Lidarr URL (e.g., `http://localhost:8686`)
4. Enter your Lidarr API key (found in Lidarr under Settings > General)
5. Test the connection and save

Lidify will automatically configure a webhook in Lidarr to receive notifications when new music is imported.

**Networking Note:**

The webhook requires Lidarr to be able to reach Lidify. By default, Lidify uses `host.docker.internal:3030` which works automatically when using the provided docker-compose files (they include `extra_hosts` to enable this on Linux).

If you're using **custom Docker networks** with static IPs, set the callback URL so Lidarr knows how to reach Lidify:

```yaml
environment:
    - LIDIFY_CALLBACK_URL=http://YOUR_LIDIFY_IP:3030
```

Use the IP address that Lidarr can reach. If both containers are on the same Docker network, use Lidify's container IP.

### Audiobookshelf

Connect to your Audiobookshelf instance to browse and listen to audiobooks within Lidify.

**What you get:**

-   Browse your audiobook library
-   Stream audiobooks directly in Lidify
-   Progress syncs between Lidify and Audiobookshelf

**Setup:**

1. Go to Settings in Lidify
2. Navigate to the Audiobookshelf section
3. Enter your Audiobookshelf URL (e.g., `http://localhost:13378`)
4. Enter your API key (found in Audiobookshelf under Settings > Users > your user > API Token)
5. Test the connection and save

### Soulseek

For finding rare tracks and one-offs that aren't available through traditional sources, Lidify has built-in Soulseek support.

**Setup:**

1. Go to Settings in Lidify
2. Navigate to the Soulseek section
3. Enter your Soulseek username and password
4. Save your settings

Lidify connects directly to the Soulseek network - no additional software required.

---

## Using Lidify

### First-Time Setup

When you first access Lidify, you'll be guided through a setup wizard:

1. **Create your account** - The first user becomes the administrator
2. **Configure integrations** - Optionally connect Lidarr, Audiobookshelf, and other services
3. **Wait for library scan** - Lidify will scan and catalog your music collection

### The Home Screen

After setup, your home screen displays:

-   **Continue Listening** - Pick up where you left off
-   **Recently Added** - New additions to your library
-   **Library Radio Stations** - One-click radio modes (Shuffle All, Workout, Discovery, Favorites, plus genre and decade stations)
-   **Made For You** - Auto-generated mixes based on your library
-   **Recommended For You** - Artist recommendations from Last.fm
-   **Popular Podcasts** - Trending podcasts you might enjoy
-   **Audiobooks** - Quick access to your audiobook library (if Audiobookshelf is connected)

### Searching

Lidify offers two search modes:

**Library Search** - Find artists, albums, and tracks in your collection. Results are instant and searchable by name.

**Discovery Search** - Find new music and podcasts you don't own. Powered by Last.fm for music and iTunes for podcasts. From discovery results, you can:

-   Preview tracks via Deezer
-   Request downloads through Lidarr
-   Subscribe to podcasts

<p align="center">
  <img src="assets/screenshots/desktop-artist.png" alt="Artist Page" width="800">
</p>
<p align="center">
  <img src="assets/screenshots/desktop-album.png" alt="Album Page" width="800">
</p>

### Managing Podcasts

1. Use the search bar and select "Podcasts" to find shows
2. Click on a podcast to see its details and recent episodes
3. Click Subscribe to add it to your library
4. Episodes stream directly from the RSS feed - no downloads required

Your listening progress is saved automatically, so you can pause on one device and resume on another.

### Creating Playlists

1. Navigate to your Library and select the Playlists tab
2. Click "New Playlist" and give it a name
3. Add tracks by clicking the menu on any song and selecting "Add to Playlist"
4. Reorder tracks by dragging and dropping
5. Toggle "Public" to share with other users on your instance

### Using the Vibe System

1. Start playing any track from your library
2. Click the **vibe button** (waveform icon) in the player controls
3. Lidify analyzes the track and finds matching songs based on energy, mood, and tempo
4. Matching tracks are automatically queued - just keep listening
5. The vibe overlay shows a radar chart comparing your current track to the source

**Using the Mood Mixer:**

1. Open the Mood Mixer from the home screen or player
2. Choose a quick mood preset (Happy, Energetic, Chill, Focus, Workout) or create a custom mix
3. Adjust sliders for happiness, energy, danceability, and tempo
4. Lidify generates a playlist of matching tracks from your library

### Importing Playlists

**From Spotify:**

1. Copy a Spotify playlist URL
2. Go to Import (in the sidebar)
3. Paste the URL and click Preview
4. Review the results - you'll see which tracks are in your library, which can be downloaded, and which aren't available
5. Select albums to download and start the import

**From Deezer:**

1. Browse featured playlists directly in the Browse section, or paste a Deezer playlist URL
2. The same preview and import flow applies
3. Explore Deezer's curated playlists and radio stations for discovery

### Playback Settings

In Settings, you can configure:

-   **Playback Quality** - Choose between Original, High (320kbps), Medium (192kbps), or Low (128kbps)
-   **Cache Size** - Limit how much space transcoded files use

<p align="center">
  <img src="assets/screenshots/desktop-player.png" alt="Now Playing" width="800">
</p>
<p align="center">
  <img src="assets/screenshots/desktop-settings.png" alt="Settings" width="800">
</p>

### Keyboard Shortcuts

When using the web interface, these keyboard shortcuts are available during playback:

| Key         | Action                   |
| ----------- | ------------------------ |
| Space       | Play / Pause             |
| N           | Next track               |
| P           | Previous track           |
| S           | Toggle shuffle           |
| M           | Toggle mute              |
| Arrow Up    | Volume up                |
| Arrow Down  | Volume down              |
| Arrow Right | Seek forward 10 seconds  |
| Arrow Left  | Seek backward 10 seconds |

### Android TV

Lidify includes a dedicated interface optimized for television displays:

-   Large artwork and readable text from across the room
-   Full D-pad and remote navigation support
-   Persistent Now Playing bar for quick access to playback controls
-   Simplified navigation focused on browsing and playback

The TV interface is automatically enabled when accessing Lidify from an Android TV device. Access it through your TV's web browser.

---

## Administration

### Managing Users

As an administrator, you can:

1. Go to Settings > User Management
2. Create new user accounts
3. Delete existing users (except yourself)
4. Users can be assigned "admin" or "user" roles

### System Settings

Administrators have access to additional settings:

-   **Lidarr/Audiobookshelf/Soulseek** - Configure integrations
-   **Storage Paths** - View configured paths
-   **Cache Management** - Clear caches if needed
-   **Advanced** - Download retry settings, concurrent download limits

### Download Settings

Configure how Lidify acquires new music in Settings → Downloads:

-   **Primary Source** - Choose between Soulseek or Lidarr as your main download source
-   **Fallback Behavior** - Optionally fall back to the other source if the primary fails
-   **Stale Job Cleanup** - Clear stuck Discovery batches and downloads that aren't progressing

### Enrichment Settings

Control metadata enrichment in Settings → Cache & Automation:

-   **Enrichment Speed** - Adjust concurrency (1-5x) to balance speed vs. system load
-   **Failure Notifications** - Get notified when enrichment fails for specific items
-   **Retry/Skip Modal** - Choose to retry failed items or skip them to continue processing

### Activity Panel

The Activity Panel provides real-time visibility into downloads and system events:

-   **Notifications** - Alerts for completed downloads, ready playlists, and import completions
-   **Active Downloads** - Monitor download progress in real-time
-   **History** - View completed downloads and past events

Access the Activity Panel by clicking the bell icon in the top bar (desktop) or through the menu (mobile).

### API Keys

For programmatic access to Lidify:

1. Go to Settings > API Keys
2. Generate a new key with a descriptive name
3. Use the key in the `Authorization` header: `Bearer YOUR_API_KEY`

API documentation is available at `/api-docs` when the backend is running (requires authentication in production).

### Bull Board Dashboard

Monitor background job queues at `/admin/queues`:

-   View active, waiting, completed, and failed jobs
-   Retry or remove stuck jobs
-   Monitor download progress and enrichment tasks
-   Requires admin authentication

---

## Architecture

Lidify consists of several components working together:

```
                                    ┌─────────────────┐
                                    │   Your Browser  │
                                    └────────┬────────┘
                                             │
                                             ▼
┌─────────────────┐              ┌─────────────────────┐
│  Music Library  │◄────────────►│     Frontend        │
│   (Your Files)  │              │   (Next.js :3030)   │
└─────────────────┘              └──────────┬──────────┘
                                            │
                                            ▼
┌─────────────────┐              ┌─────────────────────┐
│    Lidarr       │◄────────────►│      Backend        │
│   (Optional)    │              │  (Express.js :3006) │
└─────────────────┘              └──────────┬──────────┘
                                            │
┌─────────────────┐              ┌──────────┴──────────┐
│ Audiobookshelf  │◄────────────►│                     │
│   (Optional)    │              │  ┌───────────────┐  │
└─────────────────┘              │  │  PostgreSQL   │  │
                                 │  └───────────────┘  │
                                 │  ┌───────────────┐  │
                                 │  │     Redis     │  │
                                 │  └───────────────┘  │
                                 └─────────────────────┘
```

| Component  | Purpose                 | Default Port |
| ---------- | ----------------------- | ------------ |
| Frontend   | Web interface (Next.js) | 3030         |
| Backend    | API server (Express.js) | 3006         |
| PostgreSQL | Database                | 5432         |
| Redis      | Caching and job queues  | 6379         |

---

## Roadmap

Lidify is under active development. Here's what's planned:

-   **Native Mobile App** - React Native application for iOS and Android
-   **Offline Mode** - Download tracks for offline playback
-   **Windows Executable** - Standalone app for Windows users who prefer not to use Docker

Contributions and suggestions are welcome.

---

## License

Lidify is released under the [GNU General Public License v3.0](LICENSE).

You are free to use, modify, and distribute this software under the terms of the GPL-3.0 license.

---

## Acknowledgments

Lidify wouldn't be possible without these services and projects:

-   [Last.fm](https://www.last.fm/) - Artist recommendations and music metadata
-   [MusicBrainz](https://musicbrainz.org/) - Comprehensive music database
-   [iTunes Search API](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/) - Podcast discovery
-   [Deezer](https://developers.deezer.com/) - Track previews
-   [Fanart.tv](https://fanart.tv/) - Artist images and artwork
-   [Lidarr](https://lidarr.audio/) - Music collection management
-   [Audiobookshelf](https://www.audiobookshelf.org/) - Audiobook and podcast server

---

## Support

If you encounter issues or have questions:

1. Check the [Issues](https://github.com/chevron7locked/lidify/issues) page for known problems
2. Open a new issue with details about your setup and the problem you're experiencing
3. Include logs from `docker compose logs` if relevant

---

_Built with love for the self-hosted community._

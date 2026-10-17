# Using Kima

A tour of the web app once it is running. Setup is in [install.md](install.md).

## First start

The first account you create becomes the administrator. When setup finishes, Kima scans your music folder and starts enrichment in the background: five steps that work out each song's sound, feel and genres and then build the map. The vibe map and the match data appear when enrichment has finished, which takes roughly 1 minute per 100 songs on a 16-core machine (see [How it is worked out](../README.md#how-it-is-worked-out)). Progress is shown in **Settings > Library Enrichment**; see [administration.md](administration.md).

## Home

The home page shows the sections that have something to show:

- **Library Radio:** one-click stations. Shuffle All, Workout (high energy), Discovery (lesser-played) and Favorites (most played), plus stations for your common genres and decades.
- **Continue Listening** and **Recently Added.**
- **Made For You:** generated mixes. The **Mood Mixer** button beside it makes a playlist from one of the five moods: Upbeat, Melancholic, Calm, Intense or Energetic — or, with an AI provider configured, from a free-text description via the **AI Mix** tab ([AI Mix](#ai-mix)).
- **Recommended:** artists picked from your listening.
- **Popular Artists** (from ListenBrainz) and **Featured Playlists** (from Deezer).
- **Popular Podcasts** and **Audiobooks.**

### AI Mix

The **AI Mix** tab in the Mood Mixer turns a free-text description into explicit selection parameters: a target for the sound (valence, energy), a tolerance, a length, an era range, and genre include/exclude lists. The AI only does the translation into parameters; selecting your library's tracks stays deterministic. The first step always produces a preview: the parameters appear in an editable form and the matched tracks are listed. Nothing is created until you hit **Save playlist**, and then only the parameters as you left them in the form. The admin's global genre/artist exclusions always apply, and the max-length guardrail is clamped into the form before anything is resolved.

Enable it under **Settings → AI Playlists** (admin only): provider, base URL, model, API key, a maximum playlist size, and global exclusions, with a **Test connection** check before you save. Without an API key the tab is hidden.

## The vibe map

Open **Vibe** in the sidebar. Your library appears as a 3D space where songs that match sit close together. How matching works is described in the [README](../README.md#the-vibe-engine).

- Click a star to select it. A panel shows the song with four actions. Double-click a star to play it.
- Right-click a star for a menu with the same actions.
- **Play** plays the song.
- **Match Vibe** replaces the queue with the song and its 50 closest matches.
- **Similar** lights up the 50 closest matches on the map without changing the queue.
- **Song Path** starts a path from this song. Then click the song the path should end on.
- The search box at the top finds songs and artists by name. Song Path and Blend can also pick songs from a description of the sound; a description matches on sound only, because a sentence has no feel or genre.
- The mood buttons list the moods in your library, largest first. Pick one to light up its songs.

### Song Path

Pick a start and an end, either a song, an artist or a sound, and choose **Generate Path**. Kima queues a run of songs that moves from one to the other.

### Blend

Add songs to **More Like** and, if you want, songs to **Less Like.** Kima finds the songs that match the first group and not the second, and builds a playlist from them.

## Searching

The search page has the tabs **All Results**, **Library** and **Discover**. Library results are your artists, albums, tracks, podcasts and audiobooks. Discover finds music and podcasts you do not own. When Soulseek is connected, a **P2P Network** tab appears; see [integrations](integrations.md#soulseek).

## Playlists

The Playlists page makes new playlists, public or private. A public playlist is visible to the other accounts on your server. Add a song from the menu on any track and drag to reorder.

A playlist page has a share button. It makes a link that anyone can open without an account, and the page plays the songs. You can import playlists from other services; see [integrations](integrations.md#importing-playlists).

## Podcasts and audiobooks

Search for a show on the Podcasts page and subscribe. Episodes stream from the show's own feed, and Kima saves your place so you can carry on from another device.

Audiobooks come from [Audiobookshelf](integrations.md#audiobookshelf). Your place is saved back to it.

## Stats

The Stats page shows what you replay most, which artists make up most of your listening, and how much of your library you have never played, over the last 30 days, the last 12 months or all time. The full player shows how many times you have played the current song.

## Playback

Streaming quality is set in **Settings > Playback**: Original, 320, 192 or 128 kbps. See [configuration.md](configuration.md).

Keyboard shortcuts in the web app:

| Key | Action |
| --- | --- |
| Space | Play or pause |
| N | Next track |
| P | Previous track |
| S | Shuffle on or off |
| M | Mute or unmute |
| Up, Down | Volume up or down by 10% |
| Right, Left | Seek forward or back 10 seconds |

N, P and S work on music; the other keys also work on podcasts and audiobooks.

## On a phone or a TV

Kima installs to the home screen from the browser; see [install.md](install.md#installing-on-a-phone). On a television browser Kima switches to a separate television layout.

## Other apps

Apps that speak the Subsonic API can play from Kima. See [subsonic.md](subsonic.md).

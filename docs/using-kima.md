# Using Kima

A tour of the web app once it is running. Setup is in [install.md](install.md).

## First start

The first account you create becomes the administrator. When setup finishes, Kima scans your music folder and starts enrichment in the background: six steps that identify each song, work out its sound, feel, moods and genres, and then build the map. The vibe map and the match data appear when enrichment has finished, which can take a couple of hours for a large library (see [How songs are analysed](../README.md#how-songs-are-analysed)). Progress is shown in **Settings > Library Enrichment** (see [administration.md](administration.md)).

## Home

The home page shows the sections that have something to show:

- **Library Radio:** one-click stations. Shuffle All, Workout (high energy), Discovery (lesser-played) and Favorites (most played), plus stations for your common genres and decades, and the 14 mood stations, such as Calm, Road Trip, Wildcard and Late Night.
- **Continue Listening** and **Recently Added.**
- **Made For You:** generated mixes. The **Mood Mixer** button beside it makes a playlist from one of the five moods: Upbeat, Melancholic, Calm, Intense or Energetic.
- **Recommended:** artists picked from your listening.
- **Popular Artists** (from ListenBrainz) and **Featured Playlists** (from Deezer).
- **Popular Podcasts** and **Audiobooks.**

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

The Podcasts page starts with what you are partway through and the newest episode from each show you follow, then shows picked from your shows' categories, the top charts from Apple Podcasts, and a row of top shows for every other category. Search for a show, play its first episode to get a feel for it, and follow it. Episodes stream from the show's own feed, and Kima saves your place so you can carry on from another device.

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

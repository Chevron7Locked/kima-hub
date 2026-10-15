# Privacy

Kima is software that runs on your machine. This page says exactly what it does with data, and what I, the author, receive from your instance: nothing.

## Nothing is collected, by design

No telemetry. No analytics. No crash reporting. No "help us improve" pings. No update checker that phones a server. The parts that do the phoning home in a typical app are not present in this codebase, and the app sends nothing to me from your install.

Accounts in Kima are local to your instance, the way accounts on a file server are local to it. Your usernames, passwords, sessions, and two-factor secrets live in your database and nowhere else. There is no Kima sign-in, no license check, no registration, and no server of mine your instance talks to.

The exceptions are the boring infrastructure kind: pulling the Docker image counts as a pull on Docker Hub, and this repository counts GitHub traffic the way any project's does. That is all I get from your installation, and it's the same for every download of any open-source software.

## What your server talks to, and why

Kima reaches out to third-party services for features you use, the same way your current streaming apps do. These calls go out from your machine, so your IP address travels with them like it does with any website visit:

| Service | Why Kima calls it | What goes out |
|---|---|---|
| MusicBrainz, Wikidata, Wikipedia | Album/artist metadata, genres, biographies | Artist and album names, MBIDs, ISRCs |
| Cover Art Archive, Deezer image CDN | Album artwork | Album names, MBIDs |
| AcoustID | Identifying files with missing tags | An audio fingerprint of the file plus its claimed name |
| LRCLIB | Lyrics | Track, artist, album, duration |
| ListenBrainz | Similar artists and scrobbling | Only if you connect your account; then your plays, to your own account |
| Apple Podcasts (iTunes) | Podcast search, charts, categories, show details | Your search text; the chart country set in Settings; the Apple ids of shows Kima lists for you, opens or you follow |
| Deezer, Spotify, YouTube | Playlist import and previews | Only the playlist links you paste, using credentials you supply |
| Lidarr, Soulseek, Audiobookshelf | Downloads and audiobooks | Your own servers, your own network |

Every one of these calls is a lookup: a name, a fingerprint, a playlist link. The only flows that carry what you listen to are services you deliberately connect, scrobbling to your own ListenBrainz account being the obvious one. Play history and your library listing stay in your database everywhere else. Metadata enrichment can be paused per source in settings, and features you never touch (podcasts, imports, scrobbling) never make a call.

Your browser also fetches some album art directly from remote CDNs when the artwork shown came from Deezer or the Cover Art Archive. Same story: an image request from your browser to a public CDN, carrying the album it's for.

## What is stored, and where

Everything Kima knows lives in your database, on your machine: your library, play counts, playlists, sessions, and the service credentials you choose to store (encrypted at rest with a key that lives in your config, nowhere near me). The `/api/metrics` endpoint exists for monitoring tools you run yourself; it serves your machine and talks to nobody. Backups, retention, and who else sees any of it are entirely yours.

One consequence of Kima being software you run: if you host it for family, friends, or the public, you are the data controller for that instance. Access, retention, and deletion are yours to administer, and this policy binds them to nobody else.

## The one future thing, said before it exists

A planned feature is a shared embedding store: a public database of precomputed audio embeddings, so a new Kima can skip re-analyzing music that has already been analyzed somewhere else and start with a working vibe map on day one.

Making that work means an instance has to be able to ask "do you have this track?" by fingerprint, the same shape of lookup AcoustID already does. That means anonymous query data would exist: which track fingerprints got looked up. Not your identity, not your play history, not a listing of your library, not an account. Just fingerprints of music, which is what the whole idea rests on.

Today's code has none of this. If and when it ships, this page gets updated in the same release, the lookup will be opt-out-able from settings, and the changelog will say so plainly. I am telling you now, in a document you can diff against the code, because a privacy policy that only admits things after they ship is not a privacy policy.

## In short

I do absolutely zero tracking and have zero interest in how you use Kima. If you ever find code that contradicts this page, that's a bug, and I want to hear about it: open an issue.

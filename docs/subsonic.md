# Subsonic and OpenSubsonic clients

Kima speaks the [OpenSubsonic](https://opensubsonic.netlify.app/) API at `/rest`, so music apps that support Subsonic can play from your library. The Kima web app does not use this API; it is there for other apps.

## Connect a client

1. In Kima, open **Settings > You > Apps**.
2. Type a name for the client, such as "Phone", and choose **Generate Token**.
3. Copy the token. It is shown once.
4. In the client, enter:
   - **Server address:** where you open Kima, such as `http://192.168.1.10:3030`
   - **Username:** your Kima username
   - **Password:** the token

Give each client its own token. The same page lists your tokens, and revoking one disconnects only that client.

Clients that have a separate "API key" field can use the token there.

## How sign-in works

Kima accepts, in this order:

1. An API key, sent as `apiKey=`.
2. The password field (`p=`). Kima first checks whether the value is one of your tokens, then checks it against your account password.

Kima does not support the older token scheme in which the client sends a hash of the password and a salt (`t=` and `s=`). That scheme needs the server to keep the secret in plain text, and Kima stores tokens hashed. A client that can only use that scheme will not sign in; most clients fall back to sending the password.

If you turn on two-factor authentication for your account, your account password stops working in Subsonic clients, because the protocol has no way to ask for a code. Use a token instead.

## What is supported

- **Browsing:** artists, albums, songs, genres, folders, album lists and random songs.
- **Search:** `search`, `search2` and `search3`.
- **Playing:** streaming, downloads, cover art, lyrics, scrobbling and now playing, and the transcoding endpoints (`hls`, `getTranscodeDecision` and `getTranscodeStream`).
- **Playlists:** list, read, create, update and delete.
- **Queue and bookmarks:** saving and restoring the play queue, by id or by position, and bookmarks.
- **Starring and ratings:** star, unstar, starred lists and `setRating`.
- **Similar songs and artist info:** `getSimilarSongs`, `getSimilarSongs2`, `getTopSongs`, `getArtistInfo` and `getArtistInfo2`.
- **Podcasts:** list, newest episodes, episode details and refresh.
- **Shares:** create, list, update and delete share links.
- **Users:** an administrator can list, create, update and delete users.
- **Library scan:** `startScan` and `getScanStatus`.

OpenSubsonic extensions announced to clients: `apiKeyAuthentication`, `songLyrics`, `indexBasedQueue` and `getPodcastEpisode`.

Not supported: chat, video, captions, the jukebox and internet radio. Listing calls for these answer empty, except `getCaptions` and `jukeboxControl`, which answer with an error. Calls that would change something answer with an error rather than pretending to succeed.

Artist descriptions and genres that clients see come from Kima's metadata enrichment, not only from file tags.

## Notes

- Songs and albums that Discover downloaded as suggestions are left out of search, browsing and album lists until a like moves them into your library.
- The route code lives in `backend/src/routes/subsonic/`, one file per area. `index.ts` there applies the sign-in and rate limit and holds the system endpoints. The sign-in itself is in `backend/src/middleware/subsonicAuth.ts`.

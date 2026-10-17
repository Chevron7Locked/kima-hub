# Changelog

All notable changes to Kima will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] - nightly

### Added

- **Untagged albums get their real MusicBrainz id.** An album whose files carry no MusicBrainz album id is now identified once from all its songs' AcoustID answers: the album more than half of its songs agree on, under its own title (edition words like "Deluxe" aside, but "Live" kept apart), becomes its id. It then gets Cover Art Archive covers, Lidarr ownership, Discover's "already owned" check and its year, label and genres, and its songs take their details from one album request. Library albums only; generic titles ("Greatest Hits") and albums the votes can't settle are left alone, and a file's own album tag always replaces an id chosen this way. On a 9,151-song test library, 331 of 489 untagged albums would be identified; with the tags of 426 tagged albums hidden, the vote named 373 of the 374 it decided exactly as their tags do.
- **The player is a named "now playing" region**, so a screen reader can jump straight to it.

### Changed

- **Turning the GPU switches off keeps the GPU download.** It used to delete the roughly 3.4 GB runtime when both switches went off, so switching back on meant another 2 GB download. Now it stays on disk and does nothing until a switch is on again (a download still running when the last switch goes off is stopped). To free the space, stop Kima and delete the download by hand; the GPU guide (`docs/gpu.md`) says where it is for each install type.
- **Audio analysis and sound vectors take turns.** Sound vectors start once audio analysis has no songs left, instead of running beside it, so the two heavy models never share the processor and the GPU. New songs are analysed first, then given vectors. Songs added during a vector run wait for the songs CLAP is working on, then go first. An analyzer that has stopped holds nothing back. Admins who want both at once can turn on "Run audio analysis and sound vectors at the same time" in Settings, under Library Enrichment, or beside the wipe-and-re-run button in the release window; it warns about the load first. `GET`/`PUT /api/analysis/together`.
- **Songs are identified by their sound first.** A file whose tags don't say which recording it is now goes to AcoustID (audio fingerprints) before any MusicBrainz search, ten songs per request, and each reply is kept so no song is asked twice. Its ISRCs and genres then come from one MusicBrainz request per album (the album AcoustID lists under your album's title, or the album your tags name) instead of one request per song; songs AcoustID doesn't recognise, or matches only by length and not by title, still get the MusicBrainz name search first.
- **Your shows can be sorted by latest episode.** The podcasts page's "episodes" sort ordered shows by how many episodes they have; it is now "latest episode", the show that published most recently first. `GET /api/podcasts` gives each show's `latestEpisodeAt`.
- **"More like this" on a show you haven't followed** ranks shows by the categories they share, as it does for a followed show, instead of listing its first category's chart. New endpoint: `GET /api/podcasts/preview/:itunesId/similar`.

### Fixed

- **A podcast download cut off by the host no longer leaves a half file in the cache.** Kima deleted the partial file while it was still being closed, so it could reappear; it now waits for the file to close first.
- **On a TV remote, a row that loads in above you no longer moves you onto another row.** The remote reads where the focus really is, remembers each row's column by the row itself, and starts a row at its first card from its "show all" link.
- **A setting saved in the old encrypted format can no longer come back as garbage.** Values stored before 1.10's encryption change had no tamper check, so read with the wrong key they came back as random bytes about one time in 256 instead of being refused; and a value saved under the oldest key form was missed when the current key happened to pass. Kima now accepts only text, tries both key forms, and otherwise asks for the setting to be re-entered.
- **Songs of one album no longer fail when they save the same new genre at the same moment.** Two songs finishing together both tried to create the genre, and one failed with a duplicate-name error until its retry.
- **Two songs of one album asked about at once share one MusicBrainz tracklist request** instead of each making its own.
- **Playing music no longer leaves a "not found" error in the browser's console** once per session. The player sent a report the server had no use for on most installs; the server now tells the player up front whether to send it.
- **Song previews play again.** Every 30-second preview (in search, browse playlists, and album and artist pages for songs you don't own) answered "not found": Deezer stopped honouring the search Kima used to find them. Previews are now found with a plain search, matched by artist and title with or without the credits Deezer adds ("feat. …", "Radio Edit"), and a well-known song buried under covers in that search is found among its artist's own popular songs.
- **Artist photos and related artists come from the right artist.** Two Deezer lookups took the first artist with the name you asked for, which can be an obscure namesake ranked above the real one; they now take the most-followed artist of that name, as the artist page's popular songs already did.
- **Members can no longer start downloads through a playlist import while downloads are operator-only.** Importing a playlist without choosing albums still searched Soulseek for every song not in the library and downloaded it; it now does that only for someone allowed to download, and an import queued before an admin switched member downloads off no longer downloads either. Songs a member's import can't match stay on the playlist's pending list for an operator to retry.
- **Playlists stay current on all your open devices.** Your other open devices used to see only a reorder as it happened (and a finished import adding its playlist to their list). Now every change reaches them as it happens: creating, renaming, making public or reversing a playlist; adding, removing or reordering its songs, or removing a song still being looked for; hiding or deleting it; saving a mix or a What's-new mood mix; a Subsonic app's changes; playlist imports (Spotify, Deezer, M3U) and the songs they find later; and songs leaving the library (deleting a song, album or artist, clearing Discover, or a scan removing songs whose files are gone). A device showing a playlist deleted elsewhere closes it, including when it only learns of the delete because the playlist answers "not found". When the live connection drops and comes back, the app refreshes what that connection keeps current (playlists, notifications, downloads, albums, enrichment progress, recently added and your imports); before, it refreshed only notifications and downloads. Someone else viewing your public playlist doesn't see your changes live; they show up when that person's page loads it again.
- **Quick edits to a playlist no longer undo each other on screen.** Each answered edit fetched the playlist while later ones were still on their way, so those briefly vanished; and when several edits in a row failed with no connection, the playlist could be left showing one of them as done. Now the playlist is fetched once the last edit is answered, and put back as it was only if none of them went through.
- **Saving a mix as a playlist works when some of its songs have left the library.** The save failed and left an empty playlist behind, which then blocked a retry as "already saved". Songs no longer in the library are left out; if none are left, the save says so and makes no playlist.
- **A Subsonic app's playlist change naming a song that doesn't exist changes nothing.** A rename sent with it was applied before the song failed, and creating a playlist with such a song left an empty playlist. The whole request is now refused with "not found".
- **TV mode's Back works on every page, and only when nothing else on the page uses it.** Back (the Escape key) returned to the tab row only on pages built of TV rows, and only with a card focused; on an artist or album page, or once the focus was lost, it did nothing. It now returns to the tab row from anywhere in the page. And Back that closed something (the sleep timer, a playlist rename, the What's new window, the sidebar's menu or new-playlist box, the library filter panel, podcast search results, an open hour on the listening clock, the stats page's shortcut list) or left the TV search box also jumped to the tab row; now it only does the one thing.
- **A song whose fingerprint was retried asks AcoustID once it has one.** A song whose audio fingerprint failed could only be identified by name, and when retrying it from the failures screen then gave it a fingerprint, its identification stayed closed as "no match" without ever asking AcoustID. It now asks as soon as the fingerprint is stored. A retagged file is also read again before its songs are asked about in a batch, and a batch answer that has expired is asked again.
- **Checking a show for new episodes says what went wrong.** A feed that is gone answers "not found" and one that doesn't answer (or answers with a web page) "try again shortly", instead of a server error.
- **A show's categories are read from its feed correctly.** Categories written with single quotes were missed, and a category tag inside an episode was taken as the show's.
- **Saving podcast progress without a length keeps the length already saved,** instead of setting it to zero.
- **Category rows on the iOS podcasts screen ask Apple only for real categories,** each once, so an unknown or repeated id no longer costs a request to Apple.
- **The podcast search box no longer claims to be a keyboard-navigable list.** It told screen readers to expect arrow-key movement it never had; its results are now plain buttons, reached with Tab.

- **A What's new choice that fails to save says so** in the notification tray, instead of quietly switching back.
- **The changelog page shows what you just did.** Answering or running something from the release window now updates `/changelog` straight away, and the page reads the server again on every visit, so an item that finished meanwhile (a re-run of the library) shows as done.
- **Subsonic apps that search with `search2` get results again.** Kima answered `search2` under the old `search` label, so apps that read `searchResult2` found nothing.
- **A list page asked for a negative or garbled starting point answers normally** instead of with a server error: albums, artists, songs, the removal log, enrichment failures and Subsonic album lists. A Subsonic album list asked for a negative size no longer counts back from the end.
- **Covers whose host can't be reached say "try again shortly"** instead of a server error, including a connection that drops twice in a row, and a host name that doesn't exist is no longer reported as a refused address.
- **When Deezer's request limit is reached, Kima waits and asks again.** Deezer answers a quota hit as an ordinary reply, so it was taken as a success and the lookup simply failed; and a failed request no longer leaves Browse's featured playlists empty for a day. Several lookups of the same artist's popular songs at once now share one request. And any outside service (MusicBrainz, Deezer, Apple and the rest) that answers again after a burst of "too many requests" is used again at once, instead of every request waiting out the rest of a minute.
- **Seeking reaches the end of a song whose file is longer than its tagged length,** as the progress bar already showed.
- **Reconciling one playlist's waiting songs touches only that playlist.** `POST /api/playlists/:id/pending/reconcile` ran the reconcile over every user's playlists.
- **The player's song title is no longer a page heading.** The full-screen player added a second top-level heading over the page behind it, and the three players marked the title three different ways.
- **The last podcast or audiobook position is saved when you close or leave the page.** The save sent as the page closed was cancelled by the browser; it is now sent so the browser finishes it.
- **A podcast episode or audiobook you listen to the end stays finished.** At the end of a file the browser reports a pause just before the end, and the player saved that pause as "not finished" alongside the "finished" save; whichever arrived last won, so finished episodes sat in "continue listening" at 100% or more. Pausing, closing the page or switching away after the end no longer saves over it either.
- **The next episode plays when one ends, and the player's next button works for podcasts.** "Next" was the next row of the show's page (newest first, so the older episode), and only when playback started there; resuming from "continue listening" just stopped. It is now the show's next episode by release date that you haven't finished, wherever playback started. New endpoint: `GET /api/podcasts/:podcastId/episodes/:episodeId/next`. Unfollowing the show you were last playing also forgets that it was playing, so your next sign-in doesn't try to bring it back.
- **An episode listened past 95% counts as finished.** It leaves "continue listening" and "next" skips it; replaying it from early on makes it unfinished again. The 95% is measured against the audio's own length as the player reads it, never the feed's listed length (which runs minutes short of audio with ads stitched in). Episodes saved past their listed end before this are marked finished once, when the server upgrades.
- **Unfollowing a show forgets that one of its episodes was playing,** so the player no longer comes back to an episode of a show you've left.
- **Leaving a page in the middle of a save no longer reports an error.** An answer cut off as the page closed was logged as "failed to save podcast progress" even though the server had already saved it.
- **The enrichment bars reach 100% when every song that's there is done.** Songs whose files are gone (an album replaced by a better copy, say) held every bar short of 100; they're now left out and shown as "files missing" beside the count. The bar called "Mood Tags" is "Song Identification": it always counted which recording each song is (AcoustID and MusicBrainz), not moods, which come from audio analysis.
- **A show whose feed couldn't be read once stops being listed as failing** the next time its feed is read. A moment without network kept every show it touched on the enrichment failures list for good, and the message said the feed couldn't be parsed when it couldn't be reached.
- **Changing an album's MusicBrainz id no longer drops its ownership protection.** The album editor's id change relabelled the album's "owned" record as coming from enrichment, which could let the nightly integrity check move a library album into Discover; it also created ownership where there was none and left Discover exclusions and compilation ownership behind. Every record keyed on the old id now moves with it, keeping its source.

## [1.12.0] - 2026-10-14

**Upgrading.** Coming from 1.10, read 1.11.0 below first: its one-time wipe and re-run of enrichment is still needed, and that one run also analyses every song the 1.12 way (the middle 90 seconds, see Changed). Already re-ran under 1.11? Re-run from audio analysis in Settings → Library Enrichment to get the new readings.

### Added

- **Podcasts, browsed like a podcast app.** Discovery comes from Apple Podcasts' own charts and categories instead of keyword searches (the old "top podcasts" was a search for the word "podcast"). The podcasts page leads with episodes in progress across every show and each followed show's newest unplayed episode, then "for you" rows from the categories of the shows you follow, every category to browse with its chart, and the top shows. "More like this" ranks shows by how many of a show's categories they share. Search covers shows on Apple Podcasts and the episodes of shows you follow. A show you haven't followed shows its description, categories and newest 20 episodes with summaries, and plays its first episode (usually the one where the hosts explain the show), streamed from the feed and not stored. Deezer is no longer used for podcasts, and the old keyword recommender and its table are gone. Operators choose the chart country in Settings → Podcasts (default United States). New endpoints for clients: `GET /api/podcasts/categories`, `/charts?category=`, `/for-you`, `/listening`, `/preview/:itunesId/snippet`; podcast responses add `categories`.
- **Per-step enrichment reruns.** Settings → Library Enrichment now has a step picker that re-runs from identification, artists, audio analysis, sound vectors, or similarity — each clears itself and what genuinely depends on it (re-running artists keeps analysis and vectors; identification starts from scratch), and always similarity and the vibe map, since the formula reads all three. The full wipe-and-rerun is unchanged.
- **Update pings.** Every 24 hours Kima checks GitHub's releases API for newer versions. When one is found, an amber dot appears on the version number in the app; tapping it opens the release's What's New window. The check can be turned off in Settings → Storage.
- **A permanent changelog.** Every release's note and items stack newest first at `/changelog` and are never overwritten by the next version. Closing the release window marks it read, not done: anything a release still needs from you stays listed there and closes itself when the server sees it happen. The version number opens unread news, otherwise the changelog.
- **The library follows your disk.** A track whose file **two consecutive scans** cannot find is removed, with everything attached to it (plays, likes, playlist entries), and its title, artist and album are written to a removal log first. No timer: the next scan confirms. If 10 or more tracks and over 10% of the library vanish at once, nothing is removed — that is a dropped drive, not a deletion. Admins can read the log at `GET /api/library/removals`. A song replaced by another copy on the same album (an mp3 upgraded to flac, say) hands its plays, likes, playlist places and bookmarks to the copy before it goes. An empty music folder (a drive that isn't mounted) marks nothing missing. Songs already flagged missing before upgrading are removed by the first scan after it. To keep the old behaviour (flag missing files, never remove them), set `RECONCILE_MODE=flag`.
- **An ordered play queue for iOS.** `GET /api/library/artists/:id/play-tracks` returns only the fields a queue needs (id, title, track/disc number, duration, album cover, artist name) in canonical server order — effective year desc, title asc, disc/track within album. MusicBrainz preview rows are excluded (they carry no file). The album set is the one the artist page marks owned; the endpoint returns it in its own canonical order, which the client consumes as-given, without the artist's full discography payload.

### Changed

- **The release window says "What's new" everywhere.** In wide mode the back button used to read "{sender}'s note" (confusing — it navigates to the overview, not a note). Now it says "What's new" on every screen size.
- **Open item highlight is more visible.** The background went from 0.07 to 0.13 with a subtle inset ring, so it clearly differs from the item hover state.
- **Downloading is operator-only by default.** Downloads cost money, use peer networks and fill the disk, so members can no longer start them unless the operator turns on Member Downloads in Settings → Download Preferences. Deleting stays operator-only either way, and the server enforces it at every download entry point; members keep browsing and searching. The weekly Discover run follows the same rule. The app shows download buttons only to people allowed to use them, and a member's playlist import keeps the songs already in the library and downloads nothing.
- **Audio analysis listens to the middle of each song.** It reads the middle 90 seconds instead of the last 90, so a fade-out, a silent tail or a hidden track after minutes of silence no longer stands in for the song (one track read as near silence because 84 of its last 90 seconds were silent). Tempo, key, energy, danceability, moods and the stored valence and arousal come from this window; the sound vectors behind matching and the vibe map already sample the whole song and do not change. Songs analysed before 1.12 keep their readings until they are analysed again: 1.11's wipe and re-run does it for libraries that have not had it yet, and a re-run from audio analysis does it for the rest.
- **Playlists can flip to reverse order.** A toggle next to shuffle reverses the list — the display order, the queue built from it, and it's remembered per playlist. Stored order and drag-to-reorder are untouched: dragging in the reversed view lands where it looks, not mirrored. (`?order=rev` works on the API too.)

### Fixed

- **Podcast episode lengths.** Ad networks stitch ads into episodes when they're downloaded, so the length a feed lists runs short (Dungeons and Daddies episodes measured 7–10% longer than listed). Kima now measures each cached episode's real length and stores it, and the first play, before the episode is cached, gets the real size from the host instead of the size the feed declares (which the browser turned into a length off by over half an hour). The player's clock no longer freezes at the listed length, and seeking reaches the real end. A malformed progress save answers 400 (or 404 for an unknown episode) instead of 500.
- **Podcast downloads judged by what the host sends.** A download from a host that states no file size was measured against the size the feed declares, which can belong to another file, so complete episodes were thrown away three times and never cached. And a connection dropped in the first moments of a download left the episode marked as downloading until the server restarted. Downloads are now judged only by the host's own size, and a stored episode's size is the size of the file Kima holds.
- **Touch-screen hover-reveal controls** on artist and album pages now respond to taps. Before, the controls that appear on hover were stuck off on touch screens (8 places fixed: play/edit/queue/lyrics on album and artist pages).
- **Preview stream range requests** (the artist and playlist preview-stream endpoints) now forward `Range` headers through the shared preview proxy (`proxyPreviewStream`), and are tested against a local upstream server that answers with a real 206.
- **Subsonic `search3` with an empty query** enumerates the library (same as `getAlbumList2`) instead of returning an empty response.
- **Lidarr's webhook check reports Kima's version.** It answered "unknown" in the published image, which starts the server with `node` rather than `npm` and so never set the variable it read.
- **Collection-page delete controls** no longer show to non-admins (the backend already enforced it; the UI now gates on the signed-in user's role, which it previously ignored).
- **The analyzer refuses impossible loudness readings.** A measurement outside −70…0.5 LUFS, or a range past 60 LU, is a meter or decoder failure, not music — one once reached the database as +2868 LUFS. It is now stored as no measurement, with a warning naming the file. Quiet real audio passes untouched.
- **`prisma migrate dev` works again.** The 1.11 play-heard migration read Prisma's own migration table without checking it exists, so replaying the history onto a fresh database (`migrate dev`'s shadow database, or a raw SQL replay) failed there. `migrate deploy` was unaffected. The full history now applies clean to an empty database.
- **A song whose file is back is no longer missing.** A track flagged missing by one scan kept the flag after its file was found again (a file moved to another disk and linked back, for example), and could then be removed. The flag now clears whenever a scan finds the file.
- **Following a show twice, or one whose feed moved, works.** Following looked for a stored show by feed address only, so a show Apple had moved to a new feed address, a double click, or two people following the same new show at once failed with a server error. It now finds the show by its feed or its Apple id and adds the follow once.
- **Podcast failures say what happened.** An unknown category, a show Apple doesn't know, or a host refusing an episode answers "not found"; an Apple outage answers "try again"; and a bad reply from Apple is no longer remembered as "no shows" for hours. Following a feed says whether nothing is there, the host is not answering, or what it sent is not a feed.
- **Leaving or reopening a page no longer reports errors.** Requests the browser cancels when you leave a page were logged as failures, and a page brought back from the background on a phone could stop reporting real errors at all.
- **The page after onboarding** no longer starts a second Audiobookshelf sync (or logs errors when Audiobookshelf is off).
- **Moving a song in a playlist shows at once**, reversed or not, instead of after the page refreshes.
- **Episode artwork shows on every show page.** Episodes with their own art were drawn straight from the feed's host, which the app's security policy blocks for most hosts, so their art was missing (and errors were logged). It now loads through Kima, like every other image.
- **Escape in a confirmation closes only the confirmation**, not the window behind it, and focus goes back to the button that opened it.
- **A show you just followed appears in search right away**, and one you removed disappears.
- **The artist play queue skips rows it cannot stream.** `play-tracks` now serves only library-owned albums with uncorrupt files still on disk — the same rule the search doors use — so a failed or still-pending download can no longer ride into an iOS queue as a 404. (Live example on the test stack: the endpoint served 413 rows where 410 were playable.)

### Security

- **Redirects are checked at every hop.** Kima checked only the first address of a feed, episode, cover or link it fetched; a redirect could then send it to an address inside your network (a cloud metadata service, say), which any signed-in member could read back through Kima. Every redirect is now checked, internal addresses are recognised however they are written (IPv6 forms of IPv4 addresses included), and a name that resolves to an internal address is refused when Kima connects.
- **Signing out clears what the app remembered.** The next person to sign in on the same tab could see the last person's cached answers (playlists, shows, search results) for a few minutes. The app now forgets them on sign-out.
- **A show's Apple id can't be claimed by another feed.** Following stored whatever Apple id came with the request, so a member could tie a real show's id to their own feed, and others following that show by its id got the impostor. An id is now kept only when Apple confirms it belongs to that feed.
- **Search no longer shows other people's shows.** Podcast and episode search read every show on the server, so a member saw the shows other users follow. Results now come only from the shows you follow.
- `transformers` bumped from 4.57.6 to 5.10.4 in both `services/audio-analyzer-clap/requirements.txt` and the all-in-one image's runtime pip install. Fixes CVE-2026-4372, CVE-2026-5241 and CVE-2026-9856 (model-loading RCE class). The gate asserts bit-identical output (mel filter bank, window, mel spectrograms, 512-d audio and text embeddings, token ids — all identical on the shipped fixtures). The sha-gated ONNX export stage keeps its own pin on 4.57.6 (the export is torch-based and would not load a newer release under the same condition). The security nightly's "Dependency & Secret Scan" now reports zero HIGH/CRITICAL findings.

## [1.11.0] - 2026-10-12

### Added

- **The Stats page.** Everything on it is computed from your own listening: most-replayed tracks, the artists that carry half of everything you play, how much of your library has never been heard, and how habits shift between weeks, months, and all time. Play counts in the player come from the same listen definition; tracks never played say so instead of showing zero. Includes `verify-stats.ts` (67 independent cross-checks) and ten live end-to-end journeys covering the four destructive audit buttons with database-level verification.
- **An update window.** It opens on a note from Kevin and a short list of what's new; each line opens its own page with the buttons and links for it. The copy says plainly what each thing does.
- **Scrobbling to ListenBrainz, opt-in.** Plays are recorded locally as always; setting a ListenBrainz user token mirrors each play to ListenBrainz's open API. Fire-and-forget: never awaited, rejections logged, no token means skipped, a ListenBrainz outage cannot fail a play or touch stats. The token is stored encrypted.
- **Similar artists rebuilt for discovery.** Candidates come from ListenBrainz's similar-artists data first (the same as its artist pages; free, no key, no account), with Deezer related artists as fallback; your library re-ranks the merged list by up to ±0.1 on the same matching as the vibe features, so taste leans yours without hiding anyone. Artists not in your library are flagged `inLibrary: false` so they can be offered for download.
- **Track identification without ISRC.** A file's own MusicBrainz recording tag answers first; then its album's tracklist (one request answers every song on the album, the earliest official release, and on a compilation the song credited to the track's artist), a title-checked MusicBrainz name search, and AcoustID fingerprint lookup (fpcalc) for the rest. Resolution outcomes are counted per path so the mix is observable.
- **A queue-length setting** in Settings > Playback (default 10000, min 100, max 100000).
- **A public vibe feed, off by default.** With `KIMA_PUBLIC_VIBE=true`, a token and a username set (see `.env.example`), `/api/public/vibe` serves the owned library as one gzipped export (positions, moods, nearest tracks; suggested albums and missing files are left out) and that user's listening as it happens: play, pause, seek, skip, stop and up-next, from the web player and from Subsonic clients' now-playing. That user gets a "Share what I'm playing" switch under Settings → Scrobbling; off, the feed reads `hidden` and drops their plays until it is turned back on. Subsonic clients do not report pausing, so a paused phone app reads as playing until the track's length plus 30 seconds has passed, then stopped. Without the variable the routes do not exist.
- **The vibe analyzer is now ONNX** — torch-free, reproducible from public sources. The audio and text ONNX exports are built from the public `laion/clap-htsat-unfused` checkpoint and verified against fixed hashes at build time; the mel-spectrogram path is vendored as pure numpy so the stack runs without torch. Sound vectors from 1.10 came from a different model under the same name, so they are made again on upgrade.
- **A choice about your saved mood mix.** Moods were being read backwards, so a mood mix saved before 1.11 was picked from the wrong values. The release window asks what to do with it: rebuild it, keep it, or save it as an ordinary playlist (saving and rebuilding can be combined). A mix saved under a mood 1.11 removed (High Energy, Focus Mode, Deep Feels, Acoustic Vibes) can no longer be shown, so it offers save-as-playlist or remove instead, and is asked about again on the next visit until answered. Nothing is deleted until the user chooses.
- **NVIDIA GPU, opt-in.** Two switches in Settings, one for vibe embeddings and one for audio analysis, so you choose which steps use the GPU. The first switch turned on downloads about 2 GB of pinned packages into the data folder (about 3.4 GB on disk); they are removed when both are off, so nobody who leaves them off pays in image size or behaviour. Flip a switch and, within about a minute, the analyzer it belongs to finishes the songs it is on and restarts itself on or off the GPU. Audio analysis on the GPU is checked against the CPU's answers at every start; if it disagrees, or fails mid-run, analysis runs on the CPU. Settings says when a switch is still applying, when the GPU session fell back to the CPU, and when the analyzer that does the download is not running.
- **Wipe and re-run enrichment.** Admins can clear what enrichment worked out (audio analysis, vibe data, the vibe map, artist bios, genres and similar artists) and run the whole library through the engine again, from the 1.11 window or Settings under Library Enrichment. The library, which recording and artist each file is, artist images, playlists, plays, likes and edits stay.
- **A fifth enrichment step, Similarity.** It runs after vibe embeddings, computes each track's feel once, keeps the library's matching statistics current and lays out the vibe map; Settings shows its progress. A newly embedded track joins matching and the map when the step has run (seconds while enrichment is busy).

### Changed

- **Vibe matching uses sound, feel and artist genre.** Similar tracks, recommendations from a track, Alchemy, Song Path, the public export's nearest tracks and the similar-artists re-rank now share one formula: how a track sounds (CLAP), how it feels (valence and arousal read from the sound and set against your own library's range, weight 0.25), and its artist's MusicBrainz genres (weight 0.25, counted only between different artists). Every list holds at most 2 tracks per album and 4 per artist. Text search still matches on sound alone; radio stations and artist radio are unchanged. The feel weights are derived from the DEAM dataset and licensed separately (see the README).
- **Song Path answers 400 for a track that has not been analysed yet.** It answered 500.
- **The vibe map is a picture of the matching.** Each track sits where the same formula places it among its closest matches (sound, feel and artist genre), laid out by UMAP's published method in Kima's own code; on a 9,027-track library 68% of each track's 10 closest matches sit among its 50 nearest stars. The similarity step lays a library's map out once and then places each new track among the others: a track that has a place never moves, and every server computes the same map. The page only draws it. The home view frames the map on any screen, phone included.
- **The vibe map opens without mood names.** The tag button shows them; the choice is remembered.
- **The vibe map looks like a universe.** Each song is a crisp star, a bright few over a faint many; a very faint glow sits behind everything and sparse stars in the far distance give it depth, as in Kima v2's galaxy. Songs stay exactly where the matching places them; the fog around clusters and the coloured glow on them are gone.
- **A phone on its side gets more room.** On short landscape screens the top bar, the bottom bar (icon beside its label) and the mini player are slimmer on every page, so the content shows about 180 px instead of 110.
- **The vibe map on phones is rebuilt.** Search across the top with the two map buttons beside it, the moods in one row under it, Song Path and Blend on the right edge in thumb reach, and a sheet that shows only its handle until you pick a song. Song Path from the toolbar and from a song are now the same feature.
- **Lyrics scroll inside their own box.** Opening them no longer slides the whole app sideways.
- **Everything is lowercase.** Every page, menu, dialog, tooltip and dropdown shows lowercase text, as in Kima v2. Typed, copied and submitted text keeps its case, and keys, codes and addresses show exactly as they are.
- **Lyrics open inside the full-screen player on desktop.** The button opened them in the side panel, behind the player.
- **Audio analysis keeps every worker busy.** Workers take the next track as soon as they finish one; before, they took tracks ten at a time and waited for the slowest, so at most ten were ever busy. Moving the workers slider while enrichment runs no longer caps it at 8.
- **Audio analysis runs MusiCNN on ONNX Runtime, without TensorFlow.** The models are Essentia's own, converted when the image is built; the build fails unless they give Essentia's answers (on 16 library tracks the stored values agree within 0.000004). The image no longer carries two copies of TensorFlow.
- **Sound vectors take one model call per track** instead of five.
- **The new Kima mark.** The logo in the app is the waveform in the new gradient, amber at the top through rose and violet to azure, its colour gently shifting like the mobile app's; still when the system asks for reduced motion.
- **Last.fm is gone, replaced everywhere.** No API keys, no account, nothing to configure:
  - Similar artists: ListenBrainz → Deezer → local audio re-rank (above).
  - Artist name resolution (aliases, misspellings): MusicBrainz.
  - Track genres ("mood tags"): MusicBrainz recording genres.
  - Artist biographies: Wikidata.
  - Artwork: Deezer → Cover Art Archive → Fanart for albums; Fanart → Deezer for artists.
  - Discover charts: ListenBrainz sitewide top artists.
  - Identification: the file's MusicBrainz tag → the album's tracklist → MusicBrainz name search (title-checked) → AcoustID fingerprint.
  - Scrobbling: optional ListenBrainz mirror; local play tracking needs nothing.
- **Database:** `Track.lastfmTags` is dropped: since the Last.fm service was deleted it held MusicBrainz genre tags, which now live in the genre tables. Four dead Last.fm columns are dropped from `SystemSettings`, and so are the nightly-only `publicVibeEnabled` and `publicVibeUserId` (the public feed is configured by environment variables now). If you keep dashboards or scripts against `lastfmTags`, point them at the genre tables.
- **The galaxy map is the only vibe view.** The old Map view (deck.gl grid) and its toggle are gone; the Vibe page renders the 3D galaxy on every screen. Clicking a star shows that song over the right side of the map, with its moods, energy and valence and Play, Match Vibe, Similar and Song Path, and the map stays clickable around it; on phones the song opens in a sheet at the bottom. The former "you" star and its neighbour highlight are gone.

### Removed

- **The old map positions.** Migration `matching_map` drops the three position columns on `track_embeddings` and the map's Redis copy is no longer kept; the similarity step lays every library out again from its own data.
- **API routes nothing in Kima calls.** Scripts that used them need updating: the old manual enrichment controls under `/api/enrichment` (`/start`, `/full`, `/skip`, the four `/reset-*` routes, `/repair-covers`, `/settings` and `DELETE /failures`); `/api/analysis/start`, `/status`, `/features`, `/analyze/:trackId` and `/vibe/retry`; `/api/listening-state`; `/api/mixes/mood` with its presets and saved preferences (the mood mixer's `/api/mixes/mood/buckets` routes stay); `/api/browse/radios` and `/api/browse/genres`; `/api/homepage/genres` and `/top-podcasts`; `/api/search/genres`; `/api/podcasts/sync-covers`; `/api/downloads/keep-track`; `/api/audiobooks/debug-series`; the queue-cleaner start, stop and status routes (stuck Discover batches and Spotify imports are now recovered on a schedule); and `/api/system-settings/test-lastfm`. The Subsonic API, share links and the public vibe feed are unchanged.
- **The iOS audio debug log**, its page and its upload route.
- **Two settings nothing could use:** `User.moodMixParams`, written only by the removed `/api/mixes/mood` routes, and the Lidarr bundle size limit, which no screen could set; a bundle is grabbed whatever its size.
- **Mood radio's tag fallback.** A mood other than the five moods, high-energy, acoustic and instrumental now answers 400 instead of an empty station.
- **`CLAP_SLEEP_INTERVAL` and `AUDIO_ANALYSIS_INTERVAL`.** Neither changed anything; the analyzers wait on their queues (`AUDIO_BRPOP_TIMEOUT` still sets how long).
- **Artwork consolidation.** `backend/src/services/artwork.ts` is the single artwork door; the four previous call paths (including `imageProvider.ts`) are absorbed into it. Each of albums and artists walks one ordered source list and takes the first real answer; a source that throws is not evidence of absence.

### Fixed

- **Audio analysis reads stereo correctly.** Tempo, key, energy and the mood scores were computed from a garbled signal; a re-run of enrichment recomputes them.
- **Enrichment restarts after Stop, and after a server restart.** Run Enrichment and wipe and re-run lift a stop or pause; a restart no longer blocks enrichment for up to four hours.
- **ListenBrainz receives your listens.** Plays were sent in a format ListenBrainz rejects.
- **Spotify playlist imports find songs that arrive later** for artists with many tracks or multi-word names, and no longer add another artist's song with the same short title.
- **Radio, shuffle and the Similar Artists mix skip missing or broken files.**
- **A cover or picture that failed to load is retried** instead of being remembered as "none" for a day; the Popular Artists row on Home shows pictures.
- **Soulseek: the Test button works for slskd setups**, and download preferences are no longer greyed out for them.
- **A wrong password or 2FA code says so** instead of "Not authenticated".
- **Copy buttons work on plain-http installs** (recovery codes, Subsonic tokens, share links).
- **Queue buttons show on phones and to keyboard users.**
- **The same song played twice in a row counts twice.**
- **Vibe map:** Blend's buttons stay reachable on short screens; song path and similar say why they failed; Escape closes Song Path and Blend; vibe queues always play in order; the camera no longer jumps home when the window is resized.
- **Songs are matched to the right recording.** Every way Kima identifies a song (its ISRC, its album's tracklist, a name search, its audio fingerprint) now checks the title, the version (remix, live, acoustic...), the artist and the length before accepting an answer; before, an ISRC or a name search took the first hit. A file's own MusicBrainz recording tag is used first. Wipe and re-run checks every song again.
- **An artist's MusicBrainz id comes from the right tag.** When the artist name came from the album-artist tag, the id was taken from the track-artist tag. An artist whose stored id belongs to someone else loses it, with the bio, genres and similar artists that came with it; local artist images stay.
- **A failed Wikidata lookup keeps the artist's bio** instead of replacing it and remembering the failure for 30 days.
- **Artists with more than 100 releases** have their whole catalogue checked.
- **A late or repeated report from an analyzer can no longer overwrite a finished step**, and retrying failed analysis or rebuilding embeddings no longer reopens tracks whose files are missing.
- **Audio analysis measures what it says.** Mono files are analysed at their real level (they were read 3 dB quiet); loudness is EBU R128 loudness and loudness range; danceability comes from the danceability model; silence and tracks under 3 seconds get no tempo, key or mood instead of made-up ones. Older analyses are redone on upgrade.
- **A song whose audio can't be read in full gets no sound vector** and is retried, instead of a vector averaged from the parts that loaded.
- **Analysis and sound-vector times are stored correctly** on servers whose clock is not set to UTC (they were 5 hours off).
- **Audio analysis listens to the end of each song.** It reads the last 90 seconds, where songs build to, instead of the first 90.
- **Audio analysis never stores guesses.** If the analysis models are missing or fail, the song is retried instead of being given moods, valence and danceability estimated from its key and tempo.
- **Enrichment finishes instead of starting over.** A song's identification is no longer handed out again after 30 seconds while it waits its turn, a job handed out again does no work, and waiting for an outside service no longer counts as a failed try. Only real failures use up a song's four tries.
- **An artist whose lookup keeps failing stops being retried every cycle** after four failures, and an artist left half-done by a restart is picked up again. A failed similar-artists source no longer wipes the similar artists already stored.
- **A malformed MusicBrainz id in a file's tags is ignored** rather than sent to MusicBrainz and Wikidata.
- **A song whose fingerprint can't be made is still identified** by its tags and a name search; it was closed unidentified.
- **An artist is asked again after a MusicBrainz outage** instead of being marked done without its genres.
- **Upgrading works on a database Kima's user doesn't own** (an external Postgres); the clock setting falls back to the user's own.
- **Sound-vector building keeps up with the worker slider.** Raising workers past the count set at startup exhausted the analyzer's database connections and wedged songs mid-embed; the pool now follows the live slider, always kept under the server's own connection limit.
- **The sound-vector stage starts and stays running.** A refactor stopped its worker 125 milliseconds after launch and the progress ledger froze without an error; it was proven running again at concurrency 16 and 24.
- **GPU switches appear only where a GPU can exist** — Linux with an NVIDIA card the server can see. They were offered on every platform and did nothing elsewhere.
- **The app opens in browsers that block storage.** Private-mode and blocked-storage browsers crashed the API client on load; sign-in now keeps working in memory and the app opens.
- **A song's genres are its recording's own MusicBrainz genres** whichever way it was identified; songs identified from their album's tracklist were given crowd tags or, without them, the album's genres. Spotify playlist import and shared links pick MusicBrainz's recording by title, version, artist and length too, instead of taking its first answer. On upgrade each album's tracklist is fetched once more (two MusicBrainz requests per album).
- **Enrichment says it is finished only when it is.** It waited for neither identification answers due a retry nor artists still being looked up, and a question someone set aside counted as still to do, which also kept the vibe map from being laid out.
- **Audio analysis reads the real end of a song** when the file's header gives a shorter length than the audio has.
- **Mood tags read what was measured.** A song whose tempo could not be read was tagged slow, and a valence or energy of exactly 0 was read as middling, so those songs missed "sad" and "calm".
- **A vibe started from the map shows its match score** in the full player, as one started from the player does.
- **One song preview plays at a time on every page,** and the main player resumes when a preview stops, ends or fails; a preview that could not play left it paused.
- **Removing a podcast that fails says so** instead of doing nothing.
- **Carousel arrows and track play buttons show for the keyboard,** not only for the mouse; the previous and next episode rows are buttons.
- **A second "Sync library" press within five seconds is no longer silently ignored.** The server already refuses a scan while one is running.
- **The activity panel's tabs have names.** Screen readers heard only the unread count ("15"); each tab is now named and says whether it is open, and the panel toggle points at the panel it opens on desktop.
- **A file that cannot be read is no longer counted as added.** The scan counted every new file before reading it, so an unreadable file showed up as "added" on every scan while never reaching the library. It now counts only as an error.
- **Podcast subscribe returns 422 on an unreadable feed, not 500.**

### Security

- **Next.js 16.3.8 and proxy-addr 2.0.8.** Patch updates for published advisories: Next.js 16.0 to 16.3.7, and proxy-addr's client-address check, which IPv4-mapped IPv6 addresses could get past. The production dependencies of both apps now audit clean.

### Infrastructure

- **The public export's nearest-track lists are computed in a worker thread**, and one export builds at a time: a library change during a build is built once that build ends.
- **Enrichment hardening.** Failed status is genuine (crash-safe boot, honest route responses), the false-heartbeat hang class is gone, and a corrupted file can no longer disable all embeddings.
- **Backend route tests keep one server per test app.** Handed a bare app, supertest opened a new server on a fresh port for every request; under parallel workers a request sometimes reached the wrong socket and the suite failed on a different test each time (a 303 or 404 from another app, or an HTTP parse error). A test app now keeps one server until its file finishes.
- **A gate journey file for the features the walkthrough never touched:** the notification tray, ListenBrainz scrobbling, the public library export and live feed, the GPU switch, and the release window.
- **Migrations for upgraders from 1.10:** 44 of them, applied automatically by `npm run db:migrate` on deploy. Among them: the track-embeddings constraint repair restores the primary key, foreign key, HNSW index and model-version index; `matching_engine` adds the similarity step's tables; `matching_map` drops the old map position columns; `analysis_v4` and `sound_vector_label` have every song analysed and given a sound vector again; `database_clock_utc` sets the database clock to UTC. The boot-time fake migration rows the old Dockerfile wrote are gone.

## [1.10.1] - 2026-08-25

### Added

- **A window that tells you what changed, and asks before it assumes.** After an update, Kima shows the release once: what changed, anything you can run, and anything it needs permission for. Closing it is a real answer — every permission you did not touch is recorded as declined, at its default, which is always off. Nothing is left blank for later code to read as a yes. A permission you did switch on survives closing the window; it is not a retraction.
- **A one-off repair for play history recorded under the old rule.** Offered in that window and permanently in Settings. It looks first and shows what it found: how many plays it can prove were skips, how many it cannot tell about, and a sample of the actual rows. Only then does a button appear that removes anything.

  The evidence is the gap to the next play. A play followed eight seconds later by another ran for at most eight seconds, whatever else was happening — so it cannot have met the threshold. A *long* gap proves nothing either way, so those are kept, along with the last play of every session, which has nothing following it to bound it. On a test history of 1,700 plays built from 836 deliberate skips, it found 836 and misclassified none of the real listening.

### Changed

- **A play now means somebody listened.** A `Play` row was written the moment the stream endpoint was hit, so skipping through an album recorded a play for every track and nobody had heard any of them — and that history feeds the vibe profile, recently-played and the decay model. The rule is now Last.fm's, restated verbatim by ListenBrainz: longer than 30 seconds, and played for half its length or four minutes, whichever comes first.

  The stream endpoint records nothing at all — requesting bytes is not listening. The web player measures real listening and reports it, the server decides, and a track whose length is unknown gets the four-minute bound rather than a free pass, so never scanning a file is not the cheapest way to log a play. Repeats inside five minutes collapse to one. Subsonic clients keep choosing their own moment to scrobble, which is what the contract says, but the 30-second floor is enforced server-side whatever a client claims.

  Existing rows are still stream-starts. The decay model fades them out on its own, and `Play.source` still distinguishes the Subsonic ones if you ever want to audit the cutover.


## [1.10.0] - 2026-08-23
### Added

- **Playlists can be reordered by drag.** The playlist detail page now has a GripVertical drag handle plus ChevronUp/ChevronDown move-up/move-down buttons on every track row; order persists via the existing lexoRank backend (`PATCH /playlists/:id/items/:itemId/move`) and syncs to other tabs and devices over the `playlist:updated` SSE live-update channel (TanStack Query invalidation on both `["playlists"]` and `["playlist", id]`).

### Fixed
- **iOS background audio holds through interruptions and track changes.** Playback no longer dies after a call, Siri, a notification, or toggling earbuds/headphones, and the multi-second gap between tracks no longer strands the player. The AudioContext now resumes alongside (not before) `play()` so the iOS autoplay grant is preserved on auto-advance; a load-deadline timer covers the inter-track `loading` window the recovery ladder previously ignored; the audio session re-arms on foreground and route changes; and the lock-screen transport reflects buffering state.
- **Collections pagination buttons stay enabled during fetches.** The albums and tracks tabs now use `placeholderData` like the artists tab, so page buttons remain interactive while data loads — no more "work then stop, never the same page" lockup.
- **API requests now time out after 30 seconds with streaming exemptions.** Ordinary JSON calls get a default `AbortSignal.timeout(30_000)`; audio streaming (`/stream`), SSE events (`/api/events`), and blob/arrayBuffer responses opt out via `noTimeout: true` so legitimate long streams are not killed. Server-side timeout=0 for streams is preserved.
- **Audiobookshelf sync no longer imports books whose files are missing on the server.** Items flagged `isMissing` by Audiobookshelf are skipped during sync (backend `audiobookshelf.ts:453`), so deleted collections (e.g. a removed Blinkist library) no longer leave hundreds of unplayable entries in the library.
- **Album identity merges only case/punctuation variants, not editions.** Albums that differ just by letter case, punctuation, or accents (e.g. "3D" and "3‐D") collapse into one; remasters, deluxe/anniversary editions, and remixes remain separate albums.
- **Playlist tracks show their title and artist again.** The drag-to-reorder work above added a column for the handle, taking the track table to five columns, but the handle was placed inside the play button's existing cell — so each row still emitted four children into a five-column grid. Everything shifted one column left: the title and artist block was squeezed into the 24px handle column and truncated to nothing, and the album appeared under the "Title" heading. The handle only renders for a playlist's owner, so it shares the play button's cell by design; the grid is now four columns to match, and the header and rows read their track from one shared constant so they cannot drift apart again.
- **Albums you already own as a deluxe or remastered edition are no longer downloaded a second time.** The check that answers "do we already have this album?" before a download was sharing its title comparison with the library's album-grouping rule. When grouping changed so that a remaster and its original stay separate albums (above), the download check silently inherited that and began reporting every deluxe-only album as missing. It now derives its own comparison -- edition wording is stripped before matching -- so the two rules can change independently. The earlier substring defect stays fixed: owning "Trance" still does not count as owning "Trust In Trance".

### Security

- **Every known high-severity dependency advisory is resolved.** A Trivy scan of this commit found 36 of them; all 36 are now gone. The two that mattered most: Next.js moved from 16.2.2 to 16.3.2, clearing eleven separate advisories, and axios moved from 1.13.6 to 1.19.0, clearing ten. Also updated: `sharp` 0.34.5 to 0.35.3 (image-parsing flaws inherited from libvips), `multer`, and the transitive `postcss`, `nanoid`, `brace-expansion`, `form-data`, `ip-address` and `fast-xml-builder`.
- **The weekly dependency check now catches things.** It ran `npm audit --audit-level=critical`, and the repo had zero critical advisories and 36 high ones -- so it passed clean every week while Next.js sat on eleven of them. It is now a Trivy scan that reads both lockfiles and the Python requirements in one pass, looks for committed secrets at the same time, and fails on anything high or critical that has a fix published. Findings with no fix available are printed rather than gated, and anything deliberately accepted is written down in `.trivyignore` with the reason.
- **Copying a header from an upstream audio stream can no longer crash a response.** The podcast, audiobook, artist-preview and playlist-preview routes proxy an upstream stream and copy its `Content-Length` and `Content-Type` onto their own reply. axios can hand back a header as a bare `true` (a header sent with no value), which Node rejects at runtime. All eleven of those copies now go through one narrowing helper that maps every shape axios can produce onto something Node accepts.

### Changed

- **Next track is pre-transcoded during playback** so non-original-quality transitions don't stall on a cold cache.
- **The audiobook detail view no longer hits Audiobookshelf on every page load.** Sections are computed and validated once at sync and served from cache, removing a per-request round-trip and the live-fetch/lazy-fill path.
- **Preview images are published on demand instead of every night.** The nightly job that pushed a two-architecture image to Docker Hub is gone; it had been failing for eleven consecutive nights without anyone noticing, because nothing watched it. In its place is a pre-release channel you trigger yourself -- push the `prerelease` branch or press the button on the Actions tab -- which publishes only to this repository's GitHub Container Registry as `:preview`. Docker Hub stays reserved for version tags. The preview still builds both architectures on purpose: the ARM leg is the one that breaks release builds, so proving it before tagging is the point.
- **A pull request builds the release image once instead of twice.** The security end-to-end suite was rebuilding the same image the PR checks had already built; it now runs on the weekly schedule and on demand.
- **The 303 frontend unit tests now run in CI.** Nothing in any workflow had ever referenced them.
- **A preview build now says so in the interface.** It renders as `v1.10.0-preview` instead of a bare version number, so a screenshot or a bug report carries the channel it came from and nobody mistakes a preview for a release. A locally built stack labels itself `-dev`; a tagged release still shows a bare version.
- **The docs no longer point at a Docker Hub tag that has stopped moving.** The README offered `chevron7locked/kima:nightly` as the development channel and described it as built on every push to main, which was wrong on both counts even before the nightly build was retired -- it ran on a 4am timer, and it had been failing since 2026-08-12. The release-channels section now describes the preview channel on GitHub's registry and says plainly that the old tag is retired. `CONTRIBUTING.md` and the bug-report template are corrected to match.
- **Frontend lint passes again, with no rules relaxed to get there.** `npm run lint` had been failing since before v1.9.0 -- 37 problems, mostly React Compiler rules flagging pre-existing patterns -- which made the CI lint job a permanent red light that a genuinely new error could hide behind. All 37 are gone: six belonged to throwaway debug scripts that were deleted, the Next upgrade above cleared most of the React Compiler findings, two `prefer-const` errors were auto-fixed, and one real defect was fixed by hand. That last one was in the collection page, where `setGridKey` was read by two effects declared above the `useState` that creates it -- correct at runtime, since an effect body runs long after the component function does, but a temporal-dead-zone reference as written and one refactor away from a genuine `ReferenceError`. The state declaration now sits above its users.

## [1.9.0] - 2026-06-15

A reliability release built around a ground-up rewrite of the audio playback engine. After an end-to-end audit of the player turned up 30 issues across the frontend and backend, the tangle of overlapping recovery mechanisms was replaced with a single, predictable engine; audiobooks became proper sessions; and a long-dead podcast auto-refresh was brought back. Several settings that looked functional but did nothing now actually work.

### Changed

- **The audio player is now driven by one state machine instead of four competing recovery mechanisms.** The old controller had a 3-second stall watchdog, a 10-second stall grace, a network-retry loop, and a reload-on-error path all running at once with inconsistent thresholds. They are replaced by a single engine with one recovery ladder: every wait has a deadline, every state has a way out, and the play/pause button is never disabled -- so the "endless spinner you can't even pause" state is no longer possible. iOS's noisy `stalled` event (which fired over a thousand times during healthy playback in a real trace) is now ignored entirely.
- **Audiobooks are handled as sessions, not loose URLs.** All book-time math goes through one place backed by a verified per-file track map, so a multi-file book can no longer seek to the wrong file or mark itself finished partway through.

### Fixed

- **Multi-file audiobooks could wipe your place and mark themselves finished.** Started from the series or list page, a multi-file book had no file map, so it seeked the first file to a book-absolute position, hit the end, and the player treated that as "book complete" -- overwriting saved progress. The track map is now cached server-side and carried on every surface, and a book is never marked finished without a confirmed last file.
- **Chapter taps did nothing when the book wasn't already playing.** Tapping a chapter started playback and then seeked against state that hadn't committed yet, so the seek was discarded. The chapter position now rides the load itself.
- **Podcasts stopped pulling new episodes.** A corrupted background job left a stuck marker that silently blocked every future refresh; the refresh button appeared to work but couldn't dislodge it. Failed jobs are now cleared so a refresh can recover, and a refresh that fails backs off instead of retrying in a tight loop. The same dedup trap was fixed on the artist, track, and embedding queues.
- **Pausing from the lock screen could un-pause itself when you reopened the app.** A lock-screen pause wasn't recorded as a deliberate pause, so the next time the app came to the foreground it resumed on its own (and could play through the speaker if earbuds had been removed). Lock-screen pause is now a real pause and is respected.
- **A long-idle session could stop playing after about a day.** The stream token expired and the next request failed silently; the player now refreshes the token before it expires and recovers a stream at its saved position instead of tearing down. A transient network blip no longer logs you out.
- **Subsonic "star" could silently fail.** A third-party app could star a track that never saved because every error was swallowed and success was reported regardless. Genuine failures now surface; missing tracks are skipped; partial successes are kept.
- **"Clear Caches" did nothing.** The handler used the wrong Redis client API and threw on every call. It now works and clears all rebuildable caches while leaving queue and control-plane state untouched.

### Added

- **Settings that used to be inert now work.** The transcode-cache-size slider is honored on restart, and the "Auto sync library" toggle now drives a periodic library scan (every 6 hours) so music added outside the download pipeline gets picked up automatically.

### Backend

- Stream lifecycle hardening: removed a per-user stream cap that could truncate the track you were listening to; added server socket timeouts so dead mobile connections can't accumulate; bounded the Audiobookshelf proxy with a real timeout and cached its track lookups so seeks stop paying a round-trip each; ran transcodes through a real concurrency queue with a kill-switch; aligned HTTP range handling (416 vs full-file) across the music, audiobook, podcast, share, and Subsonic routes; and shortened the year-long cache header so a replaced file isn't served stale.

## [1.8.2] - 2026-06-10

A playback-reliability release: faster track starts, audiobook progress that survives backgrounding and updates, and a round of audiobook and podcast fixes.

### Fixed

- **iOS audiobooks lost their place after an app update or a long screen-off session**: progress was saved off the `timeupdate` event, which iOS throttles when the PWA is backgrounded, so a screen-off listening session was never checkpointed and reverted to where the screen was locked. Progress now saves on a 15-second wall-clock timer while playing, independent of the throttled event.
- **An iOS interruption (call/notification) could leave audio paused, and audio could restart through the speaker after pulling earbuds**: an auto-resume-after-interruption attempt was removed after a device trace proved its safeguard could not work (iOS never emits the route-change event the guard relied on, so it could not tell an earbud unplug from an interruption ending). The audio session is still re-claimed when an interruption ends, but playback is never auto-restarted, so the earbud-to-speaker case cannot occur.
- **Slow track starts**: the streaming route did play-history logging and a settings lookup before sending the first byte. Those now run in parallel and in the background, so playback starts sooner. Default quality with no settings row is now `original` (no transcode) to match the schema default.
- **Audiobook seek past the end of a file returned a 500**: a seek using a stale file size made Audiobookshelf return 416, which surfaced as a server error. It now returns a clean 416 instead of piping an error body to the player.
- **Mis-cataloged Audiobookshelf libraries imported as a single multi-thousand-hour "audiobook"**: sync now skips items with more than 1000 audio files, which are libraries mistaken for one book (they broke seeking and the player).
- **Podcast detail page stuck on an infinite loading spinner (#168)**: a slow or unreachable feed hung the preview request with no error. The preview is now time-bounded on both ends, so a slow feed returns partial data and a dead feed surfaces an error instead of spinning forever.

## [1.8.1] - 2026-06-05

### Added

- **Optional slskd backend for Soulseek (#205, by gossip31)**: a `soulseekMode` setting routes Soulseek through an external [slskd](https://github.com/slskd/slskd) instance instead of the built-in client. slskd holds its own Soulseek account, so this mode needs no Kima-side username or password. The built-in client stays the default and is unchanged.

### Fixed

- **Audio analyzer crash-loop on corrupt files (#204, by gossip31)**: a handful of malformed files take an uncatchable native crash inside Essentia's decoder, which kills the worker before the failure can be counted, so those files looped forever and each crash left a large core dump behind. An ffmpeg integrity probe now screens files before Essentia decodes them, so a bad one fails cleanly and quarantines after the normal retry limit. As a backstop, the stale-processing recovery counts a worker crash as a retry, so any crash the probe can't predict still quarantines instead of looping.

## [1.8.0] - 2026-06-04

iOS playback reliability rebuilt from a stable baseline, Vibe search hardened against Redis pressure, the first phase of the Discover Weekly correctness rework, and a dependency pin that unbreaks the build.

### Added

- **iOS audio diagnostics**: the installed iOS PWA keeps a small rolling log of audio events on your own server to make playback bug reports actionable. Bounded and on-device; groundwork for a forthcoming general support-bundle export.

### Fixed

- **iOS earbud / lock-screen resume produced no audio and lost the session to another app**: three successive patches on the iOS AudioContext backgrounding bridge had compounded into a regression -- the worst awaited the context resume before `audio.play()` and returned early on a non-running context, so an earbud/lock-screen resume did nothing and, after a few attempts, iOS handed the audio session to the next app (a sleep-sounds app would start playing). The three patches were reverted to the proven bridge baseline (resume the context in parallel, always attempt `audio.play()`, gesture preserved), and the real gaps were fixed on top: the "playback" audio-session category is re-claimed on every explicit resume (not just the first), so iOS can't leave it with an app that grabbed it during an interruption, and an AudioContext `statechange` listener re-claims it when the OS ends an interruption. No background auto-resume was added, so the v1.7.12 earbud-unplug-through-speaker regression stays fixed. Installed iOS PWA only.
- **Vibe text search crashed with "Stream isn't writeable" under load (#197)**: the text-embedding Redis bridge inherited the shared client's fail-fast options (`enableOfflineQueue:false`), so it threw whenever a connection was mid-reconnect, and a rejected promise was cached -- breaking Vibe search until restart. The first fix hardened only the subscriber; this hardens the whole path: the publisher uses its own buffered connection, dead connections are cleaned up instead of leaking or silently dropping responses, subscribe and publish are time-bounded so an unreachable Redis fails fast instead of hanging, analyzer failures are rejected cleanly instead of 500ing, and the analyzer reports internal errors immediately.
- **Release build broke on a `transformers` update**: `transformers` was unpinned and resolved to a version that needs a newer `torch` than the pinned `torch==2.5.1` (it references `torch.float8_e8m0fnu`, added in torch 2.7), failing the analyzer image build. Pinned to `transformers==5.8.1`, the version proven against torch 2.5.1.
- **Discover Weekly never showed (and silently auto-deleted) the generated playlist -- Phase 1 of the rework**: the Sunday cron tagged records with the *ending* week, so `GET /current` (which looked for the current week with exact equality) found nothing, and the next run's cleanup then deleted the invisible records. This phase fixes the core correctness path (no schema migration): generation now tags the upcoming week via a centralized week helper; the cron moves to Monday 05:00 with a dedup key aligned to the batch week; `/current` resolves from the latest completed batch (bounded, with a `stale` flag) so drifted records are visible; `buildFinalPlaylist` marks the batch failed on a transaction error instead of hanging in `scanning`; retry-unavailable routes through the shared completion flow so retried albums actually enter the playlist; cancelling a batch marks it `failed` (not a false "successful empty week"); album deletes are wrapped in transactions with an atomic claim guard so a concurrent "like" can't lose its album (and `/like` is symmetric); a same-`rgMbid` `LIBRARY` album is never deleted; and the BullMQ job hash is cleared before re-enqueue so a retry after a failure isn't silently dropped. `TZ=UTC` is pinned for deterministic week math.

## [1.7.15] - 2026-06-01

A frontend quality and UX overhaul (accessibility, theming, and UX refinements) plus two playback fixes.

### Added

- **Collection "Refine" panel**: filtering, sorting, and items-per-page are consolidated into one popover, with clearer "In your library" vs "Recommended" labels.
- **Mobile vibe track operations**: match-vibe, find-similar, and Song Path are now reachable on touch via a panel sheet; the vibe map gained a first-run hint, and "Drift" was renamed "Song Path" with outcome-focused tooltips.
- **Discover Weekly clarity**: a clearer generate CTA, disk-usage disclosure before generation, and two-phase progress.
- **Safer destructive settings**: cache/enrichment resets now require a confirmation dialog; maintenance actions are grouped and section labels corrected.
- **Onboarding**: per-integration test/result state and clearer admin-account vs integration copy.
- **Playlist virtualization**: large playlists render a windowed subset of rows (load-tested ~33,700 -> ~1,260 DOM nodes for a 1,000-track playlist) for smooth scrolling.
- **Mini-player gesture hint**: a one-time hint explains the swipe gestures (behavior unchanged).

### Fixed

- **iOS playback stopping after almost every song when backgrounded**: the silent-playback watchdog (added in v1.7.13) was armed on every automatic track transition and judged "silent" purely from whether a `timeupdate` event arrived within 2.5s. iOS throttles that event when the installed PWA is backgrounded, so after most songs the watchdog wrongly paused healthy playback and surfaced a "Tap play to resume" error. It now judges liveness by `audio.currentTime` advancement, never tears down while the document is hidden, and only the genuine deep-suspension case (suspended/interrupted AudioContext) still prompts -- restored via an explicit foreground check. Installed iOS PWA only.
- **Desktop Discover settings / lyrics not opening in the rebuilt sidebar**: the desktop `UnifiedPanel` never read the externally-registered settings content, so the Discover settings gear (and lyrics) opened the panel to the activity feed instead of the settings. The panel now renders the registered content and returns to the feed on collapse. Pre-existing since the sidebar rewrite.
- **Keyboard focus squaring off rounded controls**: the global `:focus-visible` rule set `border-radius` on the focused element (not the outline), distorting circular and rounded buttons/modals on keyboard focus; removed (browsers already round the outline via `outline-offset`).
- **Library search silently capped at 10 results**; now renders all matches.
- **Real-bug batch**: an invisible refresh button (invalid color class), a dead `?tab=` link parameter, a non-functional queue drag handle, and several silently-swallowed errors (radio, podcasts) now surface.
- **Playlist scroll correctness**: the virtualizer offset is measured against the real scroll container and re-measured on reflow.
- `logout` return type corrected to `Promise<void>`; `aria-expanded` now stays in sync across every panel close path; removed a nested-interactive ARIA role on the mini-player.

### Changed

- **Accessibility (WCAG AA)**: muted text raised to 4.81:1 contrast, a global brand focus ring restored on keyboard navigation app-wide, ARIA labels/landmarks across remaining routes, and 44px minimum touch targets.
- **Brand color consolidated** to the official amber (`#fca200`); the legacy green accent was removed.
- **Internal theming**: hard-coded hex colors migrated to design tokens, and redundant tokens that merely aliased Tailwind values were dropped in favor of Tailwind utilities (no visual change).

## [1.7.14] - 2026-05-27

### Fixed

- **Podcast refresh silently stuck (#81)**: BullMQ retains completed-job hashes, so re-adding a refresh job with the same id was silently deduplicated and dropped. Completed jobs are now cleaned before re-queue, so podcast refresh works repeatedly.

## [1.7.13] - 2026-05-14

iOS audio reliability overhaul plus audiobook, Soulseek, and podcast fixes.

### Fixed

- **iOS audio survival and resume**: the audio element is bridged through an AudioContext to survive backgrounding; the next track's source is swapped synchronously on track-end to preserve the iOS autoplay grant; foreground resume uses a `wasPlaying` flag; AudioContext resume is awaited with silent-playback detection; and audio route-change pauses are now observable. Restored the standalone PWA on iOS so Safari chrome stops covering the UI.
- **Audiobook chapter ordering (#184)**: chapters/tracks are resolved by logical chapter number and sorted defensively by offset; sync failures now show the backend's actual error message.
- **Soulseek download errors (#192)**: errors propagate to the awaiting promise instead of crashing the backend; service-layer error listeners carry file context.
- **Podcasts (#168)**: an error UI is rendered instead of an infinite spinner, and state resets on navigation so errors don't stick across podcasts.

### Added

- **iOS audio forensics** (opt-in via `?ios_debug=1`): an audio-event ring buffer, MediaSession and lifecycle instrumentation, and a `/debug/ios-log` viewer with a backend archival endpoint.

### Changed

- Pinned Next.js to `^16.2.2` to match the container's resolved version.

## [1.7.12] - 2026-04-16

### Added

- **Persist UMAP map positions to the database**: The vibe galaxy map previously cached its UMAP projection in Redis with a 24h TTL; on every expiry (or container restart) the worker recomputed the full projection, taking ~30s on an 8k-track library. Persisting them avoids that recompute on every expiry, so they now live in `track_embeddings.map_x` / `map_y`. The map loader tries Redis first, then hydrates from the DB when at least 98% of embeddings have persisted positions (uncovered tracks get patched by `appendTrackToProjection` as they analyze), and only falls back to full UMAP recompute when coverage drops below that threshold. Cold-Redis hydrate is a single indexed join (~100ms) instead of a 30s worker run. The migration is a metadata-only `ADD COLUMN` on PG 11+, zero downtime, safe for `docker compose pull` on existing deployments.
- **Deezer as fallback source for podcast search**: iTunes Search API had an outage that broke all podcast discovery. The `/podcasts/discover/*` and `/search?type=podcasts` endpoints now fan out to both iTunes and Deezer in parallel via `Promise.allSettled` with title-based dedupe. Deezer results fill gaps when iTunes is down; iTunes results are preferred when available (they carry the `feedUrl` needed for subscription). The preview endpoint can resolve Deezer-only podcasts by looking up the feed URL via iTunes name match.

### Fixed

- **iOS earbud disconnect routing audio to the phone speaker**: The 1-second auto-resume in the audio-controller pause handler (added in v1.7.7) could not distinguish a system pause worth resuming (notification) from one that is not (audio route change when earbuds unplug or Bluetooth disconnects) -- iOS fires an identical pause event for both. When the timer fired `play()` after a route change, iOS routed audio to the loudspeaker, startling the user mid-listen. The original Control Center pause-then-play bug that the auto-resume targeted remained reproducible, so the timer was providing no benefit while causing this regression. Removed the timer and all interruption-flag state; the Media Session play action handler in `useMediaSession` already covers the Control Center path with a `reloadAndPlay` fallback gated on a user gesture, which is the only safe way to resume on iOS. Network retry, stall watchdog, `AbortError` -> reload, `NotAllowedError` -> needs-resume prompt, and visibility/pageshow foreground resume are all preserved.
- **Vibe galaxy showing a black screen on load**: A single `kima_galaxy_camera` `sessionStorage` key was shared across the 2D (orthographic) and 3D (perspective) viewing modes. Restoring a 3D flight position + `zoom = 1` (the `PerspectiveCamera` default) into the `OrthographicCamera` on the next mount placed the ortho view far from the points with no zoom, producing a black screen. Each mode now has its own storage key and only restores state captured in that same mode. The legacy single-key entry is removed on mount so any user stuck in the bad state unsticks automatically without needing a cache clear.
- **Podcast previews when iTunes resolves via Deezer**: The preview handler now accepts Deezer-only results and resolves their feed URL through an iTunes name lookup, so subscriptions still work when the primary source was Deezer.

### Changed

- **Removed the PodcastIndex scaffold**: The PodcastIndex service was referencing `SystemSettings` columns that do not exist in the current Prisma schema -- it would have thrown on first call. No production caller invoked it except the now-removed reset hook in `systemSettings`. Dropped the service, its only cache-reset call site, and the `podcast-index-api` dependency (last published 2021).

## [1.7.11] - 2026-04-08

### Fixed

- **Docker build failure on linux/arm64 (v1.7.10 hotfix)**: The torch/torchaudio/torchvision pins added in v1.7.10 (PR #178) used the `+cpu` local version suffix, which exists on the pytorch CPU index for amd64 but not for arm64 at torch < 2.6.0. The arm64 build step 7/41 failed with `ERROR: Could not find a version that satisfies the requirement torch==2.5.1+cpu`. Dropped the `+cpu` suffix -- PEP 440 matches versions without a local tag against any local variant, so the same pin resolves to `2.5.1+cpu` on amd64 and `2.5.1` on arm64.
- **CLAP model not loading (#165, properly this time)**: The v1.7.6 fix closed this issue but was actually dead code -- it edited `services/audio-analyzer-clap/requirements.txt`, but the main Dockerfile only copies `analyzer.py` from that directory and never installs from requirements.txt. CLAP was broken in every release from when the feature shipped until v1.7.10's pins landed (which would have fixed it if the arm64 build had not failed). Root cause: unpinned `torch torchaudio torchvision` let pip's resolver install mismatched versions (torch 2.5.1+cpu paired with torchaudio 2.11.0+cpu -- ABI-incompatible), and unpinned scipy/pandas were installed at latest versions needing numpy>=1.26, which tensorflow-cpu 2.13 then downgraded to 1.24.3, breaking scipy's `from numpy.exceptions import AxisError`. Fixed by the torch+cpu suffix correction above plus PR #178's (now-effective) numpy/scipy/pandas pins. Verified by reproducing the full CLAP + transformers + laion_clap + tensorflow + essentia import chain in the published v1.7.9 image and confirming the fix resolves all errors.

## [1.7.10] - 2026-04-07

### Added

- **Disc numbers and subtitles for multi-disc albums (#157, #170)**: The scanner now reads `disk.no` and `discsubtitle` tags from file metadata. Album views group tracks by disc with a header when multiple discs are present, and show compact `1-05` / `2-08` track labels for multi-disc releases. Single-disc albums are unchanged. Subsonic clients receive the `discNumber` attribute on songs and tracks are ordered by `[disc, trackNo]` across every code path (library, offline, share, and all Subsonic endpoints). A new additive migration adds two nullable columns (`Track.discNumber`, `Track.discSubtitle`) -- no rescan is required, but rescanning a library picks up the new fields. Thanks @loskutov.

### Fixed

- **Deezer preview CORS/ORB in hardened browsers (#173, #178)**: Previews were failing in LibreWolf, hardened Firefox, and Brave because Deezer's CDN doesn't send cross-origin headers and strict browsers block the direct `<audio>` load via Opaque Response Blocking. Previews now route through new backend proxy endpoints (`/api/artists/preview/.../stream` and `/api/playlists/.../preview/stream`) so audio loads same-origin with proper `Cache-Control: no-store`, 10s upstream timeout, and upstream-stream cleanup on client disconnect. The cached 24h preview URL lookup is bypassed for streaming (using a new `getFreshTrackPreview()` helper) so the Akamai token expiry that caused #172 no longer bites playback. The ownership check on pending-track preview uses a single generic "not found" message for both missing and wrong-playlist cases to avoid leaking existence of other users' track IDs. Thanks @cachamber.
- **Artist sorting ignores "The" and is now case-insensitive (#174, #175)**: Library artist sort used raw SQL ordering with no normalization, so "alt-J" sorted to the end and "The Beatles" sorted under T. Both backend (`backend/src/routes/library/artists.ts` via parameterized `Prisma.sql`) and frontend (`frontend/app/collection/page.tsx`) now strip a leading "The " (case-insensitive) and compare case-insensitively, with a stable ID tiebreaker. Server-side ordering matches the UI and is applied before pagination. Thanks @cachamber.
- **Album track order regression for NULL disc numbers**: The new `orderBy [discNumber asc, trackNo asc]` in #170 relied on Prisma's default sort behavior, which in Postgres puts NULLs LAST. On upgrade-without-rescan, all tracks have `discNumber = NULL`, which stayed correct; but for partially-rescanned libraries where some tracks gained a disc number and others did not, NULL-disc tracks would end up dumped at the end of the album instead of interleaved in track order. All six orderBy call sites (library/albums, offline, share, and three in subsonic/library) now use `{ sort: "asc", nulls: "first" }` to preserve pre-migration order.
- **Finamp removed from README client list (#167)**: Finamp is a Jellyfin-only client and does not support the Subsonic/OpenSubsonic API. The README's two mentions of it were incorrect. Thanks @Chaphasilor.

### Changed

- **Docker build: pin CLAP/PyTorch stack to known-compatible versions (#178)**: Docker image now pins `torch==2.5.1+cpu`, `torchaudio==2.5.1+cpu`, `torchvision==0.20.1+cpu`, `numpy==1.24.4`, `scipy==1.10.1`, `pandas==2.0.3` and adds a build-time sanity check that imports `torch`, `torchaudio`, `numpy`, `scipy`, `pandas`, `laion_clap`, and `transformers.BertModel`. Prevents silent ML dependency resolution drift between builds. Thanks @cachamber.
- **Security audit cleanup**: Removed ~553 lines of stale/vulnerable transitive dependencies from `backend/package-lock.json` and `frontend/package-lock.json` (4 high/1 critical backend, 3 high frontend). Lockfile-only changes, no package.json dependency bumps.
- **Preview stream cleanup**: Both Deezer preview proxy endpoints now destroy the upstream axios stream on client disconnect (`res.on("close", ...)`), matching the existing audiobook stream pattern.

## [1.7.9] - 2026-04-06

### Fixed

- **Multi-track audiobooks auto-complete after first file**: Audiobooks stored as multiple audio files (e.g., one MP3 per CD/chapter) were being marked `isFinished=true` and stopping playback as soon as the first file ended -- typically within a few minutes -- with no way to resume. Root cause: `streamAudiobook()` hardcoded `tracks[0]`, and the frontend's `handleEnded` handler treated any file end as the entire book finishing. Fix: backend now accepts a `trackIndex` query parameter and exposes the full `tracks[]` array (with `startOffset` and `duration`) in the audiobook detail response; frontend player tracks the active file, advances to the next track on `ended`, handles cross-track seeks, and applies a `trackOffset` so all displayed/saved positions reflect total-book time. Single-file audiobooks are unaffected.

## [1.7.8] - 2026-03-31

### Fixed

- **iOS PWA background audio: Control Center pause/resume produces no sound (WebKit #261858)**: Standalone PWAs on iOS use WKWebView, which suspends the audio session when backgrounded and cannot reactivate it from Control Center — `play()` resolves but produces no sound. Confirmed via on-device debugging with ios-webkit-debug-proxy. Fix: iOS "Add to Home Screen" now creates a Safari bookmark (display: browser) instead of a standalone WKWebView app, giving full audio session support. Desktop and Android retain the standalone PWA experience. Dynamic manifest route serves platform-appropriate display mode based on User-Agent.

## [1.7.7] - 2026-03-31

### Fixed

- **iOS audio not resuming after notification or Control Center pause**: On iPhone, audio would stop when a notification came in or when paused from Control Center, and tapping play showed "playing" but produced no sound. Root cause: the foreground recovery handler checked `isPlaying()` (always false after iOS interrupts audio) instead of tracking whether playback was interrupted by the system. Added three-layer recovery: (1) 1-second auto-resume timer for brief notification interruptions, (2) robust Media Session play handler that reloads the audio source on failure, (3) foreground recovery that detects system-interrupted state and resumes when app returns to focus. Also handles `AbortError` (iOS audio session invalidated) by reloading the source, and `NotAllowedError` by prompting the user to tap play.

## [1.7.6] - 2026-03-30

### Fixed

- SSRF blocking admin-configured integration URLs, CLAP numpy version floor (#165, #166)

## [1.7.5] - 2026-03-29

### Fixed

- Onboarding validation rejects disabled integrations, hide audiobooks when disabled (#162)

## [1.7.4] - 2026-03-21

### Fixed

- **Search returns no results for common words ("the", "a", etc.)**: PostgreSQL FTS drops English stop words, so `to_tsquery('english', 'the:*')` silently returns zero rows without raising an error -- meaning the ILIKE fallback never triggered. All three search paths (artists, albums, tracks) now fall through to ILIKE when FTS returns an empty result set.
- **`/health` endpoint returns no diagnostic detail**: Both `/health` and `/api/health` previously returned only `{"status":"ok"}` regardless of dependency state. They now ping PostgreSQL and Redis, return `uptime`, `version`, `db`, and `redis` fields, and respond with HTTP 503 when either dependency is unavailable.

### Changed

- **TypeScript strict mode enabled (frontend)**: `"strict": true` in `frontend/tsconfig.json`. Fixed 31 implicit-any and strictNullChecks errors across album/artist/podcast pages, MetadataEditor, AlbumHero, ArtistHero, ArtistActionBar, AvailableAlbums, useDiscoverData, LibraryAlbumsGrid, LibraryTracksList, UnifiedSongsList, CacheSection, useQueries, useTVNavigation.
- **Redis client consolidation**: Removed `redis` (node-redis v4) dependency entirely. All ~30 backend files now use `ioredis` exclusively. Eliminated the dual-client footgun. Pub/sub in `textEmbeddingBridge` rewritten to ioredis event-based API.
- **routes/library.ts split**: 4364-line god-file split into `routes/library/` sub-routers: `artists`, `albums`, `tracks`, `streaming`, `coverArt`, `scan`, `backfill`. Each file has a single clear responsibility. `library.ts` is now a 10-line re-export barrel.
- **services/programmaticPlaylists.ts split**: 3842-line god-file split into `services/mixes/` sub-modules: `genreMixes`, `moodMixes`, `timeMixes`, `discoveryMixes`, `helpers`, `index`. `programmaticPlaylists.ts` is now a 7-line re-export barrel.
- **Startup task consolidation**: Three concurrent IIFE startup tasks (audiobook sync, artist counts backfill, image backfill) consolidated into a sequential `runStartupTasks()` function to avoid overwhelming DB connections at startup.
- **Dead code removal**: Removed unused `ffmpeg-static` dependency (not imported anywhere); added `prebuild` script to clean `dist/` before each build.

### Fixed (internal)

- **enrichmentStateMachine tests**: Updated mock for `enrichmentStateService` to include `publishToChannel` method. Tests for Python analyzer C2 bridge now correctly assert against `publishToChannel` instead of raw Redis `publish` (which was never called after the ioredis consolidation refactored the channel through the service layer).

### Tests

- **Tier 1 backend test coverage added**: New test suites for `services/search.ts` (22 tests -- `queryToTsquery` logic, special char handling, search service), `routes/share.ts` (17 tests -- share token lifecycle, play counting, unauthenticated access), `routes/webhooks.ts` (14 tests -- Lidarr webhook events, secret validation, error handling), `services/musicScanner.ts` (49 tests -- pure parsing helpers, path normalization, metadata extraction), `routes/library/albums.ts` (17 tests -- pagination, filtering, delete). Total test count: 307 (up from 173).

## [1.7.3] - 2026-03-20

### Fixed

- **Cover art 404s after volume wipe or permission change (#149)**: Artist enrichment and album cover fetch now check if native cover files actually exist on disk before preserving stale DB paths. Added `nativeFileExists()` utility, `repairBrokenCovers()` service, and `POST /enrichment/repair-covers` endpoint to scan and clear broken cover paths for re-fetch.
- **ARM64 Docker builds missing core Python dependencies (#1)**: `tensorflow-cpu` has no Linux ARM64 wheels, and all pip installs were chained -- so tensorflow failure prevented redis, bullmq, and other core deps from installing. Split into three layers: core deps (always succeed), ML deps (torch/CLAP -- works on ARM64), and tensorflow/essentia (gracefully degrades on ARM64 with log message).
- **Misleading "Remove docker-compose.override.yml" message on non-Docker installs (#147)**: Replaced Docker-specific text with generic "Service not detected" message for Audio Analysis and Vibe Similarity on Proxmox LXC and bare metal installs.
- **Unused `artistHeroUrl` parameter in enrichAlbumCovers**: Cleaned up dead parameter that was passed but never used.

## [1.7.2] - 2026-03-18

### Fixed

- **Multi-container docker-compose: fresh install shows login instead of setup wizard (#158)**: Next.js rewrites were compiled at build time with `127.0.0.1:3006` baked in because `NEXT_PUBLIC_BACKEND_URL` was never passed as a build arg. In multi-container mode the frontend container can't reach `127.0.0.1:3006` (that's the backend container). Fix: added `NEXT_PUBLIC_BACKEND_URL` as a Dockerfile build arg, defaulting to `http://backend:3006` in docker-compose.yml. The reporter's CORS issue was a secondary symptom -- once the proxy works, all requests are same-origin.
- **Audiobookshelf sync silently skips books**: Books with no title returned early without throwing, but `syncAll` counted them as synced. Now `syncAudiobook` returns a boolean; skipped books increment `result.skipped` instead of `result.synced`.
- **Audiobookshelf sync notification hides failures**: The "Synced N audiobooks" notification now includes failed/skipped counts when non-zero.
- **Audiobookshelf cover download can hang indefinitely**: `downloadCover()` had no fetch timeout. Added `AbortSignal.timeout(10_000)` to prevent a single slow cover from stalling the entire sync.
- **Audiobookshelf book size includes non-audio files**: Changed `book.size` to `book.media?.size` for audio-only size.

### Added

- **Sync button on audiobooks page**: Users can now sync audiobooks directly from the audiobooks page without going through settings or triggering a full enrichment cycle. Shows synced/failed/skipped counts in a toast and refreshes the grid automatically.

## [1.7.1] - 2026-03-17

### Fixed

- **Playlist track count not updating live**: Adding a track to a playlist from the album page or library (collection) no longer requires a page refresh. The React Query cache is now invalidated at all three `addTrackToPlaylist` call sites (`album/[id]/page.tsx`, `useLibraryActions`, `useAddToPlaylistMutation`). Closes #157.
- **Settings: stale restart-required modal removed**: The "Restart Required" modal was a remnant of an old architecture -- services reinitialize live when settings are saved. The modal and all supporting state (`changedServices`, `originalSettings`) have been removed. Closes #158.
- **YouTube / YouTube Music playlist import broken**: `/api/browse/playlists/parse` now handles `youtube.com` and `music.youtube.com` URLs in addition to the short `youtu.be` form. Closes #155.
- **Lidarr MBID mismatch (album MBID sent to artist endpoint)**: `verifyArtistName` was incorrectly receiving the album MBID from Lidarr search results and passing it to the MusicBrainz `/artist/{id}` endpoint, causing 404s on every verification. Closes #156.
- **Hardcoded port-3030 in API base URL detection**: `getApiBaseUrl` no longer hard-codes port 3030 as the "frontend" port. It now returns a relative URL by default, making Kima work behind any reverse proxy or non-standard port mapping. Closes #154.

### Changed

- Dead code removed: unused `setIsBulkAdd` / `setIsAddingToPlaylist` state on album page; unused `useSearchParams()` call in settings page.

## [1.7.0] - 2026-03-16

### Added

- **Vibe 3D galaxy view**: New immersive "galaxy" toggle on the Vibe page renders your library as a navigable 3D star field using React Three Fiber + Three.js. Tracks are positioned by their vibe embeddings, lit by a dynamic space grid with depth lines, and colored by mood. Double-click any point to play. Camera uses map controls with smooth zoom and pan. Rendered in a dedicated `GravityGridScene` with cluster label billboards, optimized point instancing, and post-processing disabled for GPU performance.
- **Vibe map pre-compute and KNN acceleration**: Map data is now pre-computed on the backend at enrichment completion rather than on first page load. KNN graph is built incrementally (100-at-a-time) against a pre-sorted index, cutting cold-start time from seconds to milliseconds on large libraries.
- **GitHub Actions CI pipeline**: Full multi-stage CI across all PRs and pushes to main. Stages: lint + typecheck (frontend + backend), unit tests (Jest), security scan (CodeQL + secrets), E2E predeploy tests (Playwright against a real Docker build), nightly build + push to Docker Hub and GHCR.
- **E2E enrichment cycle spec**: Playwright test that wipes all enrichment data, triggers a full re-enrich, polls until completion, then asserts track success rate >= 80%, vibe map populated, vibe search returning results, and failure rate < 20%. Skips gracefully when the library has fewer than 10 tracks (CI containers). Companion shell script (`scripts/run-enrichment-memory-test.sh`) captures host SUnreclaim and container RSS before/after and fails the run if slab growth exceeds 1 GB.
- **E2E vibe spec**: Playwright test covering vibe map load, track selection, song path generation, vibe search, alchemy (track blending), and similar-tracks suggestions.
- **PWA offline fallback**: Service worker now serves a cached offline page when navigation requests fail. Cached on install alongside the app shell.
- **PWA update banner**: App detects when a new service worker is waiting and shows a non-blocking "Update available" banner. Clicking it activates the new worker and reloads.
- **Web app manifest fixes**: `display_override` with `window-controls-overlay` for desktop PWA title bar space. Corrected `scope`, `start_url`, and `id` fields. Added `edge_side_panel` and screenshot metadata.

### Fixed

- **Enrichment: audio counter stale at completion**: `audio.completed` in the Redis state snapshot was frozen at the value from the last `audioQueued > 0` cycle. Once all tracks were queued, the update block was skipped while Essentia continued processing in the background, leaving the counter stuck (e.g. 171/232). The counter is now flushed from the live DB count at the `isFullyComplete` transition before going idle.
- **Security: double authentication in system settings**: `requireAdmin` already enforces authentication, so the redundant `requireAuth` call before it was removed.
- **Security: OOM from Next.js VMA accumulation**: The App Router's map-style routes allocate ~15 TB of virtual memory, causing `anon_vma_chain` slab exhaustion on the host kernel. Mitigations: Docker memory cap (`mem_limit: 6g`, `memswap_limit: 8g`) in both compose files; Node 22 in the Dockerfile (V8 improvements reduce anonymous VMAs); `MALLOC_ARENA_MAX=1` for the frontend process (fewer glibc arenas); `NODE_OPTIONS=--max-old-space-size=512` for the frontend (bounds heap to reduce GC-driven VMAs).
- **Security: DoS vectors patched**: Unbounded enrichment queue, unguarded bulk endpoints, and routes missing rate limits addressed in the production hardening pass.
- **Security: SSRF vector in webhook callback validation**: Callback URLs are now validated against an allowlist of configured hosts before being followed.
- **Vibe map accuracy**: SLERP interpolation corrected, similarity formula made consistent between search and map. Distinct mood colors assigned per cluster. ARIA labels added to interactive elements.
- **Vibe map timer leak**: `setInterval` polling the map data endpoint was not cleared on unmount. Replaced with React Query cache with explicit `staleTime`.
- **Vibe request ref cleanup**: `vibeRequestRef` was not cleaned up on component unmount, causing stale abort signals on re-mount.
- **Mobile: full-height vibe page rendering**: CSS height chain corrected from `html`/`body` through layout to vibe page so the map fills the viewport without overflow or clipping on mobile.
- **Subsonic: `.view` suffix normalization**: Requests from clients that append `.view` to endpoint names (e.g. `getCoverArt.view`) are now normalized before routing. Expanded OpenSubsonic endpoint compatibility.
- **Service worker: stale styles after rebuild**: SW was caching HTML and CSS documents, causing users to see outdated styles until manual cache clear. HTML and CSS are now excluded from the SW cache entirely.
- **dead `sourceTrack` variable**: Removed dead variable from vibe request path.
- **Abort signal not wired to vibe fetch**: Cancelling a vibe search now properly aborts the in-flight fetch.

### Changed

- **vibe-test prototype page removed**: The `/vibe-test` dev sandbox page and its associated R3F prototype components (`VibeUniverse`, `TrackCloud`, `TrackTooltip`, `universeUtils`) have been removed. The production galaxy view lives in `GravityGridScene`.
- **NowPlayingTab simplified**: Removed legacy MusicCNN sections from the vibe sidebar -- radar chart (recharts), mood spectrum bars, audio features grid (BPM/key/energy/danceability/valence/arousal), and match score badge. These all showed "--" because `audioFeatures` is no longer populated since the vibe system moved to CLAP. The tab now shows album art and track info only.
- **README**: Vibe section rewritten with Map, Galaxy, Drift, and Blend subsections and fresh screenshots. All 19 screenshots retaken at 1440x900 desktop / 390x844 mobile with correct logo rendering.

### Removed

- `recharts` dependency (zero usages after NowPlayingTab cleanup).
- Dead dev artifacts: `backend/test_dedup_manual.ts`, `backend/src/scripts/testDataCleanup.ts`.

## [1.6.4] - 2026-03-12

Fixes #152. Addresses #145.

### Fixed

- **Version display (#152)**: Frontend and backend package.json were not bumped for 1.6.3. Both now read from package.json dynamically
- **Long track playback stalling (#145)**: Added playback watchdog that monitors currentTime progress every 1s. If no advancement for 3s while playing, automatically reloads the stream at the saved position and resumes playback. Supplementary stalled event listener with 10s grace timer as fallback recovery path. Recovery limited to 3 attempts before surfacing an error
- **Page refresh kills playback (#145)**: After a page refresh, pressing play now reloads the stream for the restored track/audiobook/podcast instead of doing nothing. Audiobook and podcast progress is seeked to saved position
- **Network retry improvements**: Exponential backoff (1s/2s/4s) replaces linear (2s/4s), max retries bumped from 2 to 3. Network retries and stall recoveries now auto-resume playback instead of requiring manual "Tap play to resume"
- **Stream cache validation**: Added ETag and Last-Modified headers to audio streaming responses, enabling browser If-Range optimization for efficient reconnection after stalls

### Changed

- **Centralized User-Agent version**: All backend HTTP clients now use a shared USER_AGENT constant from config.ts (derived from package.json) instead of hardcoded version strings scattered across 12 files

## [1.6.2] - 2026-03-05

Closes #32. Partially addresses #25, #90, #124, #139.

### Added

- **Skip MusicBrainz when Lidarr disabled (#90, #124)**: Playlist imports no longer call MusicBrainz for MBID resolution when Lidarr is not configured. Soulseek searches by artist+album+track text and never uses MBIDs, so MB API calls were pure waste for Soulseek-only users. A 170-song import that took ~15 minutes now generates its preview in seconds. Albums without MBIDs route directly to Soulseek instead of being blocked or misrouted to track-based acquisition.
- **Import cancellation with AbortSignal**: Cancelling a playlist import now immediately aborts all in-flight and queued Soulseek searches and downloads. Previously, `cancelJob()` only marked DB records as failed while rate-limiter-queued searches continued executing for minutes. AbortSignal threads from `cancelJob()` through the PQueue album pipeline, acquisition service, rate limiter, search strategies, and download retry loop.
- **Background playlist imports**: Importing a playlist URL no longer navigates to a full-page progress screen. Imports fire in the background with a toast notification, and the user stays on their current page. Completion, failure, and cancellation show toast notifications via SSE events.
- **Import URL dedup**: Submitting the same playlist URL while an import is already active returns the existing job instead of creating a duplicate. URLs are normalized (host + pathname, trailing slashes stripped) for reliable matching.
- **Imports management tab**: New "Imports" tab in the Activity Panel shows all active and past imports with real-time progress bars, status badges, cancel buttons, and links to created playlists.
- **Import page reconnect**: Refreshing `/import/playlist` while an import is running reconnects to the active job's progress instead of showing a blank form.
- **Early playlist name resolution**: Quick imports now fetch the real playlist name from Spotify/Deezer before enqueueing, so the Imports tab shows the actual name immediately instead of a generic placeholder.

- **Playlist action hub**: Create, Import URL, Import File (M3U), and Browse buttons directly on the playlists page. No more navigating through Browse to import.
- **Sidebar create playlist**: The "+" button in the sidebar now opens an inline create dialog instead of navigating away.
- **M3U playlist import**: Upload `.m3u` / `.m3u8` playlist files to create playlists by matching entries against your library. 4-tier matching: file path, filename, exact metadata, fuzzy metadata (fuzzball).
- **Multi-playlist add**: The "Add to Playlist" picker in the full player now supports selecting multiple playlists at once with checkboxes and a confirm button. Existing single-select callers are unchanged.
- **Playlist visibility toggle**: Globe/Lock button on the playlist detail page lets owners toggle public/private visibility. Previously required database editing for imported playlists.
- **BullMQ import queue**: Playlist imports (Spotify, Deezer, M3U) now run via a dedicated `playlist-import` BullMQ queue instead of fire-and-forget async. Provides crash recovery, visibility in Bull Board admin panel, and proper queue semantics.
- **Podcast refresh buttons**: RefreshCw button on podcast detail page checks for new episodes. "Refresh All" button on main podcasts page queues refresh for all subscriptions via BullMQ.
- **Custom RSS feed subscription**: "Add RSS Feed" button on the main podcasts page lets users subscribe to any podcast by pasting a direct RSS feed URL, without needing to find it on Apple Podcasts.
- **Conditional GET for feed refresh**: Podcast feed fetches now send `If-Modified-Since` and `ETag` headers, receiving 304 Not Modified when feeds haven't changed. Reduces bandwidth and server load for hourly auto-refresh.

### Changed

- **Route rename**: `/library` is now `/collection` (redirects preserved). `/import/spotify` is now `/import/playlist` (redirects preserved with query params).
- **Onboarding simplified to 2 steps**: Removed the informational step 3 (enrichment/analysis features). Onboarding is now Account + Integrations, with "Complete Setup" finishing directly from step 2.
- **Smoother sync progress bar**: SSE events now emit every 1% instead of 2%, and polling fallback tightened from 2s to 500ms. Progress bar reflects real scan data at higher resolution.
- **Import cancel cleanup**: Cancelling an import now fully removes all DB records, Redis cache entries, and BullMQ jobs. Failed imports with zero matched tracks also clean up automatically. Partial failures preserve matched tracks.

### Fixed

- **Security: hardcoded Last.fm API key removed**: Default fallback API key removed from source code. `LASTFM_API_KEY` environment variable is now required for Last.fm enrichment.

### Removed

- Dead code cleanup: removed 3 unused service files (`openai.ts`, `fileValidator.ts`, `Skeleton.tsx`), 16 unused exports across utils/middleware/workers, and debug console.logs from Soulseek search hook.

- **Spotify 100-track pagination**: Anonymous Spotify tokens cap `tracks.total` at 100, preventing pagination from triggering. Now speculatively fetches additional pages when a full page of results is received, bypassing the cap for playlists of any size.
- **Playlist partial update schema**: `PUT /playlists/:id` previously required `name` in every request body (using create schema). Now uses a dedicated update schema where both `name` and `isPublic` are optional, supporting partial updates without resetting unrelated fields.
- **Artist MBID race condition**: Concurrent enrichment workers could both check that an MBID was free, then both try to claim it, crashing the second worker with a unique constraint violation. All four MBID write sites now catch Prisma `P2002` errors and gracefully skip the MBID update while preserving other enrichment data.
- **Double import on page refresh**: Refreshing `/import/playlist` while an import was running fired a second import for the same URL. Removed auto-start behavior; the page now checks for active imports and reconnects to them.

## [1.6.1] - 2026-03-03

Closes #121, #125, #136, #138. Partially addresses #139, #25, #108, #30.

### Added

- **Share links**: Generate shareable URLs for playlists, tracks, and albums. Public playback page with built-in audio player, no account required. Token-based access with optional expiry and play count limits. Share popover in playlist page with copy-to-clipboard and revoke.
- **Playlist inline rename**: Click playlist title to edit in place. Enter to save, Escape to cancel, click-away to save. Input stays open on save failure for retry.
- **Player queue and add-to-playlist buttons**: Queue navigation button and add-current-track-to-playlist button in the full player bar.
- **Local artist images**: Library scanner discovers `artist.jpg`/`folder.jpg`/`.png`/`.webp` in music directories and copies them to the image cache. Enrichment preserves local images over external URLs.
- **Playback queue expanded to 2000 items**: Queue storage increased from 100 to 2000 tracks (frontend and backend).
- **GHCR publishing**: Docker images now published to GitHub Container Registry alongside Docker Hub on tagged releases. Credit to @SupremeMortal (#48).
- **#134 Lidarr batch album fetching**: Large Lidarr libraries no longer crash with V8 string overflow -- albums are fetched in paginated batches. Credit to @cachamber.
- **#132 Preview volume sync**: Preview audio volume now syncs with the global player volume. Credit to @cachamber.
- **Safari audio session hint**: Explicitly sets `navigator.audioSession.type = "playback"` on Safari 16.4+ to ensure the correct AVAudioSession category before first playback.

### Fixed

- **Security: path traversal in cover art serving**: `getLocalImagePath` and `getResizedImagePath` lacked path containment checks. Added `path.resolve` + `startsWith` guards matching the existing `validateCoverPath` pattern. Removed dead `localImageExists` function.
- **Security: share stream missing error handlers**: Raw `createReadStream.pipe(res)` replaced with `streamFileWithRangeSupport` utility for proper stream error handling and file descriptor cleanup on client disconnect.
- **Security: global JSON body limit too broad**: 5mb limit applied to all routes. Replaced with conditional middleware -- 5mb for playback state only, 1mb for everything else.
- **Enrichment: manual enrich overwrites local artist images**: `applyArtistEnrichment` unconditionally replaced `heroUrl` with external URLs. Added DB re-read + native path guard matching the background worker.
- **Enrichment: stale heroUrl reference in download fallback**: Removed misleading `artist.heroUrl` check on stale function parameter. The downstream DB re-read handles native path preservation.
- **Scanner: wrong artist image in deep directory structures**: Directory iteration went shallow-to-deep, matching genre-level `folder.jpg` before artist-level. Reversed to deep-to-shallow.
- **UI: playlist rename and add-to-playlist fail silently**: Added try/catch with toast errors. Rename input stays open on failure for retry.
- **Mobile: double-tap to play tracks not working**: `onDoubleClick` on track rows does not fire on touch devices. Added `touch-action: manipulation` and custom double-tap detection via `onTouchEnd` with 300ms window across all 7 track list components. Desktop double-click preserved.
- **Mobile lyrics: text clipped by album art container**: Lyrics crawl rendered above album art but was clipped by the parent's `overflow-hidden`. Replaced with a full lyrics view that swaps out the album art when active. Synced lyrics auto-scroll to the active line; plain lyrics are freely scrollable.
- **Enrichment: audio analysis and vibe embeddings running simultaneously**: Both ML models (Essentia + CLAP) competed for CPU/GPU, causing UI flickering. Vibe phase now defers until audio analysis is fully idle. Removed per-track vibe job queuing from the audio completion subscriber -- `executeVibePhase` sweep is now the sole queuing path.
- **UI: activity panel reopens after closing**: `useEffect` dependency on the full `activityPanel` object caused event listener teardown/re-register on every open/close. Destructured to stable `useCallback` refs.
- **UI: silent failures on playlist operations**: `handleRemoveTrack`, `handleToggleHide`, `handleRemovePendingTrack`, and `handleDeletePlaylist` caught errors with only `console.error`. Added `toast.error` to all four.
- **Player: dead `handleSeek` wrappers**: Removed pass-through wrappers in FullPlayer, OverlayPlayer, and MiniPlayer. `seek` passed directly to `SeekSlider`.
- **Artist page popular tracks**: Improved title matching with three-tier fallback (exact, normalized, aggressively stripped) so remaster/deluxe variants match correctly as owned. Unowned tracks now show artist hero image instead of gray placeholder.
- **Card hover overlay regression**: Dark gradient overlays caused blackout effect on album art hover. Made overlay conditional on playable cards, softened opacity on grid cards.
- **Album navigation delay**: First click to album pages felt unresponsive due to `prefetch={false}` on all card Links. Enabled Next.js prefetching for instant navigation.
- **GHCR image name casing**: `github.repository_owner` preserves uppercase but GHCR requires all-lowercase. Compute image name at runtime with bash lowercase conversion.
- **#128 Subsonic rate limit too low for Symfonium sync**: Large libraries (2000+ songs) hit the 300 req/min rate limit during Symfonium sync. Bumped to 1500 req/min -- self-hosted service behind auth, no brute-force risk.
- **Mobile: lock screen always shows "playing" / steals Bluetooth/CarPlay**: Removed the silence keepalive system that looped near-silent audio to maintain the OS audio session while paused.
- **Mobile: resumeWithGesture shows "playing" when blocked by OS**: Now awaits confirmation and reverts on failure.
- **Audiobook progress overwritten on track end**: Completion flag was immediately overwritten by the pause-triggered progress save. Fixed ordering.
- **Duplicate "play" event firing**: Now emits only on `playing` (when audio is actually producing sound).
- **MediaSession metadata unnecessary re-renders**: Removed `isPlaying` from metadata effect deps.
- **Mobile: lock screen stuck on "playing" after errors**: Added `error` event to MediaSession playbackState listeners.
- **Mobile: audio stops silently in background**: Network retry now emits proper error for UI recovery.
- **Mobile: foreground recovery too narrow**: Clears error on foreground return.
- **Podcast progress bar reverts on pause**: Now updates React state after API save.
- **Mobile: permanent pause after phone call/Siri**: Tracks pre-interruption state and attempts auto-resume.
- **Enrichment: `isPaused` permanently stuck after Stop**: Moved `isStopping` handler to top of cycle.
- **Enrichment: vibe re-run doesn't restart cycle**: Now calls `triggerEnrichmentNow()` and cleans completed BullMQ jobs.
- **Enrichment: BullMQ jobId dedup silently drops re-queued vibe tracks**: Added `vibeQueue.clean(0, 0, 'completed')` before `addBulk()`.
- **Enrichment: stale failure records inflate "View Failures" count**: CLAP analyzer resolves failures on success.

### Removed

- **Swagger API documentation**: Removed `swagger-jsdoc`, `swagger-ui-express`, and all 16 `@openapi` annotations. 30 packages eliminated.
- **Debug logging**: Removed 20 debug `console.log`/`console.warn` statements.
- **Unused dependencies**: Removed `react-virtuoso`, `silence-keepalive.ts`, dead `pauseRef`.

### Changed

- **Audio state context cleanup**: Removed unused exports `isRepeat`, `lastServerSync`, `setLastServerSync`, `isHydrated` from context type and provider value.

- **Frontend query keys standardized**: Raw `["playlist", id]` string arrays replaced with centralized `queryKeys` helpers across the playlist page.
- **Share API `entityType` typed**: Parameter typed as `"playlist" | "track" | "album"` union instead of `string`.
- **Playlist mutations use React Query**: Track removal and playlist deletion now use mutation hooks with automatic cache invalidation instead of direct API calls.
- **AuthenticatedLayout**: Public path matching changed from exact match to prefix match for `/share/*` routes.
- **Playlist import performance**: Parallelized MusicBrainz lookups via Promise.all. Batch-loaded all library tracks -- reduced ~3000 per-track DB queries to 2 batch queries.
- **Dependencies**: Updated safe patches -- @bull-board 6.20.3, axios 1.13.6, bullmq 5.70.1, ioredis 5.10.0, fast-xml-parser 5.4.1 (stack overflow CVE fix), tailwindcss 4.2.1, framer-motion 12.34.3, tailwind-merge 3.5.0. Fixed npm audit vulnerabilities.

## [1.6.0] - 2026-03-02

### Fixed

- **Enrichment: failure count inflation**: Python audio analyzer recorded EnrichmentFailure on every attempt, not just after max retries. Removed Python writer; Node.js audioAnalysisCleanup is now the sole writer. Added success resolution in `_save_results()` for immediate cleanup instead of hourly sweep lag.
- **Enrichment: isPaused permanently stuck after Stop**: Stop control message set `isPaused=true` which was never cleared because `shouldHaltCycle()` was unreachable from the early return. Moved `isStopping` handler to top of `runEnrichmentCycle()`. Added `userStopped` flag to prevent auto-restart via timer while allowing explicit re-run/enrich actions.
- **Enrichment: Stop doesn't reach Python analyzer**: `enrichmentState.stop()` only published to `enrichment:control`. Now also publishes `pause` to `audio:analysis:control` (not `stop`, which would exit the process). Resume publishes `resume` to both channels. All re-run functions resume the Python analyzer via `clearPauseState()`.
- **Enrichment: state sync stopping deadlock**: If `enrichment:control` message was lost but state service showed `stopping`, the sync set `isPaused=true` with no `isStopping` to clear it. State sync now handles `stopping` directly by transitioning to idle.
- **Enrichment: reverse sync for missed resume**: If local `isPaused` was stale but state service showed `running`, the cycle stayed paused. Added reverse sync to detect and clear the mismatch.
- **Enrichment: crash recovery gaps**: Startup now resets artists stuck in `enriching` status and tracks with `_queued` sentinel in `lastfmTags`, in addition to existing audio/vibe processing resets.
- **Import: duplicate playlists on large imports**: `checkImportCompletion()`, `buildPlaylistAfterScan()`, and `buildPlaylist()` lacked idempotency guards. Late download callbacks and queueCleaner re-queued scans that each created a new playlist. Added status guards at all three layers.
- **Import: processImport overwrites cancel**: Setting `status="downloading"` without checking if already cancelled. Added cancel guard.
- **Enrichment failures: TOCTOU race in recordFailure**: Find-then-create pattern replaced with atomic `prisma.enrichmentFailure.upsert()`. Also resets `resolved=false` on re-failure (previously hidden from UI).
- **Enrichment failures: Python/Node.js Track status race**: Added `WHERE analysisStatus='processing'` optimistic lock to `_save_results()` and `_save_failed()`. Prevents stale writes when cleanup resets a track near the 15-minute threshold.
- **Discovery: duplicate Discover Weekly jobs**: `discoverQueue.add()` now uses deterministic `jobId` based on userId + week, preventing cron/manual trigger overlap.
- **Discovery: checkBatchCompletion race**: Re-reads batch status after 60s Lidarr wait. Added `expectedStatus` parameter to `updateBatchStatus` optimistic locking for belt-and-suspenders protection.
- **Discovery: album status reset on regeneration**: `discoveryAlbum.upsert()` update branch no longer sets `status: "ACTIVE"`, preserving user's LIKED/DELETED decisions.
- **Scanner: ownedAlbum duplicate constraint violation**: Replaced `create()` with `upsert()` using compound key.
- **Streaming: transcodedFile duplicate constraint violation**: Replaced `create()` with `upsert()` on `cachePath`.
- **Downloads: notification retry creates duplicates**: Added dedup check before `downloadJob.create()` at all 3 retry handlers.
- **Webhook: unnecessary Lidarr API calls**: Skip reconciliation when no processing download jobs exist.
- **Infrastructure: audio-analyzer supervisor autorestart**: Changed from `unexpected` to `true` (matching backend fix).
- **Infrastructure: Redis startup race**: Added Redis readiness loop to `wait-for-db.sh` with separate counter. Backend supervisor changed to `autorestart=true`.
- **Python: deprecated datetime.utcnow()**: Replaced with `datetime.now(timezone.utc)`.

### Added

- 37 new tests across 9 test files covering enrichment state machine, idempotency guards, queue dedup, notification dedup, and Python optimistic locking.

## [1.6.0-pre.2] - 2026-03-01 (nightly)

### Fixed

- **Enrichment: vibe progress jumps 0% to 100%**: CLAP analyzer reported completion via internal HTTP callbacks but never emitted SSE events. Added `enrichment:progress` SSE event type with broadcast support (`userId: "*"`), emitted from vibe success/failure endpoints. Frontend SSE handler invalidates the `enrichment-progress` query on each event for immediate re-fetch.
- **SSRF protection**: Added `validateUrlForFetch()` to podcast stream and download paths to block requests to internal networks.
- **CORS enforcement**: Reject unlisted CORS origins instead of allowing all.
- **Encryption KDF**: Always derive encryption key via SHA-256 with legacy fallback.
- **Query limits**: Clamp `/plays` limit to max 200.
- **Webhook secret comparison**: Use `crypto.timingSafeEqual` for timing-safe webhook secret validation.
- **Webhook log spam**: Rate-limit missing webhook secret warning to once per process.
- **Stream TTL sweep**: Add 1-hour TTL sweep for stale `activeStreams` entries.
- **Transcode race condition**: Deduplicate concurrent transcodes via in-flight map.
- **Streaming singleton**: Make `AudioStreamingService` a singleton to prevent duplicate instances.
- **Enrichment reset**: Exclude processing tracks from full enrichment reset.
- **Image cache eviction**: Add LRU eviction to `useImageColor` localStorage cache (max 500 entries).
- **Preview audio leak**: Remove old preview audio elements from map when switching tracks.
- **Keyboard shortcut re-renders**: Move keyboard shortcut deps to refs for stable effect.
- **Player polling loop**: Move `lastServerSync`/queue/index/shuffle to refs in poll effect.
- **Queue desync on track removal**: Handle removing current track from middle of queue.
- **Overlay re-open on auto-advance**: Don't re-open overlay on auto-advance after first play.
- **Previous track restart**: Restart current track if position > 3s on previous button press.
- **Podcast detection**: Split podcast composite ID before URL comparison.

## [1.6.0-pre.1] - 2026-02-28

### Added

- **Synchronized lyrics**: LRCLIB integration fetches timed `.lrc` lyrics during library scan. Full-player and overlay-player display synced lyrics with a 3-line stacked view (previous/current/next). Lyrics toggle in activity panel with owner-based priority so Discovery settings don't override an active lyrics view.
- **LRCLIB rate limiting**: Lyrics API calls go through the global rate limiter (2 req/s, concurrency 1) to respect upstream limits.

### Fixed

- **Enrichment pipeline**: Fixed 7 issues -- vibe re-run no-ops (dedup cache not cleared), completion notification never firing (dead in-memory counters replaced with DB query), infinite artist retry loop (final attempt reset status to pending), phantom state after shutdown, podcast failures excluded from counts, orphaned frontend type, and removed dead vibe reset endpoint.
- **Feature flags go stale**: Now polls every 60s instead of fetching once on mount.
- **Mood mixer threshold mismatch**: Frontend threshold now matches backend minimum (8 tracks).
- **iOS Safari audio playback**: Reset stale network retry count on preload swap, removed competing silence keepalive from resume gesture, guarded redundant `play()` calls, pre-set track ref for deterministic deduplication, and capped error cascade at 3 consecutive failures.
- **iOS AirPod/lock-screen resume**: Silence keepalive `prime()` in the MediaSession play handler consumed the iOS user gesture budget before the actual audio resume. Moved keepalive priming to the pause handler so the play handler's full gesture is available for `tryResume()`.
- **Audio analyzer retry loop**: Failed tracks had retry count reset to 0 on re-queue, bypassing the max-retries guard. Now preserves count so broken tracks are excluded after 3 attempts.
- **CLAP search timeouts**: Model unloaded after 10s idle when all tracks were embedded, causing ~20s cold-start on every vibe search. Now uses standard 5-minute idle timeout. Backend search timeout increased to 60s.

## [1.5.11] - 2026-02-27

### Added

- **#25** Full playlist pagination for Spotify and Deezer imports -- playlists of any size are now fully imported instead of silently capping at 100 (Spotify) or 25 (Deezer) tracks. Paginated fetch with rate limit handling, partial result recovery, and SSE progress reporting ("Fetching tracks: X of Y...").
- **#8** Configurable Lidarr quality and metadata profiles -- previously hardcoded to profile ID 1. New dropdowns in Settings > Download Services appear after a successful connection test, populated from Lidarr's API. Stored in system settings and used for all artist/album additions.

## [1.5.10] - 2026-02-27

### Added

- **#122** `DISABLE_CLAP=true` environment variable to disable the CLAP audio embedding analyzer on startup in the all-in-one container (useful for low-memory deployments)
- **#123** Foobar2000-style track title formatting in Settings > Playback -- configure a format string with `%field%`, `[conditional blocks]`, `$if2()`, `$filepart()` syntax; applied in playlist view
- **#124** Cancelling a playlist import now creates a partial playlist from all tracks already matched to your library, instead of discarding progress

### Fixed

- **#124** Cancel button previously promised "Playlist will be created with tracks downloaded so far" but discarded all progress -- now delivers on that promise
- **iOS lock screen controls inverted**: MediaSession `playbackState` was driven by React `useEffect` on `isPlaying` state, which fires asynchronously after render -- not synchronously with the actual audio state change. This caused lock screen controls to show the opposite state (play when playing, pause when paused). Rewrote MediaSession to drive `playbackState` directly from `audioEngine` events, call the engine directly from action handlers to preserve iOS user-gesture context, and use ref-based one-time handler registration to avoid re-registration churn.
- **Favicon showing old Lidify icon or wrong Kima logo**: Browser tab showed the pre-rebrand Lidify favicon. Replaced with the waveform-only icon generated from `kima-black.webp` as a proper multi-size ICO (16/32/48/64/128/256px) with tight cropping so the waveform fills the tab space.
- **Enrichment pipeline: no periodic vibe sweep**: The enrichment cycle had no phase for queueing vibe/CLAP embedding jobs. The only automatic path was a lossy pub/sub event from Essentia completion -- if missed (crash, restart, migration wipe), tracks were orphaned forever. Added Phase 5 that sweeps for tracks with completed audio but missing embedding rows via LEFT JOIN.
- **Enrichment pipeline: crash recovery dead end**: Crash recovery reset `vibeAnalysisStatus` from `processing` to `null`, which nothing in the regular cycle re-queued. Changed to reset to `pending` so the periodic sweep picks them up.
- **Enrichment pipeline: CLAP analyzer permanent death**: When enrichment was stopped, the backend sent a stop command causing the CLAP analyzer to exit cleanly (code 0). Supervisor's `autorestart=unexpected` treated this as expected and never restarted. Changed to `autorestart=true` and removed the stop signal entirely -- the analyzer has its own idle timeout.
- **Enrichment pipeline: completion never triggers**: `isFullyComplete` required `clapCompleted + clapFailed >= trackTotal`, which was impossible after `track_embeddings` was wiped by migration. Now checks for actual un-embedded tracks via LEFT JOIN.
- **Enrichment pipeline: "Reset Vibe Embeddings" incomplete**: `reRunVibeEmbeddingsOnly()` reset `vibeAnalysisStatus` but did not delete existing `track_embeddings` rows, so the re-queue query (which uses LEFT JOIN) silently skipped tracks that already had embeddings. Now deletes all embeddings first for full regeneration.
- **Feature detection: CLAP reported available when disabled**: When `DISABLE_CLAP=true` was set, `checkCLAP()` skipped the file-existence check but still fell through to heartbeat and data checks. If old embeddings existed in the database, it returned `true`, causing the vibe sweep to queue jobs that no CLAP worker would ever process. Now returns `false` immediately when disabled.
- **docker-compose.server.yml healthcheck using removed tool**: Healthcheck used `wget` which is removed from the production image during security hardening. Changed to `node /app/healthcheck.js` to match docker-compose.prod.yml.
- **#126 Subsonic JSON `getGenres.view` breaking Symfonium**: Genre responses used `#text` for the genre name in JSON output -- correct for XML but violates the Subsonic JSON convention which uses `value`. Symfonium's strict JSON parser rejected the response. Fixed `stripAttrPrefix()` to map `#text` to `value` in all JSON responses.
- **#126 Subsonic `getBookmarks.view` not implemented**: Symfonium calls `getBookmarks.view` during sync and expects a valid response with a `bookmarks` key. The endpoint hit the catch-all "not implemented" handler, returning an error without the required key. Added an empty stub returning `{ bookmarks: {} }`.
- **#91 Artist page only showing 5 popular tracks**: Frontend sliced popular tracks to 5 even though the backend returned 10. Now displays all 10.
- **#63 MusicBrainz base URL hardcoded**: MusicBrainz API URL was hardcoded, preventing use of self-hosted mirrors. Now configurable via `MUSICBRAINZ_BASE_URL` environment variable (defaults to `https://musicbrainz.org/ws/2`).

## [1.5.8] - 2026-02-26

### Fixed

- **Mobile playback: infinite network retry loop**: On mobile networks, transient `MEDIA_ERR_NETWORK` errors triggered a retry cycle that never terminated -- `canplay` and `playing` events reset the retry counter to 0 on every cycle, and `audio.load()` reset `currentTime` to 0, causing the "2-3 seconds then starts over" symptom. Fixed by removing the premature counter resets (counter now only resets on new track load) and saving/restoring playback position across retries.
- **Mobile playback: silence keepalive running during active playback**: The silence keepalive element (used to hold the iOS/Android audio session while paused in background) was started via `prime()` from a non-gesture context, then `stop()` failed to pause it because the `play()` promise hadn't resolved yet, making `el.paused` still true. Fixed by adding proper async play-promise tracking with a `pendingStop` flag, and removing the non-gesture `prime()`/`stop()` calls from the audio engine's `playing` event handler.
- **Mobile playback: play button tap fails to resume on iOS**: All in-app play buttons called `resume()` which only set React state; the actual `audio.play()` ran in a `useEffect` after re-render, outside the iOS user-gesture activation window. Fixed by adding a `resumeWithGesture()` helper that calls `audioEngine.tryResume()` and `silenceKeepalive.prime()` synchronously within the gesture context -- the same pattern already used by MediaSession lock-screen handlers. Applied across all 13 play/resume call sites.
- **Mobile playback: lock screen / notification controls unresponsive after app restore**: MediaSession action handlers were never registered when the app loaded with a server-restored track because the `hasPlayedLocallyRef` guard blocked registration, and the handler registration effect's dependency array was missing `isPlaying`, so it never re-ran when the flag was set. Fixed by adding `isPlaying` to the dependency array.
- **Cover art proxy transient fetch errors**: External cover art fetches that hit transient TCP errors (`ECONNRESET`, `ETIMEDOUT`, `UND_ERR_SOCKET`) now retry once with a 500ms delay before failing.

### Security

- **Error message leakage**: All ~82 backend route catch blocks replaced with a `safeError()` helper that logs the full error server-side but returns only `"Internal server error"` to the client. Prevents stack traces, file paths, and internal details from leaking to users.
- **SSRF protection on cover art proxy**: The cover-art proxy endpoint now validates URLs before fetching -- blocks private/loopback IPs, non-HTTP schemes, and resolves DNS to check for rebinding attacks. Audiobook cover paths also block directory traversal.
- **Login timing side-channel**: Login endpoint previously returned early on user-not-found, allowing username enumeration via response timing. Now runs a dummy bcrypt compare against an invalid hash to normalize response times regardless of whether the user exists.
- **Device link code generation**: Replaced `Math.random()` with `crypto.randomInt()` for cryptographically secure device link codes.
- **Unscoped user queries**: Added `select` clauses to all Prisma user queries that previously loaded full rows (including `passwordHash`) when only the ID or specific fields were needed.
- **Metrics endpoint authentication**: `/api/metrics` now requires authentication.
- **Registration gate**: Added `registrationOpen` system setting (default: closed) and rate limiter on the registration endpoint. After the first user is created, new registrations require an admin to explicitly open registration.
- **Admin password reset role check**: Fixed case mismatch (`"ADMIN"` vs `"admin"`) that could allow non-admin users to trigger password resets.

### Housekeeping

- Removed unused `sectionIndex` variables in audiobooks, home, and podcasts pages.
- Removed dead commented-out album cover grid code and unused imports in DiscoverHero.
- Fixed missing `useCallback` wrapper for `loadPresets` in MoodMixer.
- Added missing `previewLoadState` to effect dependency array in usePodcastData.

## [1.5.7] - 2026-02-23

### Added

- **BullMQ enrichment infrastructure**: Rewrote the entire enrichment pipeline on top of BullMQ v5, replacing the custom BLPOP/Redis queue loops. Artist, track, and podcast enrichment all run as proper BullMQ Worker instances with job-level pause, resume, and stop support. All queues are visible in the Bull Board admin dashboard. The orchestrator pushes jobs into BullMQ and uses a sentinel pattern to track when all jobs in a phase have completed before advancing.
- **Reactive vibe queuing**: The Essentia audio analyzer now publishes an `audio:analysis:complete` event to Redis when each track finishes. The CLAP service subscribes and immediately queues a vibe embedding job for that track — eliminating the previous polling-based approach where CLAP scanned the database on a fixed interval looking for newly-completed Essentia tracks.

### Fixed

- **PWA background audio session lost on iOS and Android**: Pausing from lock-screen / notification controls while the app was backgrounded caused iOS to reclaim the audio session, blocking any subsequent `audio.play()` call until the app was foregrounded. Fixes two related symptoms: (1) resuming from lock-screen controls appeared to do nothing until the app was opened, (2) music stopped after extended background playback during track transitions. Fixed by: calling `audioEngine.tryResume()` synchronously inside the MediaSession `play` handler (within the user-activation window iOS grants to MediaSession callbacks); adding a silent looping audio keepalive (`silence-keepalive.ts`) that holds the OS audio session while user audio is paused and the app is backgrounded; loading the next track directly from the `ended` event handler to eliminate the inter-track silence gap that triggered session reclaim; and adding `visibilitychange` / `pageshow` foreground recovery to retry playback if the engine is paused when the app returns to the foreground.
- **Discovery "Retry All" importing entire albums already in library**: The `POST /discover/retry-unavailable` endpoint fetched all raw `UnavailableAlbum` records for the week without applying the same three-level filter the `GET /current` endpoint uses before displaying them. As a result, clicking "Retry All" triggered full re-downloads of albums that were already present in the library (matched by discovery MBID, library MBID, or fuzzy title+artist). The retry handler now applies all three filters before creating download jobs, and deletes stale `UnavailableAlbum` records for albums already in the library so they do not reappear. Closes #34.
- **Mood-tags phase silently skipping all tracks**: `lastfmTags` was `NULL` for tracks that had been enriched before the column was added. The mood-tags enrichment phase queries `WHERE lastfmTags != '{}'`, which never matches `NULL` — so every track was silently skipped every cycle. Migration backfills all `NULL` values to `'{}'` and sets the column default, so newly enriched tracks are never NULL.
- **Docker image size (28.4 GB → 12.2 GB)**: Removed all CUDA and NVIDIA dependencies from the Docker image. The `audio-analyzer` and `audio-analyzer-clap` services now run on CPU-only PyTorch and TensorFlow. Changed pip installs to use the CPU-only PyTorch wheel index (`--index-url https://download.pytorch.org/whl/cpu`), replaced `tensorflow` with `tensorflow-cpu`, and installed `essentia-tensorflow --no-deps` to prevent pip from pulling the GPU TensorFlow variant as a transitive dependency. Removed `nvidia-cudnn-cu12`, `torchvision` (not imported), the `/opt/cudnn8` CUDA layer, and all NVIDIA library paths from the supervisor `LD_LIBRARY_PATH`. No regressions: TensorFlow confirmed running on CPU, all 9 MusiCNN classification heads load normally.
- **Docker build context bloat**: `frontend/node_modules/` (598 MB) and `frontend/.next/` (313 MB) were not excluded from the Docker build context. The `.dockerignore` `node_modules` pattern only matched root-level; changed to `**/node_modules`. Added `**/.next`. Combined these reduced the `COPY frontend/ ./` layer from 946 MB to ~50 MB.
- **Cover art fetch errors for temp-MBID albums**: Albums with temporary MBIDs (temp-*) were being passed to the Cover Art Archive API, causing 400 errors. Added validation to skip temp-MBIDs in artist enrichment and data cache.
- **VIBE-VOCAB vocabulary file missing**: The vocabulary JSON file wasn't being copied to the Docker image because TypeScript doesn't copy .json files automatically. Added explicit import to force tsc to copy it.
- **Redis memory overcommit warning**: Added `vm.overcommit_memory=1` sysctl to docker-compose.prod.yml and docker-compose.server.yml.
- **Z-index stacking order**: MiniPlayer was z-50 (same tier as modals), causing it to appear above open dialogs due to DOM ordering. Established a consistent stacking hierarchy: MiniPlayer z-[45] → TopBar z-50 → VibeOverlay/toasts z-[55] → MobileSidebar backdrop z-[60] / drawer z-[70] → all modals z-[80] → nested confirm z-[85] → toast z-[100] → OverlayPlayer z-[9999]. MobileSidebar was also using non-standard `z-100` which is not a valid Tailwind class.
- **API token display overflowing viewport on iPhone**: The newly-generated token `<code>` block extended beyond the screen on narrow viewports due to missing `min-w-0` / `overflow-hidden` on its flex container; added both.
- **CLAP BullMQ worker crash on startup**: `import psycopg2` does not implicitly import `psycopg2.pool`; the BullMQ vibe worker was crashing immediately because `psycopg2.pool.ThreadedConnectionPool` was referenced without the submodule being imported. Added explicit `import psycopg2.pool`.
- **EnrichmentStateService Redis disconnect error**: Calling `disconnect()` on an already-closed Redis connection raised an unhandled error. The disconnect is now silenced when the connection is already in a closed state.
- **CLAP worker thread-safety**: All PostgreSQL calls in the CLAP BullMQ worker are now wrapped in `run_in_executor` so they execute on a thread-pool thread rather than blocking the asyncio event loop. Connection pool is initialized once per process and shared safely across concurrent jobs.

## [1.5.5] - 2026-02-21

### Added

- **OpenSubsonic / Subsonic API**: Native client support for Amperfy, Symfonium, DSub, Ultrasonic, Finamp, and any other Subsonic-compatible app
  - Full Subsonic REST API v1.16.1 compatibility, with OpenSubsonic extensions declared
  - **MD5 token auth** — standard Subsonic auth now supported; enter your Kima API token as the password in your client app; the server verifies `md5(token + salt)` against stored API keys, avoiding any need to store plaintext login passwords
  - **OpenSubsonic `apiKey` auth** — generate per-client tokens in Settings > Native Apps; tokens can be named and revoked individually
  - **Endpoints implemented**: `ping`, `getArtists`, `getIndexes`, `getArtist`, `getAlbum`, `getSong`, `getAlbumList2`, `getAlbumList`, `getGenres`, `search3`, `search2`, `getRandomSongs`, `stream`, `download`, `getCoverArt`, `scrobble`, `getPlaylists`, `getPlaylist`, `createPlaylist`, `updatePlaylist`, `deletePlaylist`, `getUser`, `getStarred`, `getStarred2`, `star`, `unstar`, `getArtistInfo2`
  - **Enrichment-aware genres** — genre fields on albums, songs, and search results are sourced from Last.fm-enriched artist tags rather than static file tags; `getGenres` aggregates across the enriched artist catalogue
  - **Enrichment-aware biographies** — `getArtistInfo2` returns the user-edited summary when present, otherwise the Last.fm biography
  - **HTTP 206 range support** on `stream.view` for seek-capable clients and Firefox/Safari
  - Scrobbles recorded as `SUBSONIC` listen source
  - DISCOVER-location albums are excluded from all library views
- **Named API tokens** — Settings > Native Apps token generator now accepts a client name (e.g., "Amperfy", "Symfonium"); previously all tokens were named "Subsonic"
- **Public server URL setting** — admins can pin a persistent server URL in Settings > Storage; the Native Apps panel reads this URL and falls back to the browser origin when unset

### Fixed

- **Subsonic `contentType` and `suffix` wrong for FLAC/MP3**: The library scanner stores codec names (`FLAC`, `MPEG 1 Layer 3`) rather than MIME types. Added `normalizeMime()` to translate codec names to proper MIME types before surfacing them to clients — fixes clients that refused to play tracks due to unrecognised content types
- **`createPlaylist` returned empty response**: Per OpenSubsonic spec (since 1.14.0), `createPlaylist` must return the full playlist object. Now returns the same shape as `getPlaylist`
- **DISCOVER albums leaking into search and random**: `getRandomSongs` raw SQL and the `search3`/`search2` shared service had no location filter, allowing DISCOVER-only albums to appear in results. Both are now filtered to `LIBRARY` location only
- **PWA icons**: Replaced placeholder icons with the Kima brand — amber diagonal gradient with radial bloom; solid black background for maskable variants; `apple-touch-icon` added; MediaSession fallback artwork wired up
- **Frontend lint errors** (pre-existing): `let sectionIndex` changed to `const` in three pages; `setPreviewLoadState` moved inside the async function to avoid calling setState synchronously in a `useEffect`
- **Vibe orphaned-completed tracks**: Tracks where `vibeAnalysisStatus = 'completed'` but no embedding row exists (left over from the `reduce_embedding_dimension` migration) are now detected and reset each enrichment cycle so they re-enter the CLAP queue

## [1.5.4] - 2026-02-21

### Fixed

- **Vibe embeddings never starting**: `queueVibeEmbeddings` only checked for `NULL` or `'failed'` status, but the `add_vibe_analysis_fields` migration set the column default to `'pending'` — every track was silently skipped forever. Added `'pending'` to the WHERE clause.
- **CLAP infinite retry**: Added `VIBE_MAX_RETRIES` SQL guard to `queueVibeEmbeddings` so permanently-failed tracks (retry count ≥ 3) are never re-queued. Fixed off-by-one: cleanup used `>=` (giving 2 resets) instead of `>` (giving the correct 3).
- **Null byte crash in music scanner**: ASCII control characters in ID3 tags (e.g. embedded null bytes) caused PostgreSQL query failures. `sanitizeTagString()` now strips control chars from title, artist, and album tags before any DB write.
- **Soulseek stuck downloads cycling**: Downloads removed from the active list on timeout or stream error were not removed from `SlskClient.downloads`, causing the slot to be permanently occupied. Added `removeDownload()` and called it in all three error paths (timeout, download stream error, write stream error).
- **Artist enrichment duplicate MBID race condition**: Two artists resolving to the same real MBID simultaneously caused a Prisma `P2002` unique constraint violation, leaving one artist stuck in `processing`. The error is now caught specifically — the duplicate is immediately marked `unresolvable` with a warning log.
- **Admin vibe retry silently skipping tracks**: `POST /vibe/retry` reset `EnrichmentFailure.retryCount` but left `Track.vibeAnalysisRetryCount` at its max value, causing the SQL guard in `queueVibeEmbeddings` to silently skip the track forever. Both counts are now reset together.
- **Preview job missing ownership check**: Spotify preview jobs stored in Redis had no `userId` — any authenticated user could read or consume another user's preview result. `userId` is now stored in the Redis payload and validated on both `GET /preview/:jobId` and `POST /import`.
- **Playlist import DB pool exhaustion**: `matchTrack` inside `startImport` used an unbounded `Promise.all`, saturating the connection pool on large playlists. Wrapped with `pLimit(8)`.
- **PWA safe area double-inset on iOS**: `body` padding and `AuthenticatedLayout` margin both applied `env(safe-area-inset-*)`, doubling the inset gap. Replaced with `--standalone-safe-area-top/bottom` CSS custom properties that default to `0px` in browser mode and are set to the real env values only inside `@media (display-mode: standalone)`. Fixes both the double-inset on iOS PWA and the Vivaldi browser over-inset.
- **Mobile bottom content gap**: Removed the 96px bottom padding (`pb-24`) reserved for the mini player. The player is swipeable so the padding is no longer needed.

## [1.5.3] - 2026-02-18

### Fixed

- **Circuit breaker `circuitOpenedAt` drift**: `failureCount >= CIRCUIT_BREAKER_THRESHOLD` stayed true after threshold failures, resetting `circuitOpenedAt` on every subsequent `onFailure()` call — the same rolling-timestamp problem as `lastFailureTime`. Added `&& this.circuitOpenedAt === null` to enforce the single-write invariant.
- **Circuit breaker deadlock**: `shouldAttemptReset()` measured time since last failure, which resets every cleanup cycle, so the 5-minute recovery window never expired. Fixed by recording `circuitOpenedAt` at the moment the breaker first opens and measuring from that fixed point.
- **`recordSuccess()` race condition**: Success detection bracketed only `cleanupStaleProcessing()` — a millisecond window that never captured Python completions (~14s batch cadence). Replaced with `audioLastCycleCompletedCount` tracked across cycles; `recordSuccess()` fires whenever the completed count grows since the previous cycle.
- **CLAP vibe queue self-heal**: `queueVibeEmbeddings` filtered `vibeAnalysisStatus = 'pending'`, skipping thousands of tracks left as `'completed'` after the `reduce_embedding_dimension` migration dropped their embeddings. Changed filter to `<> 'processing'` so `te.track_id IS NULL` (actual embedding existence) is the source of truth.

## [1.5.2] - 2026-02-18

### Fixed

- **Audio analysis enrichment deadlock**: Three compounding bugs caused enrichment to deadlock after 12+ hours of operation.
  - `runFullEnrichment` reset `analysisStatus` to `pending` without clearing `analysisRetryCount`, silently orphaning tracks the Python analyzer would never pick up (it ignores tracks with `retryCount >= MAX_RETRIES`).
  - `queueAudioAnalysis` had no `retryCount` filter, queuing tracks Python ignores — these timed out and fed false positives to the circuit breaker.
  - The circuit breaker fired on `permanentlyFailedCount > 0`, which is expected cleanup behavior, making it permanently unrecoverable — it reopened immediately on every `HALF_OPEN` attempt.

## [1.5.1] - 2026-02-18

### Fixed

- **SSE streaming through Next.js proxy**: SSE events were buffered by Next.js rewrites, breaking real-time Soulseek search results and download progress in production. Added a dedicated Next.js API route (`app/api/events/route.ts`) that streams SSE responses directly, bypassing the buffering rewrite proxy.
- **CLAP analyzer startup contention**: CLAP model loaded eagerly on container boot (~20s of CPU/memory), competing with the Essentia audio analyzer during startup. Model now loads lazily on first job, which only arrives after audio analysis completes.

## [1.5.0] - 2026-02-17

### Changed

- **REBRAND**: Project renamed from Lidify to Kima
- Repository moved to `kima-hub` on GitHub
- Docker images now published as `chevron7locked/kima`
- All user-facing references updated across codebase
- First official release under Kima branding
- **Soulseek credential changes**: Settings and onboarding now reset and reconnect Soulseek immediately instead of just disconnecting
- **Soulseek search timeout**: Reduced from 45s to 10s for faster UI response (200+ results stream well within that window)
- **Search result streaming**: Low-quality results (< 128kbps MP3) filtered before streaming to UI, capped at 200 streamed results per search

### Added

- **Album-level Soulseek search**: Discovery downloads use a single album-wide search query with directory grouping and fuzzy title matching, reducing download time from ~15 minutes to ~15-30 seconds
- **SSE-based Soulseek search**: Search results stream to the browser in real-time via Server-Sent Events instead of waiting for the full search to complete
- **Multi-tab audio sync**: BroadcastChannel API prevents multiple browser tabs from playing audio simultaneously -- new tab claims playback, other tabs pause
- **Network error retry**: Audio engine retries on network errors with exponential backoff (2s, 4s) before surfacing the failure
- **Stream eviction notification**: Users see "Playback interrupted -- stream may have been taken by another session" instead of a generic error
- **Stuck discovery batch recovery**: Batches stuck in scanning state are automatically recovered after 10 minutes and force-failed after 30 minutes
- **Stuck Spotify import recovery**: Spotify imports stuck in scanning or downloading states are automatically detected and recovered by the queue cleaner
- **Manual download activity feed**: Soulseek manual downloads now emit `download:complete` events and appear in the activity feed
- **Critical Reliability Fixes**: Eliminated Soulseek connection race conditions with distributed locks
- **100% Webhook Reliability**: Event sourcing with PostgreSQL persistence
- **Download Deduplication**: Database unique constraint prevents duplicate jobs
- **Discovery Batch Locking**: Optimistic locking with version field
- **Redis State Persistence**: Search sessions, blocklists, and cache layer
- **Prometheus Metrics**: Full instrumentation at `/metrics` endpoint
- **Automatic Data Cleanup**: 30-60 day retention policies
- **Database-First Configuration**: Encrypted sensitive credentials with runtime updates
- **Automatic Database Baselining**: Seamless migration for existing databases
- **Complete Type Safety**: Eliminated all `as any` assertions
- **Typed Error Handling**: User-friendly error messages with proper HTTP codes

### Fixed

- **Discovery download timeout**: Album-level search eliminates the per-track search overhead (13 tracks x 5 strategies x 15s) that caused 300s acquisition timeouts
- **Worker scheduling starvation**: `setTimeout` rescheduling moved into `finally` blocks so worker cycles always reschedule, even when pile-up guards cause early return
- **Concurrent discovery generation**: Distributed lock (`discover:generate:{userId}`, 30s TTL) prevents duplicate batches when the generate button is clicked rapidly
- **Recovery scan routing**: Fixed source strings (`"discover-weekly-completion"`, `"spotify-import"`) so recovered stuck scans trigger the correct post-scan handlers instead of silently completing
- **Unbounded scan re-queuing**: Added deduplication flags so stuck batches aren't re-queued by the queue cleaner every 30 seconds
- **buildFinalPlaylist idempotency**: Early return guard prevents duplicate playlist generation if the method is called multiple times for the same batch
- **MediaError SSR safety**: Replaced browser-only `MediaError.MEDIA_ERR_NETWORK` with literal value `2` for Next.js server-side rendering compatibility
- **Soulseek search session leak**: Sessions capped at 50 with oldest-eviction to prevent unbounded Map growth
- **Soulseek cooldown Map leak**: Added 5-minute periodic cleanup of expired entries from connection cooldown Maps, cleared on both `disconnect()` and `forceDisconnect()`
- **Unhandled promise rejection**: Wrapped fire-and-forget search `.then()`/`.catch()` handler bodies in try/catch
- **Batch download fault tolerance**: Replaced `Promise.all` with `Promise.allSettled` in album search download phase and per-track batch search/download phases so one failure doesn't abort the entire batch
- **SSE connection establishment**: Added `res.flushHeaders()` and per-message `flush()` calls to ensure SSE data reaches the client immediately through reverse proxies

### Removed

- Debug `console.log` statements from SSE event route and Soulseek search route
- Dead `playback-released` BroadcastChannel broadcast code from audio player
- Animated search background gradient (replaced with cleaner static layout)

### Infrastructure

- Redis-based distributed locking for race condition prevention
- Webhook event store with automatic retry and reconciliation
- Comprehensive type definitions for Lidarr and Soulseek APIs
- Architecture Decision Records (ADRs) documenting key technical choices

## [1.4.3] - 2026-02-08

### Fixed

- **Backend unresponsiveness after hours of uptime:** Replaced `setInterval` with self-rescheduling `setTimeout` for the 2-minute reconciliation cycle and 5-minute Lidarr cleanup cycle in `workers/index.ts`. Previously, `setInterval` fired unconditionally every 2/5 minutes regardless of whether the previous cycle had completed. Since `withTimeout()` resolves via `Promise.race` but never cancels the underlying operation, timed-out operations continued running as zombies. Over hours, hundreds of concurrent zombie operations accumulated, starving the event loop and exhausting database connections and network sockets. Each cycle now waits for the previous one to fully complete before scheduling the next, making pile-up impossible.

## [1.4.2] - 2026-02-07

### Added

- **GPU acceleration:** CLAP vibe embeddings use GPU when available (NVIDIA Container Toolkit required); MusicCNN stays on CPU where it performs better due to small model size
- **GPU documentation:** README section with install commands for NVIDIA Container Toolkit (Fedora/Nobara/RHEL and Ubuntu/Debian), docker-compose GPU config, and verification steps
- **Model idle unloading:** Both MusicCNN and CLAP analyzers unload ML models after idle timeout, freeing 2-4 GB of RAM when not processing
- **Immediate model unload:** Analyzers detect when all work is complete and unload models immediately instead of waiting for the idle timeout
- **CLAP progress reporting:** Enrichment progress endpoint now includes CLAP processing count and queue length for accurate UI status
- **Discovery similar artists:** Search discover endpoint returns musically similar artists (via Last.fm `getSimilar`) separately from text-match results
- **Alias resolution banner:** UI banner shown when Last.fm resolves an artist name alias (e.g., "of mice" -> "Of Mice & Men")

### Fixed

- **Case-sensitive artist search ([#64](https://github.com/Chevron7Locked/kima-hub/issues/64)):** Added PostgreSQL tsvector search with ILIKE fallback; all artist/album/track searches are now case-insensitive
- **Circuit breaker false trips:** Audio analysis cleanup circuit breaker now counts cleanup runs instead of individual tracks, preventing premature breaker trips on large batches of stale tracks
- **DB reconciliation race condition:** Analyzer marks tracks as `processing` in the database before pushing to Redis queue, preventing the backend from double-queuing the same tracks
- **Enrichment completion detection:** `isFullyComplete` now checks CLAP processing count and queue length, not just completed vs total
- **Search special characters:** `queryToTsquery` strips non-word characters and filters empty terms, preventing PostgreSQL syntax errors on queries like `"&"` or `"..."`
- **NaN pagination limit:** Search endpoints guard against `NaN` limit values from malformed query params
- **Discovery cache key collisions:** Normalized cache keys (lowercase, trimmed, collapsed whitespace) prevent duplicate cache entries for equivalent queries
- **Worker resize pool churn:** Added 5-second debounce to worker count changes from the UI slider, preventing rapid pool destroy/recreate cycles

### Performance

- **malloc_trim memory recovery:** Both analyzers call `malloc_trim(0)` after unloading models, forcing glibc to return freed pages to the OS (6.5 GB active -> 2.0 GB idle)
- **MusicCNN worker pool auto-shutdown:** Worker pool shuts down when no pending work remains, freeing process pool memory without waiting for idle timeout
- **Enrichment queue batch size:** Reduced from 50 to 10 to match analyzer batch size, preventing buildup of stale `processing` tracks
- **Search with tsvector indexes:** Artist, album, and track tables now have generated tsvector columns with GIN indexes for fast full-text search
- **Discovery endpoint parallelized:** Artist search, similar artists, and Deezer image lookups run concurrently instead of sequentially

### Changed

- **Audio streaming range parser:** Replaced Express `res.sendFile()` with custom range parser supporting suffix ranges (`bytes=-N`) and proper 416 responses -- fixes Firefox/Safari streaming issues on large FLAC files
- **Similar artists separation:** Discovery results now split into `results` (text matches) and `similarArtists` (musically similar via Last.fm), replacing the mixed array
- **Last.fm search tightened:** Removed `getSimilarArtists` padding from `searchArtists()` and raised fuzzy match threshold from 50 to 75 to reduce false positives (e.g., "Gothica" matching "Mothica")

### Removed

- Dead enrichment worker (`backend/src/workers/enrichment.ts`) and mood bucket worker (`backend/src/workers/moodBucketWorker.ts`) -- functionality consolidated into unified enrichment worker
- Unused `useDebouncedValue` hook (replaced by `useDebounce` from search hooks)

### Contributors

- @Allram - Soulseek import fix ([#85](https://github.com/Chevron7Locked/kima-hub/pull/85))

## [1.4.1] - 2026-02-06

### Fixed

- **Doubled audio stream on next-track:** Fixed race condition where clicking next/previous played two streams simultaneously by making track-change cleanup synchronous and guarding the play/pause effect during loading
- **Soulseek download returns 400 (#101):** Frontend now sends parsed title to the download endpoint; backend derives artist/title from filename when not provided instead of rejecting the request
- **Admin password reset (#97):** Added `ADMIN_RESET_PASSWORD` environment variable support -- set it and restart to reset the admin password, then remove the variable
- **Retry failed audio analysis UI (#79):** Added "Retry Failed Analysis" button in Settings that resets permanently failed tracks back to pending for re-processing
- **Podcast auto-refresh (#81):** Podcasts now automatically refresh during the enrichment cycle (hourly), checking RSS feeds for new episodes without manual intervention
- **Compilation track matching (#70):** Added title-only fallback matching strategy for playlist reconciliation -- when album artist doesn't match (e.g. "Various Artists" compilations), tracks are matched by title with artist similarity scoring
- **Soulseek documentation (#27):** Expanded README with detailed Soulseek integration documentation covering setup, search, download workflow, and limitations
- **Admin route hardening:** Added `requireAdmin` middleware to onboarding config routes and stale job cleanup endpoint
- **2FA userId leak:** Removed userId from 2FA challenge response (information disclosure)
- **Queue bugs:** Fixed cancelJob/refreshJobMatches not persisting state, clear button was no-op, reorder not restarting track, shuffle indices not updating on removeFromQueue
- **Infinite re-render:** Fixed useAlbumData error handling causing infinite re-render loop
- **2FA status not loading:** Fixed AccountSection not loading 2FA status on mount
- **Password change error key mismatch:** Fixed error key mismatch in AccountSection password change handler
- **Discovery polling leak:** Fixed polling never stopping on batch failure
- **Timer leak:** Fixed withTimeout not clearing timer in enrichment worker
- **Audio play rejection:** Fixed unhandled promise rejection on audio.play()
- **Library tab validation:** Added tab parameter validation in library page
- **Onboarding state:** Separated success/error state in onboarding page
- **Audio analysis race condition (#79):** CLAP analyzer was clobbering Essentia's `analysisStatus` field, causing completed tracks to be reset and permanently failed after 3 cycles; both Python analyzers now check for existing embeddings before resetting
- **Enrichment completion check:** `isFullyComplete` now includes CLAP vibe embeddings, not just audio analysis
- **Enrichment UI resilience:** Added `keepPreviousData` and loading/error states to enrichment progress query so the settings block doesn't vanish on failed refetch

### Performance

- **Recommendation N+1 queries:** Eliminated N+1 queries in all 3 recommendation endpoints (60+ queries down to 3-5)
- **Idle worker pool shutdown:** Essentia analyzer shuts down its 8-worker process pool (~5.6 GB) after idle period, lazily restarts when work arrives

### Changed

- **Shared utility consolidation:** Replaced 10 inline `formatDuration` copies with shared `formatTime`/`formatDuration`, extracted `formatNumber` to shared utility, consolidated inline Fisher-Yates shuffle with shared `shuffleArray`
- **Player hook extraction:** Extracted shared `useMediaInfo` hook, eliminating ~120 lines of duplicated media info logic across MiniPlayer, FullPlayer, and OverlayPlayer
- **Preview hook consolidation:** Consolidated artist/album preview hooks into shared `useTrackPreview`
- **Redundant logging cleanup:** Removed console.error calls redundant with toast notifications or re-thrown errors

### Removed

- Dead player files: VibeOverlay, VibeGraph, VibeOverlayContainer, enhanced-vibe-test page
- Dead code: trackEnrichment.ts, discover/types/index.ts, unused artist barrel file
- Unused exports: `playTrack` from useLibraryActions, `useTrackDisplayData`/`TrackDisplayData` from useMetadataDisplay
- Unused `streamLimiter` middleware
- Deprecated `radiosByGenre` from browse API (Deezer radio requires account; internal library radio used instead)

## [1.4.0] - 2026-02-05

### Performance

- **Sequential audio/vibe enrichment:** Vibe phase skips when audio analysis is still running, preventing concurrent CPU-intensive Python analyzers from competing for resources
- **Faster enrichment cycles:** Reduced cycle interval from 30s to 5s; the rate limiter already handles API throttling, making the extra delay redundant
- **GPU auto-detection (CLAP):** PyTorch-based CLAP vibe embeddings auto-detect and use GPU when available, falling back to CPU
- **GPU auto-detection (Essentia):** TensorFlow-based audio analysis detects GPU with memory growth enabled, with device logging on startup

### Changed

- **Enrichment orchestration simplified:** Replaced 4 phase functions with duplicated stop/pause handling with a generic `runPhase()` executor and `shouldHaltCycle()` helper

### Fixed

- **Docker frontend routing:** Fixed `NEXT_PUBLIC_BACKEND_URL` build-time env var in Dockerfile so the frontend correctly proxies API requests to the backend
- **Next.js rewrite proxy:** Updated rewrite config to use `NEXT_PUBLIC_BACKEND_URL` for consistent build-time/runtime behavior
- **False lite mode on startup:** Feature detection now checks for analyzer scripts on disk, preventing false "lite mode" display before analyzers send their first heartbeat
- **Removed playback error banner:** Removed the red error bar from all player components (FullPlayer, MiniPlayer, OverlayPlayer) that displayed raw Howler.js error codes
- **Enrichment failure notifications:** Replaced aggressive per-cycle error banner with a single notification through the notification system when enrichment completes with failures

## [1.3.9] - 2026-02-04

### Fixed

- **Audio analysis cleanup:** Fixed race condition in audio analysis cleanup that could reset tracks still being processed

## [1.3.8] - 2026-02-03

### Fixed

- **Enrichment:** CLAP queue and failure cleanup fixes for enrichment debug mode

## [1.3.7] - 2026-02-01

### Added

#### CLAP Audio Analyzer (Major Feature)

New ML-based audio analysis using CLAP (Contrastive Language-Audio Pretraining) embeddings for semantic audio understanding.

- **CLAP Analyzer Service:** Python-based analyzer using Microsoft's CLAP model for generating audio embeddings
- **pgvector Integration:** Added PostgreSQL vector extension for efficient similarity search on embeddings
- **Vibe Similarity:** "Find similar tracks" feature using hybrid similarity (CLAP embeddings + BPM/key matching)
- **Vibe Explorer UI:** Test page for exploring audio similarity at `/vibe-ui-test`
- **Settings Integration:** CLAP embeddings progress display and configurable worker count in Settings
- **Enrichment Phase 4:** CLAP embedding generation integrated into enrichment pipeline

#### Feature Detection

Automatic detection of available analyzers with graceful degradation.

- **Feature Detection Service:** Backend service that monitors analyzer availability via Redis heartbeats
- **Features API:** New `/api/system/features` endpoint exposes available features to frontend
- **FeaturesProvider:** React context for feature availability throughout the app
- **Graceful UI:** Vibe button hidden when embeddings unavailable; analyzer controls greyed out in Settings
- **Onboarding:** Shows detected features instead of manual toggles

#### Docker & Deployment

- **Lite Mode:** New `docker-compose.lite.yml` override for running without optional analyzers
- **All-in-One Image:** CLAP analyzer and pgvector included in main Docker image
- **Analyzer Profiles:** Optional services can be enabled/disabled via compose overrides

#### Other

- **Local Image Storage:** Artist images stored locally with artist counts
- **Hybrid Similarity Service:** Combines CLAP embeddings with BPM and musical key for better matches
- **BPM/Key Similarity Functions:** Database functions for musical attribute matching

### Fixed

- **CLAP Queue Name:** Corrected queue name to `audio:clap:queue`
- **CLAP Large Files:** Handle large audio files by chunking to avoid memory issues
- **CLAP Dependencies:** Added missing torchvision dependency and fixed model path
- **Embedding Index:** Added missing IVFFlat index to embedding migration for query performance
- **Library Page Performance:** Artist images now cache properly - removed JWT tokens from cover-art URLs that were breaking Service Worker and HTTP cache (tokens only added for CORS canvas access on detail pages)
- **Service Worker:** Increased image cache limit from 500 to 2000 entries for better coverage of large libraries

### Performance

- **CLAP Extraction:** Always extract middle 60s of audio for efficient embedding generation
- **CLAP Duration:** Pass duration from database to avoid file probe overhead
- **Vibe Query:** Use CTE to avoid duplicate embedding lookup in similarity queries
- **PopularArtistsGrid:** Added `memo()` wrapper to prevent unnecessary re-renders when parent state changes
- **FeaturedPlaylistsGrid:** Added `memo()` wrapper and `useCallback` for click handler to ensure child `PlaylistCard` memoization works correctly
- **Scan Reconciliation:** Fixed N+1 database query pattern - replaced per-job album lookups with single batched query, reducing ~250 queries to ~3 queries for 100 pending jobs

### Security

- **Vibe API:** Added internal auth to vibe failure endpoint

### Changed

- **Docker Profiles:** Replaced Docker profiles with override file approach for better compatibility
- **Mood Columns:** Marked as legacy in schema - may be derived from CLAP embeddings in future

## [1.3.5] - 2026-01-22

### Fixed

- **Audio preload:** Emit preload 'load' event asynchronously to prevent race condition during gapless playback

## [1.3.4] - 2026-01-22

### Added

- **Gapless playback:** Preload infrastructure and next-track preloading for seamless transitions
- **Infinite scroll:** Library artists, albums, and tracks now use infinite query pagination
- **CachedImage:** Migrated to Next.js Image component with proper type support

### Fixed

- **CSS hover performance:** Fixed hover state performance issues
- **Audio analyzer:** Fixed Enhanced mode detection
- **Onboarding:** Accessibility improvements
- **Audio format detection:** Simplified to prevent wrong decoder attempts
- **Audio cleanup:** Improved Howl instance cleanup to prevent memory leaks
- **Audio cleanup tracking:** Use Set for pending cleanup tracking
- **Redis connections:** Disconnect enrichmentStateService connections on shutdown

### Changed

- **Library page:** Optimized data fetching with tab-based queries and memoized delete handlers

## [1.3.3] - 2026-01-18

Comprehensive patch release addressing critical stability issues, performance improvements, and production readiness fixes. This release includes community-contributed fixes and extensive internal code quality improvements.

### Fixed

#### Critical (P1)

- **Docker:** PostgreSQL/Redis bind mount permission errors on Linux hosts ([#59](https://github.com/Chevron7Locked/kima-hub/issues/59)) - @arsaboo via [#62](https://github.com/Chevron7Locked/kima-hub/pull/62)
- **Audio Analyzer:** Memory consumption/OOM crashes with large libraries ([#21](https://github.com/Chevron7Locked/kima-hub/issues/21), [#26](https://github.com/Chevron7Locked/kima-hub/issues/26)) - @rustyricky via [#53](https://github.com/Chevron7Locked/kima-hub/pull/53)
- **LastFM:** ".map is not a function" crashes with obscure artists ([#37](https://github.com/Chevron7Locked/kima-hub/issues/37)) - @RustyJonez via [#39](https://github.com/Chevron7Locked/kima-hub/pull/39)
- **Wikidata:** 403 Forbidden errors from missing User-Agent header ([#57](https://github.com/Chevron7Locked/kima-hub/issues/57))
- **Downloads:** Singles directory creation race conditions ([#58](https://github.com/Chevron7Locked/kima-hub/issues/58))
- **Firefox:** FLAC playback stopping at ~4:34 mark on large files ([#42](https://github.com/Chevron7Locked/kima-hub/issues/42), [#17](https://github.com/Chevron7Locked/kima-hub/issues/17))
- **Downloads:** "Skip Track" fallback setting ignored, incorrectly falling back to Lidarr ([#68](https://github.com/Chevron7Locked/kima-hub/issues/68))
- **Auth:** Login "Internal Server Error" and "socket hang up" on NAS hardware ([#75](https://github.com/Chevron7Locked/kima-hub/issues/75))
- **Podcasts:** Seeking backward causing player crash and backend container hang
- **API:** Rate limiter crash with "trust proxy" validation error causing socket hang up
- **Downloads:** Duplicate download jobs created due to race condition (database-level locking fix)

#### Quality of Life (P2)

- **Desktop UI:** Added missing "Releases" link to desktop sidebar navigation ([#41](https://github.com/Chevron7Locked/kima-hub/issues/41))
- **iPhone:** Dynamic Island/notch overlapping TopBar buttons ([#54](https://github.com/Chevron7Locked/kima-hub/issues/54))
- **Album Discovery:** Cover Art Archive timeouts causing slow page loads (2s timeout added)
- **Wikimedia:** Image proxy 429 rate limiting due to incomplete User-Agent header

### Added

- **Selective Enrichment Controls:** Individual "Re-run" buttons for Artists, Mood Tags, and Audio Analysis in Settings
- **XSS Protection:** DOMPurify sanitization for artist biography HTML content
- **AbortController:** Proper fetch request cleanup on component unmount across all hooks

### Changed

- **Performance:** Removed on-demand image fetching from library endpoints (faster page loads)
- **Performance:** Added concurrency limit to Deezer preview fetching (prevents rate limiting)
- **Performance:** Corrected batching for on-demand artist image fetching
- **Soulseek:** Connection stability improvements with auto-disconnect on credential changes
- **Backend:** Production build now uses compiled JavaScript instead of tsx transpilation (faster startup, lower memory on NAS)

### Security

- **XSS Prevention:** Artist bios now sanitized with DOMPurify before rendering
- **Race Conditions:** Database-level locking prevents duplicate download job creation

### Technical Details

#### Community Fixes

- **Docker Permissions (#62):** Creates `/data/postgres` and `/data/redis` directories with proper ownership; validates write permissions at startup using `gosu <user> test -w`
- **Audio Analyzer Memory (#53):** TensorFlow GPU memory growth enabled; `MAX_ANALYZE_SECONDS` configurable (default 90s); explicit garbage collection in finally blocks
- **LastFM Normalization (#39):** `normalizeToArray()` utility wraps single-object API responses; protects 5 locations in artist discovery endpoints

#### Hotfixes

- **Wikidata User-Agent (#57):** All 4 API endpoints now use configured axios client with proper User-Agent header
- **Singles Directory (#58):** Replaced TOCTOU `existsSync()`+`mkdirSync()` pattern with idempotent `mkdir({recursive: true})`
- **Firefox FLAC (#42):** Replaced Express `res.sendFile()` with manual range request handling via `fs.createReadStream()` with proper `Content-Range` headers
- **Skip Track (#68):** Auto-fallback logic now only activates for undefined/null settings, respecting explicit "none" (Skip Track) preference
- **NAS Login (#75):** Backend now built with `tsc` and runs with `node dist/index.js`; proxy trust setting updated; session secret standardized
- **Podcast Seek:** AbortController cancels upstream requests on client disconnect; stream error handlers prevent crashes
- **Rate Limiter:** All rate limiter configurations disable proxy validation (`validate: { trustProxy: false }`)
- **Wikimedia Proxy:** User-Agent standardized to `"Lidify/1.0.0 (https://github.com/Chevron7Locked/kima-hub)"` across all external API calls

#### Production Readiness Improvements

Internal code quality and stability fixes discovered during production readiness review:

**Security:**
- ReDoS guard on `stripAlbumEdition()` regex (500 char input limit)
- Rate limiter path matching uses precise patterns instead of vulnerable `includes()` checks

**Race Conditions:**
- Spotify token refresh uses promise singleton pattern
- Import job state re-fetched after `checkImportCompletion()`
- useSoulseekSearch has cancellation flag pattern

**Memory Leaks:**
- failedUsers Map periodic cleanup (every 5 min)
- jobLoggers Map cleanup on all completion/failure paths

**Code Quality:**
- Async executor anti-pattern removed from Soulseek `searchTrack()`
- Timeout cleanup in catch blocks
- Proper error type narrowing (`catch (error: unknown)`)
- Null guards in artistNormalization functions
- Fisher-Yates shuffle replaces biased `Math.random()` sort
- Debug console.log statements removed/converted
- Empty catch blocks now have proper error handling
- Stale closures fixed with refs in event handlers
- Dead code and unused imports removed

**CSS:**
- Tailwind arbitrary value syntax corrected
- Duplicate z-index values removed

**Infrastructure:**
- Explicit database connection pool configuration
- Deezer album lookups routed through global rate limiter
- Consistent toast system usage

### Deferred to Future Release

- **PR #49** - Playlist visibility toggle (needs PR review)
- **PR #47** - Mood bucket tags (already implemented, verify and close)
- **PR #36** - Docker --user flag (needs security review)

### Contributors

Thanks to everyone who contributed to this release:

- @arsaboo - Docker bind mount permissions fix ([#62](https://github.com/Chevron7Locked/kima-hub/pull/62))
- @rustyricky - Audio analyzer memory limits ([#53](https://github.com/Chevron7Locked/kima-hub/pull/53))
- @RustyJonez - LastFM array normalization ([#39](https://github.com/Chevron7Locked/kima-hub/pull/39))
- @tombatossals - Testing and validation
- @zeknurn - Skip Track bug report ([#68](https://github.com/Chevron7Locked/kima-hub/issues/68))

---

## [1.3.2] - 2026-01-07

### Fixed
- Mobile scrolling blocked by pull-to-refresh component
- Pull-to-refresh component disabled

### Technical Details
- Root cause: CSS flex chain break (`h-full`) and touch event interference
- Implemented early return to bypass problematic wrapper while preserving child rendering

## [1.3.1] - 2026-01-07

### Fixed
- Production database schema mismatch causing SystemSettings endpoints to fail
- Added missing `downloadSource` and `primaryFailureFallback` columns to SystemSettings table

### Database Migrations
- `20260107000000_add_download_source_columns` - Idempotent migration adds missing columns with defaults

### Technical Details
- Root cause: Migration gap between squashed init migration and production database setup
- Uses PostgreSQL IF NOT EXISTS pattern for safe deployment across all environments
- Default values: `downloadSource='soulseek'`, `primaryFailureFallback='none'`

## [1.3.0] - 2026-01-06

### Added

- Multi-source download system with configurable Soulseek/Lidarr primary source and fallback options
- Configurable enrichment speed control (1-5x concurrency) in Settings > Cache & Automation
- Stale job cleanup button in Settings to clear stuck Discovery batches and downloads
- Mobile touch drag support for seek sliders on all player views
- Skip +/-30s buttons for audiobooks/podcasts on mobile players
- iOS PWA media controls support (Control Center and Lock Screen)
- Artist name alias resolution via Last.fm (e.g., "of mice" -> "Of Mice & Men")
- Library grid now supports 8 columns on ultra-wide displays (2xl breakpoint)
- Artist discography sorting options (Year/Date Added)
- Enrichment failure notifications with retry/skip modal
- Download history deduplication to prevent duplicate entries
- Utility function for normalizing API responses to arrays (`normalizeToArray`) - @tombatossals
- Keyword-based mood scoring for standard analysis mode tracks - @RustyJonez
- Global and route-level error boundaries for better error handling
- React Strict Mode for development quality checks
- Next.js image optimization enabled by default
- Mobile-aware animation rendering (GalaxyBackground disables particles on mobile)
- Accessibility motion preferences support (`prefers-reduced-motion`)
- Lazy loading for heavy components (MoodMixer, VibeOverlay, MetadataEditor)
- Bundle analyzer tooling (`npm run analyze`)
- Loading states for all 10 priority routes
- Skip links for keyboard navigation (WCAG 2.1 AA compliance)
- ARIA attributes on all interactive controls and navigation elements
- Toast notifications with ARIA live regions for screen readers
- Bull Board admin dashboard authentication (requires admin user)
- Lidarr webhook signature verification with configurable secret
- Encryption key validation on startup (prevents insecure defaults)
- Session cookie security (httpOnly, sameSite=strict, secure in production)
- Swagger API documentation authentication in production
- JWT token expiration (24h access tokens, 30d refresh tokens)
- JWT refresh token endpoint (`/api/auth/refresh`)
- Token version validation (password changes invalidate existing tokens)
- Download queue reconciliation on server startup (marks stale jobs as failed)
- Redis batch operations for cache warmup (MULTI/EXEC pipelining)
- Memory-efficient database-level shuffle (`ORDER BY RANDOM() LIMIT n`)
- Dynamic import caching in queue cleaner (lazy-load pattern)
- Database index for `DownloadJob.targetMbid` field
- PWA install prompt dismissal persistence (7-day cooldown)

### Fixed

- **Critical:** Audio analyzer crashes on libraries with non-ASCII filenames ([#6](https://github.com/Chevron7Locked/kima-hub/issues/6))
- **Critical:** Audio analyzer BrokenProcessPool after ~1900 tracks ([#21](https://github.com/Chevron7Locked/kima-hub/issues/21))
- **Critical:** Audio analyzer OOM kills with aggressive worker auto-scaling ([#26](https://github.com/Chevron7Locked/kima-hub/issues/26))
- **Critical:** Audio analyzer model downloads and volume mount conflicts ([#2](https://github.com/Chevron7Locked/kima-hub/issues/2))
- Radio stations playing songs from wrong decades due to remaster dates ([#43](https://github.com/Chevron7Locked/kima-hub/issues/43))
- Manual metadata editing failing with 500 errors ([#9](https://github.com/Chevron7Locked/kima-hub/issues/9))
- Active downloads not resolving after Lidarr successfully imports ([#31](https://github.com/Chevron7Locked/kima-hub/issues/31))
- Discovery playlist downloads failing for artists with large catalogs ([#34](https://github.com/Chevron7Locked/kima-hub/issues/34))
- Discovery batches stuck in "downloading" status indefinitely
- Audio analyzer rhythm extraction failures on short/silent audio ([#13](https://github.com/Chevron7Locked/kima-hub/issues/13))
- "Of Mice & Men" artist name truncated to "Of Mice" during scanning
- Edition variant albums (Remastered, Deluxe) failing with "No releases available"
- Downloads stuck in "Lidarr #1" state for 5 minutes before failing
- Download duplicate prevention race condition causing 10+ duplicate jobs
- Lidarr downloads incorrectly cancelled during temporary network issues
- Discovery Weekly track durations showing "NaN:NaN"
- Artist name search ampersand handling ("Earth, Wind & Fire")
- Vibe overlay display issues on mobile devices
- Pagination scroll behavior (now scrolls to top instead of bottom)
- LastFM API crashes when receiving single objects instead of arrays ([#37](https://github.com/Chevron7Locked/kima-hub/issues/37)) - @tombatossals
- Mood bucket infinite loop for tracks analyzed in standard mode ([#40](https://github.com/Chevron7Locked/kima-hub/issues/40)) - @RustyJonez
- Playlist visibility toggle not properly syncing hide/show state - @tombatossals
- Audio player time display showing current time exceeding total duration (e.g., "58:00 / 54:34")
- Progress bar could exceed 100% for long-form media with stale metadata
- Enrichment P2025 errors when retrying enrichment for deleted entities
- Download settings fallback not resetting when changing primary source
- SeekSlider touch events bubbling to parent OverlayPlayer swipe handlers
- Audiobook/podcast position showing 0:00 after page refresh instead of saved progress
- Volume slider showing no visual fill indicator for current level
- PWA install prompt reappearing after user dismissal

### Changed

- Audio analyzer default workers reduced from auto-scale to 2 (memory conservative)
- Audio analyzer Docker memory limits: 6GB limit, 2GB reservation
- Download status polling intervals: 5s (active) / 10s (idle) / 30s (none), previously 15s
- Library pagination options changed to 24/40/80/200 (divisible by 8-column grid)
- Lidarr download failure detection now has 90-second grace period (3 checks)
- Lidarr catalog population timeout increased from 45s to 60s
- Download notifications now use API-driven state instead of local pending state
- Enrichment stop button now gracefully finishes current item before stopping
- Per-album enrichment triggers immediately instead of waiting for batch completion
- Lidarr edition variant detection now proactive (enables `anyReleaseOk` before first search)
- Discovery system now uses AcquisitionService for unified album/track acquisition
- Podcast and audiobook time display now shows time remaining instead of total duration
- Edition variant albums automatically fall back to base title search when edition-specific search fails
- Stale pending downloads cleaned up after 2 minutes (was indefinite)
- Download source detection now prioritizes actual service availability over user preference

### Removed

- Artist delete buttons hidden on mobile to prevent accidental deletion
- Audio analyzer models volume mount (shadowed built-in models)

### Database Migrations Required

```bash
# Run Prisma migrations
cd backend
npx prisma migrate deploy
```

**New Schema Fields:**

- `Album.originalYear` - Stores original release year (separate from remaster dates)
- `SystemSettings.enrichmentConcurrency` - User-configurable enrichment speed (1-5)
- `SystemSettings.downloadSource` - Primary download source selection
- `SystemSettings.primaryFailureFallback` - Fallback behavior on primary source failure
- `SystemSettings.lidarrWebhookSecret` - Shared secret for Lidarr webhook signature verification
- `User.tokenVersion` - Version number for JWT token invalidation on password change
- `DownloadJob.targetMbid` - Index added for improved query performance

**Backfill Script (Optional):**

```bash
# Backfill originalYear for existing albums
cd backend
npx ts-node scripts/backfill-original-year.ts
```

### Breaking Changes

- None - All changes are backward compatible

### Security

- **Critical:** Bull Board admin dashboard now requires authenticated admin user
- **Critical:** Lidarr webhooks verify signature/secret before processing requests
- **Critical:** Encryption key validation on startup prevents insecure defaults
- Session cookies use secure settings in production (httpOnly, sameSite=strict, secure)
- Swagger API documentation requires authentication in production (unless `DOCS_PUBLIC=true`)
- JWT tokens have proper expiration (24h access, 30d refresh) with refresh token support
- Password changes invalidate all existing tokens via tokenVersion increment
- Transaction-based download job creation prevents race conditions
- Enrichment stop control no longer bypassed by worker state
- Download queue webhook handlers use Serializable isolation transactions
- Webhook race conditions protected with exponential backoff retry logic

---

## Release Notes

When deploying this update:

1. **Backup your database** before running migrations
2. **Set required environment variable** (if not already set):
   ```bash
   # Generate secure encryption key
   SETTINGS_ENCRYPTION_KEY=$(openssl rand -base64 32)
   ```
3. Run `npx prisma migrate deploy` in the backend directory
4. Optionally run the originalYear backfill script for era mix accuracy:
   ```bash
   cd backend
   npx ts-node scripts/backfill-original-year.ts
   ```
5. Clear Docker volumes for audio-analyzer if experiencing model issues:
   ```bash
   docker volume rm lidify_audio_analyzer_models 2>/dev/null || true
   docker compose build audio-analyzer --no-cache
   ```
6. Review Settings > Downloads for new multi-source download options
7. Review Settings > Cache for new enrichment speed control
8. Configure Lidarr webhook secret in Settings for webhook signature verification (recommended)
9. Review Settings > Security for JWT token settings

### Known Issues

- Pre-existing TypeScript errors in spotifyImport.ts matchTrack method (unrelated to this release)
- Simon & Garfunkel artist name may be truncated due to short second part (edge case, not blocking)

### Contributors

Big thanks to everyone who contributed, tested, and helped make this release happen:

- @tombatossals - LastFM API normalization utility ([#39](https://github.com/Chevron7Locked/kima-hub/pull/39)), playlist visibility toggle fix ([#49](https://github.com/Chevron7Locked/kima-hub/pull/49))
- @RustyJonez - Mood bucket standard mode keyword scoring ([#47](https://github.com/Chevron7Locked/kima-hub/pull/47))
- @iamiq - Audio analyzer crash reporting ([#2](https://github.com/Chevron7Locked/kima-hub/issues/2))
- @volcs0 - Memory pressure testing ([#26](https://github.com/Chevron7Locked/kima-hub/issues/26))
- @Osiriz - Long-running analysis testing ([#21](https://github.com/Chevron7Locked/kima-hub/issues/21))
- @hessonam - Non-ASCII character testing ([#6](https://github.com/Chevron7Locked/kima-hub/issues/6))
- @niles - RhythmExtractor edge case reporting ([#13](https://github.com/Chevron7Locked/kima-hub/issues/13))
- @TheChrisK - Metadata editor bug reporting ([#9](https://github.com/Chevron7Locked/kima-hub/issues/9))
- @lizar93 - Discovery playlist testing ([#34](https://github.com/Chevron7Locked/kima-hub/issues/34))
- @brokenglasszero - Mood tags feature verification ([#35](https://github.com/Chevron7Locked/kima-hub/issues/35))

And all users who reported bugs, tested fixes, and provided feedback!

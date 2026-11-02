/**
 * What each release tells and asks the user; edit this when cutting a release. The window opens on the release's
 * `note` (the maintainer's own words), then lists every item by its one-line `summary`; each item opens on its own page.
 * A `note` item informs, an `action` offers something to run, a `choice` asks and defaults to false. Dismissing
 * records untouched choices at their default (`decidedBy: DISMISSED`), so silence is never consent.
 */

/** An in-app page an item points to. */
interface ReleaseLink {
    label: string;
    href: string;
}

interface ItemBase {
    /** Stable id, so copy can change without losing anything. */
    key: string;
    title: string;
    /** One line in the window's list. */
    summary: string;
    /** The item's own page. Blank lines separate paragraphs. */
    body: string;
    links?: ReleaseLink[];
}

export type ReleaseItem =
    | (ItemBase & {
          kind: "note";
          /** Show only when the library holds enrichment from before this release's date (an upgrade, not a fresh install). */
          olderLibraryOnly?: boolean;
      })
    | (ItemBase & {
          kind: "action";
          /** The label on the button that runs it. */
          cta: string;
          /** Something the window runs itself, behind a confirm. */
          run?: "wipeEnrichment" | "refileAlbums";
          confirmTitle?: string;
          confirmMessage?: string;
          confirmLabel?: string;
          /**
           * What closing the window without acting means for this item, said in the footer. Set it when the item
           * asks for a decision.
           */
          ifClosed?: string;
          /**
           * Show only to users it applies to (the server filters in `forUser`): "savedMoodMix" is a mix
           * under a current mood, "retiredMoodMix" one under a mood that no longer exists, "admin" an admin.
           */
          requires?: "savedMoodMix" | "retiredMoodMix" | "admin";
          /** Show only when the library holds enrichment from before this release's date (an upgrade, not a fresh install). */
          olderLibraryOnly?: boolean;
          /**
           * Show only on a server set up before this release's date. Unlike olderLibraryOnly it stays true after the
           * upgrade re-analyses the library, for an item that is owed until it is run.
           */
          installedBeforeOnly?: boolean;
      })
    | (ItemBase & {
          kind: "choice";
          /**
           * Always false. Present as a field rather than a constant so the shape survives a future
           * opt-out-by-default choice, and so a reader can see what dismissing the window will record.
           */
          defaultValue: false;
          /** What actually leaves the machine. Say it exactly. */
          discloses?: string;
          /** Only shown to admins when "admin": the setting it writes is system-wide. */
          requires?: "admin";
      });

export interface Release {
    version: string;
    /** The window's heading. A name, not a summary. */
    title: string;
    /** One sentence, for clients that show no note. */
    summary: string;
    date: string;
    /** A note from the person who made the release, shown first. */
    note?: { from: string; body: string };
    items: ReleaseItem[];
}

/**
 * The GPU choice's key. The release window only records the decision;
 * the route applies it through the same service the Settings toggle uses.
 */
export const GPU_CHOICE_KEY = "gpu.accelerate";

const WIPE_MESSAGE =
    "Clears what Kima worked out about your music: which recording each track is, audio analysis, vibe data, the " +
    "vibe map, artist bios and similar artists. Then it works it all out again with the new engine. Your music, playlists, plays, likes and edits stay. " +
    "Takes a few hours on a large library; the vibe map is back when it finishes.";

const KEVIN_1_11 = [
    "Hey y'all.",
    "I know updates have been slow. If you've stuck around, thank you. If this is your first install, great timing.",
    "I've had a series of unfortunate events since Kima launched, oddly. Painful family passings in short order, " +
        "animal emergencies keeping us at the vet overnight, and of course the atrocity that is the American corporate " +
        "grind. I also have ADHD, so I hyperfocus on shit and realize later I've been neglecting the big boy. " +
        "That's done now. My focus is Kima: the mobile application and, most importantly, the vibe engine.",
    "Through all of that I've been building Kima v2, and this enrichment engine rebuild is phase 1. This update " +
        "needs a complete wipe and rerun of the engine. Only the engine's data gets wiped; your music, playlists, " +
        "plays and likes stay exactly as they are. I think you'll be happy you did.",
    "The plan is to modularize Kima with a store. The base app stays pure music + vibes. Everything else " +
        "\u2014 audiobooks, podcasts, future additions \u2014 comes from the store, and you configure what your Kima " +
        "includes. People have asked me to let them strip audiobooks out; they'll be able to. And I want room for " +
        "you to publish your own modules for anyone to pull from.",
    "If you've stuck around, if you yell at the app in frustration (I do) but still hang in \u2014 I " +
        "love you. Thanks again, and I hope this update makes y'all feel good. We need it in this world.",
].join("\n\n");

export const RELEASES: Release[] = [
    {
        version: "1.12.0",
        title: "Kima 1.12",
        summary:
            "Moods that come from listening, 14 mood stations and new daily mixes, Discover kept to Discover, a podcast browser, a new side panel, and security fixes.",
        date: "2026-11-02",
        items: [
            {
                kind: "note",
                key: "sound.rebuild",
                title: "Your sound features are rebuilt after this update",
                summary:
                    "Kima now uses the music-tuned sound model, so it analyses every song again and builds its sound vectors again, in the background.",
                body:
                    "This update replaces the sound vectors your library got in 1.11 with ones from the music-tuned sound " +
                    "model. It also analyses every song again, because analysis now reads the middle of each song and works out feel differently. Both " +
                    "run in the background; you don't need to start anything.\n\n" +
                    "Until it finishes, similar tracks, the vibe map, search by sound, and the new mood stations and mixes " +
                    "fill in as songs are done. Everything else stays as it is: your music, playlists, plays, likes, edits, " +
                    "identification and artists.\n\n" +
                    "How long it takes depends on your library and hardware: just under two hours for 9,176 songs with a " +
                    "GPU, and longer without one. Settings, under Library, shows the progress.",
                links: [{ label: "See progress in Settings", href: "/settings/library" }],
                olderLibraryOnly: true,
            },
            {
                kind: "action",
                key: "albums.refile",
                title: "Re-file albums by their tags",
                summary: "Puts albums older versions filed under the wrong artist back where their songs' tags say.",
                body:
                    "Older versions of Kima could file an album under the wrong artist. Band names were cut at " +
                    "\"and\", \"&\" or \"with\" (Coheed and Cambria became Coheed), one song tagged with a guest's " +
                    "name split off its album under that guest, and a tag naming two artists was glued into one name. " +
                    "This version files new songs the right way, but albums already in your library stay where they " +
                    "were put.\n\n" +
                    "Re-filing reads every song's tags again and moves each album to the artist its songs name, joining " +
                    "it to that artist's copy of the album when there is one. Albums you edited and Discover's albums " +
                    "stay where they are, and nothing is merged into them. Plays, likes and playlists stay with their " +
                    "songs. It takes a few minutes on a " +
                    "large library, and the result shows in your notifications. You can also run it any time from " +
                    "Settings, under Library.",
                cta: "Re-file albums",
                run: "refileAlbums",
                confirmTitle: "Re-file albums by their tags?",
                confirmMessage:
                    "Reads every song's tags again and files each album under the artist its songs name. Albums you " +
                    "edited and Discover's albums stay where they are, and nothing is merged into them; plays, likes and " +
                    "playlists stay with their songs.",
                confirmLabel: "Re-file albums",
                requires: "admin",
                installedBeforeOnly: true,
            },
            {
                kind: "note",
                key: "moods.learned",
                title: "Moods that come from listening",
                summary: "Every song is scored on 21 moods, learned from songs people have tagged, and judged against your own library.",
                body:
                    "Kima now reads moods from the sound itself. Each song is scored on 21 moods, from calm, dreamy and " +
                    "nostalgic to energetic, aggressive, groovy and epic. Each mood was learned from thousands of songs " +
                    "people have tagged with it, and is read from the same sound vectors that match your songs.\n\n" +
                    "A song counts as a mood when it scores well above what is usual for your library, so \"calm\" means " +
                    "calm for your music. Mood tags, mood mixes, mood stations and the vibe map's mood view all use the " +
                    "same scores and the same line.\n\n" +
                    "Moods are their own step in Settings, under Library, after sound vectors, and you can re-run them there.",
                links: [{ label: "Open radio", href: "/radio" }],
            },
            {
                kind: "note",
                key: "radio.stations",
                title: "14 mood stations",
                summary: "Calm, Energy, Intense, Happy, Melancholy, two Focus stations, Late Night and more, each an endless shuffle of your own music.",
                body:
                    "The radio page has 14 mood stations: Calm, Energy, Intense, Happy, Melancholy, Focus: Calm, Focus: " +
                    "Energy, Feel-good, Late Night, Romantic, Road Trip, Nostalgic, Epic and Wildcard. Each plays every " +
                    "song in your library that fits, spread so one artist doesn't run together.\n\n" +
                    "Late Night is yours alone: it starts from the songs you actually play between 10pm and 4am, then " +
                    "songs like them. Wildcard plays the songs no mood claims. Genre stations now count each genre once, " +
                    "however it is spelled, and play only your library. Each station's tile shows a cover from its own " +
                    "songs, the same one all day, and every genre station has a colour of its own.",
                links: [{ label: "Open radio", href: "/radio" }],
            },
            {
                kind: "note",
                key: "mixes.recipes",
                title: "New daily mixes",
                summary: "Mixes are built from moods and how songs sound, 20 songs each, fresh every day, two songs per artist at most.",
                body:
                    "Daily mixes are now recipes: each one asks for a blend of moods and readings (tempo, energy, " +
                    "instrumental or not) and draws 20 songs that fit, at most two by any one artist, fresh each day and " +
                    "different for each person. Some lean toward songs like the ones you play most. Midnight Drive and " +
                    "Late Night come from your own late-night listening.",
            },
            {
                kind: "note",
                key: "discover.only",
                title: "Discover keeps to itself",
                summary: "Weekly suggestions show and play only there now, and your own albums no longer get mixed in.",
                body:
                    "Albums from Discover Weekly are for trying out, so they now show and play only on that page: not in " +
                    "your collection, radio, mixes, search or the vibe map. Like a song and its whole album joins your " +
                    "library.\n\n" +
                    "Kima also stopped mistaking albums you got yourself for suggestions, and Discover now deletes an album only " +
                    "when its own records show it fetched that album and nobody has made it theirs.",
                links: [{ label: "Open Discover", href: "/discover" }],
            },
            {
                kind: "note",
                key: "panel.redesign",
                title: "A new side panel",
                summary: "The right-hand panel has two tabs: what's playing and up next, and everything Kima is doing. The queue lives there now.",
                body:
                    "The right-hand panel is two tabs, each with the whole panel. Listening, where it opens unless something asks for activity, shows the " +
                    "song that's playing, then what's up next, its lyrics or its artist. Activity shows everything Kima is " +
                    "doing in one list, newest first, or just alerts, downloads, imports or history; the bell opens it, and " +
                    "its tab carries the count of unread notices and running downloads. The queue page is gone: the panel's " +
                    "up next list moves, removes and clears songs.\n\n" +
                    "The sidebar's mixes show their covers, and the release radar, new and upcoming albums from artists " +
                    "you follow, has a place in the sidebar. Both panels slide open and closed smoothly, and covers are " +
                    "one size across pages.",
            },
            {
                kind: "note",
                key: "podcasts.browse",
                title: "Podcasts, browsed properly",
                summary:
                    "Apple Podcasts' charts and categories, the newest episode from each of your shows, and a first-episode sample before you follow.",
                body:
                    "The podcasts page works like a podcast app now. It starts with what you're partway through and the newest episode from each show you follow, then rows from the categories your shows are in, the top charts, and a row for every other category, from Arts to True Crime, to scroll through. Discovery comes from Apple Podcasts' charts and categories instead of keyword searches, and search finds episodes of your shows as well as new shows.\n\nA show you haven't followed opens with its description, categories and latest episodes, and you can play its first episode (usually the one where the hosts explain the show) before deciding.\n\nEpisode lengths are measured from the audio itself, so the clock no longer stops short on episodes with ads stitched in. Operators pick the chart country in Settings → Podcasts.",
                links: [{ label: "Open podcasts", href: "/podcasts" }],
            },
            {
                kind: "note",
                key: "analysis.middle",
                title: "Analysis listens to the middle of each song",
                summary: "Tempo, key, energy and feel come from the middle 90 seconds instead of the last 90.",
                body:
                    "Audio analysis used to read each song's last 90 seconds, so a fade-out or a silent tail could stand in " +
                    "for the whole song. It now reads the middle 90 seconds. Tempo, key, energy, danceability and part of " +
                    "each song's feel come from this reading. Song matching and moods don't depend on it: they listen " +
                    "across the whole song.\n\n" +
                    "Songs analysed by an earlier version are analysed again in the background after the update, so every song " +
                    "gets the new reading.",
                links: [{ label: "Open library settings", href: "/settings/library" }],
            },
            {
                kind: "note",
                key: "enrichment.rerun",
                title: "Re-run from any step",
                summary: "Pick which enrichment step to redo; the vibe map is laid out fresh each time.",
                body:
                    "Settings let you re-run enrichment from whichever step you choose: identification, artists, audio " +
                    "analysis, sound vectors, moods, or similarity and the map. Each clears only itself and what depends on " +
                    "it, and every re-run lays out a fresh vibe map. The full wipe is still there too.",
                links: [{ label: "Open library settings", href: "/settings/library" }],
            },
            {
                kind: "note",
                key: "updates.pings",
                title: "Update pings",
                summary:
                    "An amber dot on the version number when a newer release is found.",
                body:
                    "Kima checks GitHub for newer releases once every 24 hours. An amber dot appears by the version number when a release is found, and tapping the version opens its What's New window. This can be turned off in Settings → Storage.",
            },
            {
                kind: "note",
                key: "fixes.12",
                title: "Fixes, security and small improvements",
                summary:
                    "Two critical Next.js fixes and Node's Brotli fix, operator-only downloads, reverse playlist order, previews that play again, and more.",
                body:
                    "- Security: Next.js 16.4.1 closes two critical holes that let anyone, signed in or not, run code on the server (image optimisation and the cache); Node 24.22.1 closes the Brotli decompression flaw known as Node2Shell; DOMPurify, body-parser, multer, follow-redirects, undici and zod are updated; three high-severity flaws in the CLAP stack's model loading are closed\n" +
                    "- Feeds and links that redirect are checked at every step, so none can point Kima at your own network\n" +
                    "- Only operators can start downloads unless they turn on Member Downloads in Settings → Sources → Downloads; a member's playlist import no longer downloads either\n" +
                    "- Signing out clears what the app remembered, so the next person on that screen sees only their own\n" +
                    "- Search only finds the shows you follow; it used to list shows other people follow\n" +
                    "- Playlists can play in reverse order: a toggle beside shuffle, remembered per playlist\n" +
                    "- Playlists stay current on all your open devices, and quick edits no longer undo each other on screen\n" +
                    "- Song previews play again, and artist photos and related artists come from the right artist\n" +
                    "- Untagged albums are identified from their songs' audio fingerprints, so they get real covers and MusicBrainz ids\n" +
                    "- An album is filed under the artist its songs name together: one song tagged with a guest no longer splits off under that guest, and a tag naming two artists is no longer glued into one made-up artist, and a credit like Michael Jackson & The Jackson 5 goes under Michael Jackson when he is already in your library and MusicBrainz is sure the pair is not an artist of its own\n" +
                    "- Artist and album pages no longer show a stray 0, and an artist's top songs list each title once\n" +
                    "- Favorites, discovery and Deep Cuts count only your own plays; recently added and recently listened leave out Various Artists and Unknown Artist\n" +
                    "- Mixes offer only songs that can play, and night mixes keep their two-songs-per-artist cap\n" +
                    "- Identification asks AcoustID first, and a fingerprint it refuses no longer holds up its album\n" +
                    "- Delete for an artist or album is on its own page, for admins, not on every card of the collection\n" +
                    "- The phone layout no longer slides under the top bar when the browser's toolbar moves\n" +
                    "- Covers are sharp on high-density screens, card grids fill the row, home shows each row as it loads, and the collection's mood band loads without the whole vibe map\n" +
                    "- Artists have their own colour (amber now marks only what you can press), the settings menu marks the section you picked, and search, stats and Discover use plainer words\n" +
                    "- The container's health check covers the whole stack: web app, backend with its database and Redis, and the analyzers this server runs\n" +
                    "- Your library follows your disk: a song whose file two scans in a row can't find is removed, and logged first; if a whole drive drops out, nothing is removed\n" +
                    "- Every release's note stays on the changelog page, newest first; anything a release still needs from you stays listed there until it's done\n" +
                    "- When a podcast episode ends, the show's next episode plays; an episode you've heard 95% of counts as finished, and a finished one stays finished\n" +
                    "- The collection's Refine panel fits the screen at every size\n" +
                    "- Settings is five pages: you, and for admins library, sources, server and people; re-filing albums is a button that stays\n" +
                    "- Touch screens: controls that appear on hover now show on tap too\n" +
                    "- TV mode: Back works on every page, including the Fire TV remote's Back button\n" +
                    "- Audio analysis and sound vectors take turns by default; an admin can let them run at once in Settings, under Library\n" +
                    "- Subsonic apps that search with search2 or an empty search3 get results again\n" +
                    "- An ordered play queue for iOS that doesn't drag the full artist payload",
            },
        ],
    },

    {
        version: "1.11.0",
        title: "Kima 1.11",
        summary:
            "Songs match on sound, feel and genre, there's a new vibe map, the enrichment engine is rebuilt, and Last.fm is gone.",
        date: "2026-10-12",
        note: { from: "Kevin", body: KEVIN_1_11 },
        items: [
            {
                kind: "action",
                key: "engine.wipe",
                title: "Wipe and re-run enrichment",
                summary: "The engine is new, so it needs one fresh run. Only its own data is wiped.",
                body:
                    "Everything Kima worked out about your music came from the old engine. Wiping clears it (audio " +
                    "analysis, vibe data, the vibe map, artist bios and similar artists) and runs your whole library " +
                    "through the new one.\n\n" +
                    "Your music, playlists, plays, likes and edits stay. It runs in the background and takes a few " +
                    "hours on a big library. The vibe map comes back when it's done.",
                cta: "Wipe and re-run",
                run: "wipeEnrichment",
                confirmTitle: "Wipe and re-run enrichment?",
                confirmMessage: WIPE_MESSAGE,
                confirmLabel: "Wipe and re-run",
                ifClosed: "If you close now, nothing is wiped. It's also in Settings, under Library Enrichment.",
                links: [{ label: "See progress in Settings", href: "/settings#cache" }],
                requires: "admin",
                olderLibraryOnly: true,
            },
            {
                kind: "note",
                key: "vibe.engine",
                title: "The new vibe engine",
                summary: "Songs now match on how they sound, how they feel, and their artist's genres.",
                body:
                    "Kima used to match songs on sound alone. Now every match weighs three things: how the song " +
                    "sounds, how it feels (calm or intense, bright or dark, compared with the rest of your library), " +
                    "and its artist's genres, which only count between different artists.\n\n" +
                    "Similar tracks, Song Path, Blend and recommendations all use it, and no list has more than 2 " +
                    "songs from one album or 4 from one artist. Searching by words still matches on sound, because a " +
                    "sentence has no feel or genre.\n\n" +
                    "Every weight was tested against how people judge music before it went in.",
                links: [{ label: "Open the vibe map", href: "/vibe" }],
            },
            {
                kind: "note",
                key: "vibe.map",
                title: "The new vibe map",
                summary: "Your library laid out by the vibe engine. It's yours, and it doesn't shuffle around.",
                body:
                    "Every song sits where the vibe engine puts it, so songs that match sit together. A very faint glow " +
                    "sits behind the whole map, and a few far-off stars give it depth.\n\n" +
                    "Your map is laid out once, after your library has been through enrichment. New songs are placed " +
                    "among the others and keep their place; a wipe and re-run lays the whole map out fresh.",
                links: [{ label: "Open the vibe map", href: "/vibe" }],
            },
            {
                kind: "note",
                key: "engine.rebuilt",
                title: "A rebuilt enrichment engine",
                summary: "Better identification, no made-up numbers, and a lighter analyzer.",
                body:
                    "Songs are identified by their tags and file names first, checked against the music you actually " +
                    "own. Audio fingerprinting only handles what that can't settle.\n\n" +
                    "The analyzers only report what they actually measured. Anything they couldn't work out stays " +
                    "empty instead of being guessed.\n\n" +
                    "Everything runs on ONNX Runtime now: the sound vectors and the audio analysis both. No PyTorch " +
                    "anywhere. It's lighter, and a switch in Settings moves the heavy work onto an NVIDIA card when " +
                    "Kima can see one. The whole engine builds and runs natively on x86 and ARM, so Apple-silicon " +
                    "Macs get the full analysis, not a reduced one.",
            },
            {
                kind: "note",
                key: "moods.fixed",
                title: "Moods, fixed",
                summary: "Some moods were read backwards. That's fixed, and there are five moods now.",
                body:
                    "Calm songs could end up in Intense and sad ones in Upbeat. That's fixed.\n\n" +
                    "There are five moods now: Upbeat, Melancholic, Calm, Intense and Energetic. Acoustic and " +
                    "electronic aren't moods any more; they measured the same thing twice and drowned out the rest. " +
                    "Energy no longer bunches up at the top, where about a third of a library used to read as " +
                    "maximum energy.",
            },
            {
                kind: "action",
                key: "moods.mixes",
                title: "Your mood mix",
                summary: "It was picked from the old moods. Rebuild it, keep it, or save it as a playlist.",
                body:
                    "Your saved mood mix was picked using the old, wrong moods. Rebuild clears it so you can make a " +
                    "fresh one in the Mood Mixer on the home page. Keep leaves it as it is.\n\n" +
                    "Want its songs either way? Save it as a playlist first.",
                cta: "Rebuild",
                ifClosed: "If you close now, your mood mix stays as it is.",
                requires: "savedMoodMix",
            },
            {
                kind: "action",
                key: "moods.mixes.retired",
                title: "Your old mood mix",
                summary: "Its mood no longer exists. Save it as a playlist or remove it.",
                body:
                    "Your saved mood mix was made under a mood that's gone, so Kima can't show it any more. Its songs " +
                    "are all still in your library.\n\n" +
                    "Save it as a playlist to keep them together, or remove it. Nothing is deleted until you pick.",
                cta: "Save as playlist",
                ifClosed: "If you close now, nothing is deleted, and you'll be asked again next time.",
                requires: "retiredMoodMix",
            },
            {
                kind: "note",
                key: "stats.page",
                title: "Stats",
                summary: "See what you actually listen to. Play counts are in the player too.",
                body:
                    "The Stats page shows what you replay most, which artists make up most of your listening, how " +
                    "much of your library you've never played, over the last 30 days, the last 12 months or all time.\n\n" +
                    "The full player shows how many times you've played the current song.",
                links: [{ label: "Open Stats", href: "/stats" }],
            },
            {
                kind: "note",
                key: "lastfm.gone",
                title: "No accounts, no keys",
                summary: "Last.fm is gone. Nothing to sign up for or set up.",
                body:
                    "Similar artists come from ListenBrainz, with Deezer as a backup. Names come from MusicBrainz, " +
                    "artist bios from Wikidata, and album art from Deezer and the Cover Art Archive. None of it needs " +
                    "an account or an API key.\n\n" +
                    "ListenBrainz is recommended for popularity, never required. If you sign up there and turn on " +
                    "scrobbling, Kima switches your popularity to your ListenBrainz data automatically. Until then, " +
                    "Deezer keeps filling it in.",
            },
            {
                kind: "choice",
                key: GPU_CHOICE_KEY,
                title: "Use an NVIDIA graphics card",
                summary: "Optional. Run the heaviest job on your graphics card; off unless you turn it on.",
                body:
                    "Making vibe data is the heaviest job Kima runs. If your server runs Linux and has an NVIDIA " +
                    "card that Kima can see, that job can run on the card: about 2 to 3 times faster with your " +
                    "worker slider up, and your processor stays free for everything else.\n\n" +
                    "It's safe to turn on partway through a run. You can change it any time in Settings, under " +
                    "Library Enrichment.",
                discloses:
                    "Kima downloads twelve pinned packages (about 2 GB) from PyPI, checks every file against a fixed " +
                    "fingerprint, and installs them in your data folder, where they take about 3.4 GB. Nothing about " +
                    "your library leaves your server.",
                defaultValue: false,
                requires: "admin",
            },
        ],
    },
    {
        version: "1.10.1",
        title: "What counts as a play",
        summary:
            "Play counts now track what you've listened to, not what started loading. There's a one-off cleanup for the counts you've already got.",
        date: "2026-08-25",
        items: [
            {
                kind: "note",
                key: "plays.rule",
                title: "A play means you listened",
                summary: "A song counts once you've heard half of it, or 4 minutes of it.",
                body:
                    "A play used to be logged the moment a song started loading, so skipping through an album counted " +
                    "every song. Now a song counts once you've heard half of it or 4 minutes of it, whichever is " +
                    "less, the same rule Last.fm and ListenBrainz use. Songs 30 seconds or shorter never count.",
            },
            {
                kind: "note",
                key: "plays.repair",
                title: "Clean up old play counts",
                summary: "Find the skips that were counted as plays, and remove them.",
                body:
                    "Your old counts still include those skips. A tool on the Stats page finds plays that were followed " +
                    "seconds later by another play, shows you each one, and lets you remove them or keep them.\n\n" +
                    "It only removes what it can show was a skip, and it never touches your music files.",
                links: [{ label: "Open the cleanup", href: "/stats#false-starts" }],
            },
        ],
    },
];

/** The release a given version belongs to, if the window has anything to say. */
export function findRelease(version: string): Release | undefined {
    return RELEASES.find((r) => r.version === version);
}

/** Whether an item is the mood-mix question, for a saved mix or for one under a removed mood. */
export function isMoodMixItem(item: ReleaseItem): boolean {
    return item.kind === "action" && (item.requires === "savedMoodMix" || item.requires === "retiredMoodMix");
}

/** Every choice a release asks, flattened — used to resolve a dismissal. */
export function choicesIn(
    release: Release,
): Array<{ key: string; defaultValue: boolean; requires?: "admin" }> {
    return release.items
        .filter((i): i is Extract<ReleaseItem, { kind: "choice" }> => i.kind === "choice")
        .map((i) => ({ key: i.key, defaultValue: i.defaultValue, requires: i.requires }));
}

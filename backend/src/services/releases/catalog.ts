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
    | (ItemBase & { kind: "note" })
    | (ItemBase & {
          kind: "action";
          /** The label on the button that runs it. */
          cta: string;
          /** Something the window runs itself, behind a confirm. */
          run?: "wipeEnrichment";
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
            "Per-step enrichment reruns, update pings, and fixes.",
        date: "2026-10-13",
        items: [
            {
                kind: "note",
                key: "enrichment.rerun",
                title: "Rerun from any step",
                summary:
                    "Pick which enrichment step to redo; a fresh vibe map comes with each rerun.",
                body:
                    "Settings now let you re-run enrichment from whichever step you choose — start over on audio analysis, or just re-build the vibe map without repeating identification or artists. Each rerun produces a fresh map layout.\n\nThe full wipe is still there too.",
                links: [{ label: "Open Library Enrichment settings", href: "/settings#cache" }],
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
                title: "Fixes and small improvements",
                summary:
                    "Operator-only downloads, reverse playlist order, touch-screen controls, preview streams everywhere, a right-sized play queue for iOS, and security fixes.",
                body:
                    "- Only operators can start downloads unless they turn on Member Downloads in Settings → Download Preferences; deleting stays operator-only\n- Playlists can play in reverse order: a toggle beside shuffle, remembered per playlist\n- Every release's note now stays on the changelog page, newest first; anything a release still needs from you stays listed there until it's done\n- Opt-in for operators: Kima can remove songs whose files are gone once two scans in a row confirm it, logging each one first (server setting RECONCILE_MODE=delete)\n- Touch screens (artist and album pages): reveal-on-hover controls now show on tap too\n- Preview streams play on every client (the range headers were missing)\n- The release window says \"What's new\" everywhere, not \"Kevin's note\" on wide screens\n- An ordered play queue for iOS that doesn't drag the full artist payload\n- The collection page hides delete buttons from non-admins\n- Three HIGH-severity CVEs closed in the CLAP stack (transformers model-loading path)\n- Empty Subsonic search3 queries return the library instead of nothing, so apps that sync this way see your whole library",
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

/** Every choice a release asks, flattened — used to resolve a dismissal. */
export function choicesIn(
    release: Release,
): Array<{ key: string; defaultValue: boolean; requires?: "admin" }> {
    return release.items
        .filter((i): i is Extract<ReleaseItem, { kind: "choice" }> => i.kind === "choice")
        .map((i) => ({ key: i.key, defaultValue: i.defaultValue, requires: i.requires }));
}

/**
 * A joint credit with no MusicBrainz ids ("Michael Jackson & The Jackson 5") is filed under a leading part of its name
 * when two things hold: that part is already an artist in the library, and MusicBrainz knows no artist by the full
 * joint name. "Simon & Garfunkel" stays whole because MusicBrainz knows it as one artist, however an artist named
 * "Simon" came to be in the library. This is the one rule the scanner and the re-file both ask; neither keeps an album
 * under a leading artist on any other ground. With several separators ("A & B and C") the longest leading part that is
 * a library artist ("A & B", then "A") is the lead.
 *
 * A run (one scan, one re-file) asks MusicBrainz at most once per distinct name, however spelled ("A & B", "A and
 * B", "A + B", any case), and once MusicBrainz fails to answer it is not asked again for the rest of the run: a slow
 * or dead MusicBrainz must not hold a scan for ten seconds a song. A name MusicBrainz could not answer about, or
 * answered with more artists than it returned and none exactly the name, is "unknown"; callers leave its albums where
 * they are. "None found" is only ever MusicBrainz saying it has no artist of that name.
 */
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { isPlaceholderArtistName } from "../utils/artistNormalization";
import { JOINT_CREDIT, type ArtistCandidate } from "./albumArtistVote";
import { artistIdentityKey, normalizeArtistName } from "./artistIdentity";
import { musicBrainzService } from "./musicbrainz";

/** The artists a MusicBrainz search returns per question. */
const SEARCH_LIMIT = 25;

/** "A + B" is "A & B": the key of a name with every joining sign the same. */
const jointKey = (name: string) => artistIdentityKey(name.replace(/\+/g, " & "));

/**
 * The leading parts of a joint credit, longest first: "A & B and C" gives "A & B" and "A". A part that is a
 * placeholder name (Unknown Artist, Various Artists) is never a lead.
 */
export function leadingParts(name: string): string[] {
    const whole = artistIdentityKey(name);
    const separator = new RegExp(JOINT_CREDIT.source, "gi");
    const parts: string[] = [];
    for (let match = separator.exec(name); match; match = separator.exec(name)) {
        if (match[0].length === 0) separator.lastIndex++;
        const part = name.slice(0, match.index).trim();
        const key = artistIdentityKey(part);
        if (part && key && key !== whole && !isPlaceholderArtistName(part) && !parts.includes(part)) parts.push(part);
    }
    return parts.reverse();
}

/** The first artist a joint credit names, or null when the credit is a single name. */
export function firstOfJointCredit(name: string): string | null {
    const parts = leadingParts(name);
    return parts.length ? parts[parts.length - 1] : null;
}

/**
 * The one question MusicBrainz is asked about a name: its exact phrase on artist and alias, in each spelling of the
 * joining word ("a & b", "a and b", "a + b"). Built from the name's letters and digits alone, so every spelling and case
 * of a name is the same question and shares one cached reply.
 */
export function exactNameQuery(name: string): string {
    // MusicBrainz keeps an apostrophe inside a word ("o'connor", "destiny's"), straight or curly, and has no artist
    // "o connor": splitting there would be a false "none found". Accents it folds itself.
    const tokens = normalizeArtistName(name.replace(/\+/g, " & "))
        .replace(/[\u2018\u2019\u02bc]/g, "'")
        .split(/[^\p{L}\p{N}']+/u)
        .map((t) => t.replace(/^'+|'+$/g, ""))
        .filter(Boolean);
    const quoted = (sign: string) => `"${tokens.map((t) => (t === "and" ? sign : t)).join(" ").replace(/[\\"]/g, "\\$&")}"`;
    const phrases = [...new Set(["&", "and", "+"].map(quoted))];
    return ["artist", "alias"].flatMap((field) => phrases.map((phrase) => `${field}:${phrase}`)).join(" OR ");
}

export type JointFiling =
    /** Filed under the lead's library row (`candidate`), or by the name as the files give it. */
    | { status: "split" | "whole"; candidate: ArtistCandidate }
    /** MusicBrainz could not say; the files' name is `candidate`, and albums already filed stay where they are. */
    | { status: "unknown"; candidate: ArtistCandidate };

/** The library artist a name is, or null: the filer asks the database unless handed another way to look. */
export type LibraryLookup = (name: string) => Promise<{ name: string; mbid: string | null } | null>;

const libraryArtist: LibraryLookup = (name) =>
    prisma.artist.findUnique({ where: { identityKey: artistIdentityKey(name) }, select: { name: true, mbid: true } });

export class JointCreditFiler {
    /** Whether MusicBrainz knows each name, by `jointKey`; null when it could not say. */
    private known = new Map<string, Promise<boolean | null>>();
    private unreachable = false;

    constructor(private readonly lookup: LibraryLookup = libraryArtist) {}

    /**
     * Whether MusicBrainz has an artist whose name or alias is exactly `name` (letters, accents, case and "&" "and"
     * "+" ignored), or null when it could not say. The client caches what it answered (30 days; none found, 7); a
     * failure is not cached, so it is remembered here for the run.
     */
    private knows(name: string): Promise<boolean | null> {
        const key = jointKey(name);
        let answer = this.known.get(key);
        if (!answer) {
            answer = this.ask(name, key);
            this.known.set(key, answer);
        }
        return answer;
    }

    private async ask(name: string, key: string): Promise<boolean | null> {
        if (this.unreachable || !key) return null;
        let found;
        try {
            found = await musicBrainzService.searchArtist(exactNameQuery(name), SEARCH_LIMIT);
        } catch (error) {
            return this.fail("threw", error);
        }
        if (found.kind === "absent") return false;
        if (found.kind !== "answered") return this.fail(found.kind);
        const hits = found.value as Array<{ name?: string; aliases?: Array<{ name?: string }> }>;
        const exact = hits.some((hit) =>
            [hit.name, ...(hit.aliases ?? []).map((alias) => alias.name)].some((n) => typeof n === "string" && jointKey(n) === key),
        );
        if (exact) return true;
        // MusicBrainz has more artists for the question than it returned, and the one asked about may be among the rest.
        const total = Number((found.evidence as { count?: unknown }).count);
        if (Number.isFinite(total) && total > hits.length) {
            logger.debug(`[JointCredit] MusicBrainz has ${total} artists for "${name}" and returned ${hits.length}; the name stays where it is`);
            return null;
        }
        return false;
    }

    private fail(reason: string, error?: unknown): null {
        this.unreachable = true;
        logger.warn(`[JointCredit] MusicBrainz did not answer (${reason}); joint credits stay where they are until it does`, error ?? "");
        return null;
    }

    /**
     * Where a candidate is filed. A candidate with a MusicBrainz id, a single name, or no leading part the library has
     * is whole, with no question asked.
     */
    async file(candidate: ArtistCandidate): Promise<JointFiling> {
        if (candidate.mbid) return { status: "whole", candidate };
        let lead: { name: string; mbid: string | null } | null = null;
        for (const part of leadingParts(candidate.name)) {
            lead = await this.lookup(part);
            if (lead) break;
        }
        if (!lead) return { status: "whole", candidate };
        const known = await this.knows(candidate.name);
        if (known === null) return { status: "unknown", candidate };
        if (known) return { status: "whole", candidate };
        return { status: "split", candidate: lead.mbid ? { name: lead.name, mbid: lead.mbid } : { name: lead.name } };
    }
}

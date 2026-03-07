// backend/src/data/featureProfiles.ts

/**
 * Research-based audio feature profiles for genres, moods, and vibes.
 * Values are target ranges (0-1) based on academic literature on music information retrieval.
 *
 * Sources:
 * - Tzanetakis & Cook (2002) - Musical genre classification
 * - Laurier et al. (2008) - Audio music mood classification
 * - Spotify Audio Features documentation
 */

export interface FeatureProfile {
    energy?: number;
    valence?: number;
    danceability?: number;
    acousticness?: number;
    instrumentalness?: number;
    arousal?: number;
}

export type TermType = "genre" | "subgenre" | "mood" | "vibe" | "descriptor" | "instrumentation" | "production" | "context" | "era" | "vocal";

export interface VocabTermDefinition {
    type: TermType;
    featureProfile: FeatureProfile;
    related?: string[];
}

export const VOCAB_DEFINITIONS: Record<string, VocabTermDefinition> = {
    // === GENRES ===
    electronic: {
        type: "genre",
        featureProfile: { instrumentalness: 0.7, acousticness: 0.15, danceability: 0.7, energy: 0.65 },
        related: ["synth", "edm", "techno", "house", "trance"]
    },
    techno: {
        type: "genre",
        featureProfile: { instrumentalness: 0.85, acousticness: 0.1, danceability: 0.8, energy: 0.75 },
        related: ["electronic", "house", "minimal"]
    },
    house: {
        type: "genre",
        featureProfile: { instrumentalness: 0.6, acousticness: 0.1, danceability: 0.85, energy: 0.7 },
        related: ["electronic", "disco", "dance"]
    },
    trance: {
        type: "genre",
        featureProfile: { instrumentalness: 0.8, acousticness: 0.1, danceability: 0.75, energy: 0.7, arousal: 0.65 },
        related: ["electronic", "edm"]
    },
    ambient: {
        type: "genre",
        featureProfile: { instrumentalness: 0.9, acousticness: 0.4, energy: 0.2, arousal: 0.2, danceability: 0.15 },
        related: ["electronic", "atmospheric", "chill"]
    },
    trap: {
        type: "genre",
        featureProfile: { instrumentalness: 0.3, acousticness: 0.1, danceability: 0.7, energy: 0.7 },
        related: ["hip-hop", "rap", "electronic"]
    },
    "hip-hop": {
        type: "genre",
        featureProfile: { instrumentalness: 0.2, acousticness: 0.15, danceability: 0.75 },
        related: ["rap", "trap", "r&b"]
    },
    rock: {
        type: "genre",
        featureProfile: { instrumentalness: 0.3, acousticness: 0.25, energy: 0.75, danceability: 0.5 },
        related: ["alternative", "indie", "punk"]
    },
    metal: {
        type: "genre",
        featureProfile: { instrumentalness: 0.4, acousticness: 0.05, energy: 0.95, arousal: 0.9, valence: 0.3 },
        related: ["heavy", "hard rock"]
    },
    punk: {
        type: "genre",
        featureProfile: { instrumentalness: 0.2, acousticness: 0.2, energy: 0.9, danceability: 0.5, valence: 0.5 },
        related: ["rock", "alternative"]
    },
    jazz: {
        type: "genre",
        featureProfile: { instrumentalness: 0.6, acousticness: 0.7, danceability: 0.5, energy: 0.4 },
        related: ["blues", "soul", "swing"]
    },
    blues: {
        type: "genre",
        featureProfile: { instrumentalness: 0.4, acousticness: 0.65, valence: 0.35, energy: 0.45 },
        related: ["jazz", "soul", "rock"]
    },
    classical: {
        type: "genre",
        featureProfile: { instrumentalness: 0.95, acousticness: 0.9, danceability: 0.25 },
        related: ["orchestral", "piano", "instrumental"]
    },
    folk: {
        type: "genre",
        featureProfile: { instrumentalness: 0.3, acousticness: 0.85, energy: 0.35, danceability: 0.4 },
        related: ["acoustic", "country", "indie"]
    },
    country: {
        type: "genre",
        featureProfile: { instrumentalness: 0.25, acousticness: 0.6, valence: 0.6, danceability: 0.55 },
        related: ["folk", "americana"]
    },
    "r&b": {
        type: "genre",
        featureProfile: { instrumentalness: 0.2, acousticness: 0.3, danceability: 0.7, valence: 0.55 },
        related: ["soul", "hip-hop", "funk"]
    },
    soul: {
        type: "genre",
        featureProfile: { instrumentalness: 0.25, acousticness: 0.45, valence: 0.5, energy: 0.5 },
        related: ["r&b", "funk", "gospel"]
    },
    funk: {
        type: "genre",
        featureProfile: { instrumentalness: 0.35, acousticness: 0.3, danceability: 0.85, energy: 0.7 },
        related: ["soul", "disco", "groove"]
    },
    disco: {
        type: "genre",
        featureProfile: { instrumentalness: 0.3, acousticness: 0.2, danceability: 0.9, energy: 0.75, valence: 0.8 },
        related: ["funk", "house", "dance"]
    },
    pop: {
        type: "genre",
        featureProfile: { instrumentalness: 0.15, acousticness: 0.3, danceability: 0.7, valence: 0.65 },
        related: ["dance", "synth"]
    },
    indie: {
        type: "genre",
        featureProfile: { instrumentalness: 0.35, acousticness: 0.5, energy: 0.55, danceability: 0.5 },
        related: ["alternative", "rock", "folk"]
    },
    alternative: {
        type: "genre",
        featureProfile: { instrumentalness: 0.3, acousticness: 0.4, energy: 0.6, danceability: 0.5 },
        related: ["indie", "rock"]
    },
    reggae: {
        type: "genre",
        featureProfile: { instrumentalness: 0.3, acousticness: 0.4, danceability: 0.75, valence: 0.65, energy: 0.5 },
        related: ["dub", "ska"]
    },
    dubstep: {
        type: "genre",
        featureProfile: { instrumentalness: 0.6, acousticness: 0.05, energy: 0.85, danceability: 0.65 },
        related: ["electronic", "bass"]
    },
    dnb: {
        type: "genre",
        featureProfile: { instrumentalness: 0.7, acousticness: 0.05, energy: 0.9, danceability: 0.7 },
        related: ["electronic", "jungle", "bass"]
    },
    lofi: {
        type: "genre",
        featureProfile: { instrumentalness: 0.7, acousticness: 0.4, energy: 0.3, arousal: 0.3, danceability: 0.4 },
        related: ["chill", "hip-hop", "ambient"]
    },

    // === MOODS ===
    happy: {
        type: "mood",
        featureProfile: { valence: 0.85, energy: 0.7, arousal: 0.6, danceability: 0.7 },
        related: ["upbeat", "cheerful", "joyful"]
    },
    sad: {
        type: "mood",
        featureProfile: { valence: 0.2, energy: 0.3, arousal: 0.3, danceability: 0.3 },
        related: ["melancholic", "somber", "blue"]
    },
    melancholic: {
        type: "mood",
        featureProfile: { valence: 0.25, energy: 0.35, arousal: 0.4, acousticness: 0.5 },
        related: ["sad", "nostalgic", "bittersweet"]
    },
    angry: {
        type: "mood",
        featureProfile: { valence: 0.25, energy: 0.9, arousal: 0.9 },
        related: ["aggressive", "intense", "heavy"]
    },
    aggressive: {
        type: "mood",
        featureProfile: { valence: 0.3, energy: 0.9, arousal: 0.85 },
        related: ["angry", "intense", "heavy"]
    },
    peaceful: {
        type: "mood",
        featureProfile: { valence: 0.6, energy: 0.2, arousal: 0.2, acousticness: 0.6 },
        related: ["calm", "serene", "tranquil"]
    },
    calm: {
        type: "mood",
        featureProfile: { energy: 0.25, arousal: 0.25, valence: 0.55 },
        related: ["peaceful", "relaxed", "serene"]
    },
    anxious: {
        type: "mood",
        featureProfile: { valence: 0.3, arousal: 0.75, energy: 0.6 },
        related: ["tense", "nervous"]
    },
    romantic: {
        type: "mood",
        featureProfile: { valence: 0.6, energy: 0.4, acousticness: 0.5, arousal: 0.45 },
        related: ["love", "intimate", "sensual"]
    },
    hopeful: {
        type: "mood",
        featureProfile: { valence: 0.7, energy: 0.55, arousal: 0.5 },
        related: ["uplifting", "optimistic", "bright"]
    },
    nostalgic: {
        type: "mood",
        featureProfile: { valence: 0.45, energy: 0.4, arousal: 0.4 },
        related: ["melancholic", "bittersweet", "wistful"]
    },
    dark: {
        type: "mood",
        featureProfile: { valence: 0.2, energy: 0.5, acousticness: 0.3, arousal: 0.5 },
        related: ["brooding", "ominous", "moody"]
    },
    bright: {
        type: "mood",
        featureProfile: { valence: 0.8, energy: 0.65, arousal: 0.6 },
        related: ["happy", "cheerful", "sunny"]
    },

    // === VIBES ===
    chill: {
        type: "vibe",
        featureProfile: { energy: 0.3, arousal: 0.3, valence: 0.55, danceability: 0.45 },
        related: ["relaxed", "mellow", "laid-back"]
    },
    relaxed: {
        type: "vibe",
        featureProfile: { energy: 0.25, arousal: 0.25, valence: 0.5 },
        related: ["chill", "calm", "peaceful"]
    },
    energetic: {
        type: "vibe",
        featureProfile: { energy: 0.85, arousal: 0.8, danceability: 0.75 },
        related: ["upbeat", "powerful", "driving"]
    },
    upbeat: {
        type: "vibe",
        featureProfile: { energy: 0.75, valence: 0.75, danceability: 0.7 },
        related: ["energetic", "happy", "cheerful"]
    },
    groovy: {
        type: "vibe",
        featureProfile: { danceability: 0.85, energy: 0.65, valence: 0.6 },
        related: ["funky", "rhythmic", "danceable"]
    },
    dreamy: {
        type: "vibe",
        featureProfile: { energy: 0.35, arousal: 0.35, acousticness: 0.5, instrumentalness: 0.5 },
        related: ["ethereal", "atmospheric", "ambient"]
    },
    ethereal: {
        type: "vibe",
        featureProfile: { energy: 0.3, instrumentalness: 0.6, acousticness: 0.45, arousal: 0.35 },
        related: ["dreamy", "atmospheric", "ambient"]
    },
    atmospheric: {
        type: "vibe",
        featureProfile: { instrumentalness: 0.7, energy: 0.4, acousticness: 0.4 },
        related: ["ambient", "ethereal", "cinematic"]
    },
    intense: {
        type: "vibe",
        featureProfile: { energy: 0.85, arousal: 0.85, valence: 0.4 },
        related: ["powerful", "aggressive", "dramatic"]
    },
    playful: {
        type: "vibe",
        featureProfile: { valence: 0.75, energy: 0.65, danceability: 0.7 },
        related: ["fun", "quirky", "whimsical"]
    },
    brooding: {
        type: "vibe",
        featureProfile: { valence: 0.25, energy: 0.45, arousal: 0.5 },
        related: ["dark", "moody", "introspective"]
    },
    cinematic: {
        type: "vibe",
        featureProfile: { instrumentalness: 0.8, energy: 0.5, acousticness: 0.5 },
        related: ["epic", "dramatic", "orchestral"]
    },
    epic: {
        type: "vibe",
        featureProfile: { energy: 0.75, arousal: 0.7, instrumentalness: 0.6 },
        related: ["cinematic", "dramatic", "powerful"]
    },
    mellow: {
        type: "vibe",
        featureProfile: { energy: 0.3, arousal: 0.3, valence: 0.5, acousticness: 0.5 },
        related: ["chill", "relaxed", "soft"]
    },
    funky: {
        type: "vibe",
        featureProfile: { danceability: 0.85, energy: 0.7, valence: 0.65 },
        related: ["groovy", "rhythmic"]
    },
    hypnotic: {
        type: "vibe",
        featureProfile: { instrumentalness: 0.7, danceability: 0.6, energy: 0.5, arousal: 0.5 },
        related: ["trance", "repetitive", "mesmerizing"]
    },

    // === DESCRIPTORS ===
    fast: {
        type: "descriptor",
        featureProfile: { energy: 0.8, danceability: 0.7 },
        related: ["energetic", "upbeat"]
    },
    slow: {
        type: "descriptor",
        featureProfile: { energy: 0.3, danceability: 0.35 },
        related: ["chill", "relaxed"]
    },
    heavy: {
        type: "descriptor",
        featureProfile: { energy: 0.85, acousticness: 0.15 },
        related: ["intense", "aggressive", "metal"]
    },
    soft: {
        type: "descriptor",
        featureProfile: { energy: 0.25, acousticness: 0.6 },
        related: ["gentle", "quiet", "mellow"]
    },
    loud: {
        type: "descriptor",
        featureProfile: { energy: 0.85 },
        related: ["intense", "powerful"]
    },
    acoustic: {
        type: "descriptor",
        featureProfile: { acousticness: 0.9, instrumentalness: 0.4 },
        related: ["unplugged", "folk"]
    },
    vocal: {
        type: "descriptor",
        featureProfile: { instrumentalness: 0.1 },
        related: ["singing", "lyrics"]
    },
    instrumental: {
        type: "descriptor",
        featureProfile: { instrumentalness: 0.9 },
        related: ["no vocals"]
    },
    danceable: {
        type: "descriptor",
        featureProfile: { danceability: 0.85, energy: 0.7 },
        related: ["groovy", "rhythmic"]
    },
    synth: {
        type: "descriptor",
        featureProfile: { acousticness: 0.1, instrumentalness: 0.5 },
        related: ["electronic", "synthesizer"]
    },
    bass: {
        type: "descriptor",
        featureProfile: { energy: 0.7, acousticness: 0.1 },
        related: ["heavy", "dubstep", "dnb"]
    },
    guitar: {
        type: "descriptor",
        featureProfile: { acousticness: 0.5 },
        related: ["rock", "folk", "blues"]
    },
    piano: {
        type: "descriptor",
        featureProfile: { acousticness: 0.7, instrumentalness: 0.6 },
        related: ["classical", "jazz"]
    },
    orchestral: {
        type: "descriptor",
        featureProfile: { instrumentalness: 0.95, acousticness: 0.85 },
        related: ["classical", "cinematic", "epic"]
    },

    // === SUB-GENRES ===
    shoegaze: { type: "subgenre", featureProfile: { energy: 0.6, acousticness: 0.2, instrumentalness: 0.5, valence: 0.4 }, related: ["dreamy", "ethereal", "reverb-heavy", "alternative"] },
    "post-punk": { type: "subgenre", featureProfile: { energy: 0.65, valence: 0.35, danceability: 0.5, acousticness: 0.2 }, related: ["punk", "dark", "alternative"] },
    "post-rock": { type: "subgenre", featureProfile: { energy: 0.5, instrumentalness: 0.8, acousticness: 0.3, arousal: 0.5 }, related: ["cinematic", "atmospheric", "epic"] },
    synthwave: { type: "subgenre", featureProfile: { energy: 0.65, instrumentalness: 0.7, acousticness: 0.05, danceability: 0.6 }, related: ["electronic", "retro", "synth"] },
    "new wave": { type: "subgenre", featureProfile: { energy: 0.6, danceability: 0.6, acousticness: 0.15, valence: 0.55 }, related: ["pop", "electronic", "punk"] },
    grunge: { type: "subgenre", featureProfile: { energy: 0.75, valence: 0.3, acousticness: 0.2, danceability: 0.35 }, related: ["rock", "alternative", "heavy"] },
    psychedelic: { type: "subgenre", featureProfile: { energy: 0.5, valence: 0.55, acousticness: 0.3, instrumentalness: 0.4 }, related: ["rock", "dreamy", "atmospheric"] },
    "hard rock": { type: "subgenre", featureProfile: { energy: 0.85, valence: 0.5, acousticness: 0.1, danceability: 0.45 }, related: ["rock", "metal", "heavy"] },
    "death metal": { type: "subgenre", featureProfile: { energy: 0.95, valence: 0.2, acousticness: 0.05, instrumentalness: 0.4 }, related: ["metal", "aggressive", "heavy"] },
    "doom metal": { type: "subgenre", featureProfile: { energy: 0.6, valence: 0.15, acousticness: 0.1, danceability: 0.15, arousal: 0.4 }, related: ["metal", "heavy", "slow", "dark"] },
    "smooth jazz": { type: "subgenre", featureProfile: { energy: 0.3, valence: 0.6, acousticness: 0.6, instrumentalness: 0.7, danceability: 0.4 }, related: ["jazz", "relaxed", "mellow"] },
    "deep house": { type: "subgenre", featureProfile: { energy: 0.55, danceability: 0.8, acousticness: 0.05, instrumentalness: 0.7 }, related: ["house", "electronic", "groovy"] },
    "progressive house": { type: "subgenre", featureProfile: { energy: 0.6, danceability: 0.75, acousticness: 0.05, instrumentalness: 0.75 }, related: ["house", "electronic", "trance"] },
    industrial: { type: "subgenre", featureProfile: { energy: 0.85, valence: 0.2, acousticness: 0.05, danceability: 0.5 }, related: ["electronic", "aggressive", "dark"] },
    "trip-hop": { type: "subgenre", featureProfile: { energy: 0.35, valence: 0.4, danceability: 0.5, acousticness: 0.3 }, related: ["electronic", "hip-hop", "atmospheric", "downtempo"] },
    downtempo: { type: "subgenre", featureProfile: { energy: 0.3, danceability: 0.45, instrumentalness: 0.6, acousticness: 0.25 }, related: ["electronic", "chill", "ambient"] },
    "neo-soul": { type: "subgenre", featureProfile: { energy: 0.4, valence: 0.6, danceability: 0.55, acousticness: 0.4 }, related: ["soul", "r&b", "groovy"] },
    gospel: { type: "subgenre", featureProfile: { energy: 0.65, valence: 0.75, acousticness: 0.5 }, related: ["soul", "choir singing", "uplifting"] },
    "bossa nova": { type: "subgenre", featureProfile: { energy: 0.25, valence: 0.6, danceability: 0.5, acousticness: 0.7 }, related: ["jazz", "latin music", "relaxed"] },
    reggaeton: { type: "subgenre", featureProfile: { energy: 0.7, danceability: 0.85, acousticness: 0.1, valence: 0.65 }, related: ["latin music", "hip-hop", "danceable"] },
    drill: { type: "subgenre", featureProfile: { energy: 0.7, valence: 0.25, danceability: 0.6, acousticness: 0.05 }, related: ["hip-hop", "trap", "dark"] },
    grime: { type: "subgenre", featureProfile: { energy: 0.75, danceability: 0.65, acousticness: 0.05 }, related: ["electronic", "hip-hop", "aggressive"] },
    "boom bap": { type: "subgenre", featureProfile: { energy: 0.55, danceability: 0.65, acousticness: 0.15, valence: 0.45 }, related: ["hip-hop", "drums", "groovy"] },
    hardcore: { type: "subgenre", featureProfile: { energy: 0.95, danceability: 0.5, acousticness: 0.05, valence: 0.3 }, related: ["punk", "metal", "aggressive", "fast"] },
    breakbeat: { type: "subgenre", featureProfile: { energy: 0.7, danceability: 0.75, instrumentalness: 0.7, acousticness: 0.05 }, related: ["electronic", "drums", "dnb"] },
    darkwave: { type: "subgenre", featureProfile: { energy: 0.5, valence: 0.2, acousticness: 0.1, danceability: 0.5 }, related: ["electronic", "dark", "synth", "post-punk"] },
    chillwave: { type: "subgenre", featureProfile: { energy: 0.3, valence: 0.55, acousticness: 0.2, danceability: 0.4 }, related: ["electronic", "dreamy", "lofi", "relaxed"] },
    dub: { type: "subgenre", featureProfile: { energy: 0.45, danceability: 0.6, acousticness: 0.2, instrumentalness: 0.6 }, related: ["reggae", "bass", "reverb-heavy"] },
    "garage rock": { type: "subgenre", featureProfile: { energy: 0.8, valence: 0.5, acousticness: 0.15, danceability: 0.5 }, related: ["rock", "punk", "raw"] },
    "progressive rock": { type: "subgenre", featureProfile: { energy: 0.55, instrumentalness: 0.5, acousticness: 0.3, valence: 0.45 }, related: ["rock", "cinematic", "epic"] },
    "classic rock": { type: "subgenre", featureProfile: { energy: 0.7, valence: 0.55, acousticness: 0.25, danceability: 0.45 }, related: ["rock", "guitar", "retro"] },
    "thrash metal": { type: "subgenre", featureProfile: { energy: 0.95, valence: 0.25, acousticness: 0.05, danceability: 0.35 }, related: ["metal", "aggressive", "fast", "heavy"] },
    "minimal techno": { type: "subgenre", featureProfile: { energy: 0.5, danceability: 0.75, instrumentalness: 0.95, acousticness: 0.05 }, related: ["techno", "electronic", "sparse", "hypnotic"] },
    // === CULTURAL / REGIONAL ===
    afrobeat: { type: "genre", featureProfile: { energy: 0.7, danceability: 0.8, acousticness: 0.3, valence: 0.65 }, related: ["drums", "groovy", "percussion"] },
    "latin music": { type: "genre", featureProfile: { energy: 0.65, danceability: 0.8, valence: 0.65, acousticness: 0.35 }, related: ["reggaeton", "bossa nova", "percussion"] },
    "k-pop": { type: "genre", featureProfile: { energy: 0.75, danceability: 0.8, valence: 0.7, acousticness: 0.1 }, related: ["pop", "electronic", "danceable"] },
    flamenco: { type: "genre", featureProfile: { energy: 0.6, acousticness: 0.8, danceability: 0.55, valence: 0.4 }, related: ["acoustic guitar", "percussion", "dramatic"] },
    "middle eastern music": { type: "genre", featureProfile: { energy: 0.5, acousticness: 0.6, valence: 0.4, instrumentalness: 0.5 }, related: ["percussion", "strings"] },
    celtic: { type: "genre", featureProfile: { energy: 0.5, acousticness: 0.75, valence: 0.55, danceability: 0.5 }, related: ["folk", "acoustic", "violin"] },
    caribbean: { type: "genre", featureProfile: { energy: 0.6, danceability: 0.75, valence: 0.7, acousticness: 0.4 }, related: ["reggae", "percussion"] },
    // === INSTRUMENTATION ===
    strings: { type: "instrumentation", featureProfile: { acousticness: 0.8, instrumentalness: 0.7 }, related: ["violin", "cello", "orchestral", "classical"] },
    violin: { type: "instrumentation", featureProfile: { acousticness: 0.8, instrumentalness: 0.6 }, related: ["strings", "classical", "folk"] },
    cello: { type: "instrumentation", featureProfile: { acousticness: 0.8, instrumentalness: 0.7, energy: 0.4 }, related: ["strings", "classical", "cinematic"] },
    saxophone: { type: "instrumentation", featureProfile: { acousticness: 0.6, instrumentalness: 0.5 }, related: ["jazz", "soul", "smooth jazz"] },
    trumpet: { type: "instrumentation", featureProfile: { acousticness: 0.5, energy: 0.6 }, related: ["jazz", "brass", "latin music"] },
    flute: { type: "instrumentation", featureProfile: { acousticness: 0.7, instrumentalness: 0.6, energy: 0.3 }, related: ["classical", "folk", "celtic"] },
    drums: { type: "instrumentation", featureProfile: { energy: 0.7, danceability: 0.65, instrumentalness: 0.6 }, related: ["percussion", "rock", "breakbeat"] },
    "electric guitar": { type: "instrumentation", featureProfile: { energy: 0.7, acousticness: 0.1 }, related: ["rock", "metal", "guitar"] },
    "acoustic guitar": { type: "instrumentation", featureProfile: { acousticness: 0.9, energy: 0.35 }, related: ["folk", "acoustic", "guitar"] },
    organ: { type: "instrumentation", featureProfile: { acousticness: 0.4, instrumentalness: 0.6 }, related: ["gospel", "classical", "rock"] },
    harmonica: { type: "instrumentation", featureProfile: { acousticness: 0.7, energy: 0.4 }, related: ["blues", "folk", "country"] },
    percussion: { type: "instrumentation", featureProfile: { energy: 0.65, danceability: 0.7, instrumentalness: 0.7 }, related: ["drums", "afrobeat", "latin music"] },
    // === PRODUCTION QUALITIES ===
    "reverb-heavy": { type: "production", featureProfile: { acousticness: 0.3, energy: 0.4 }, related: ["shoegaze", "dreamy", "atmospheric"] },
    distorted: { type: "production", featureProfile: { energy: 0.8, acousticness: 0.05 }, related: ["rock", "metal", "heavy"] },
    "clean production": { type: "production", featureProfile: { acousticness: 0.3, energy: 0.5 }, related: ["pop", "polished"] },
    warm: { type: "production", featureProfile: { acousticness: 0.4, energy: 0.4 }, related: ["analog", "vintage", "soft"] },
    raw: { type: "production", featureProfile: { energy: 0.7, acousticness: 0.2 }, related: ["garage rock", "punk", "grunge"] },
    polished: { type: "production", featureProfile: { energy: 0.55 }, related: ["pop", "clean production"] },
    sparse: { type: "production", featureProfile: { energy: 0.25, instrumentalness: 0.6 }, related: ["minimal techno", "ambient", "calm"] },
    layered: { type: "production", featureProfile: { energy: 0.75 }, related: ["orchestral", "epic", "dense"] },
    glitchy: { type: "production", featureProfile: { energy: 0.5, acousticness: 0.05, instrumentalness: 0.7 }, related: ["electronic", "experimental"] },
    // === VOCAL STYLES ===
    rapping: { type: "vocal", featureProfile: { instrumentalness: 0.1, energy: 0.65 }, related: ["hip-hop", "trap", "boom bap"] },
    falsetto: { type: "vocal", featureProfile: { energy: 0.4, valence: 0.5 }, related: ["r&b", "soul", "pop"] },
    "growling vocals": { type: "vocal", featureProfile: { energy: 0.9, instrumentalness: 0.1, valence: 0.15 }, related: ["death metal", "metal", "aggressive"] },
    "a cappella": { type: "vocal", featureProfile: { instrumentalness: 0.0, acousticness: 0.8 }, related: ["choir singing", "vocal"] },
    "choir singing": { type: "vocal", featureProfile: { instrumentalness: 0.2, acousticness: 0.6, energy: 0.55 }, related: ["gospel", "classical", "epic"] },
    "spoken word": { type: "vocal", featureProfile: { instrumentalness: 0.1, energy: 0.25 }, related: ["calm", "acoustic"] },
    autotune: { type: "vocal", featureProfile: { acousticness: 0.05, energy: 0.6 }, related: ["hip-hop", "pop", "trap"] },
    // === USE-CASE / CONTEXT ===
    "workout music": { type: "context", featureProfile: { energy: 0.85, danceability: 0.75, arousal: 0.8, valence: 0.6 }, related: ["energetic", "upbeat", "fast"] },
    "study music": { type: "context", featureProfile: { energy: 0.2, instrumentalness: 0.8, valence: 0.5, arousal: 0.2 }, related: ["calm", "ambient", "lofi"] },
    "sleep music": { type: "context", featureProfile: { energy: 0.1, instrumentalness: 0.9, arousal: 0.1, valence: 0.5 }, related: ["ambient", "calm", "peaceful"] },
    "driving music": { type: "context", featureProfile: { energy: 0.7, danceability: 0.6, arousal: 0.65, valence: 0.55 }, related: ["rock", "energetic", "upbeat"] },
    "meditation music": { type: "context", featureProfile: { energy: 0.1, instrumentalness: 0.95, arousal: 0.1, acousticness: 0.5 }, related: ["ambient", "peaceful", "calm"] },
    "background music": { type: "context", featureProfile: { energy: 0.25, instrumentalness: 0.7, arousal: 0.25 }, related: ["ambient", "lofi", "mellow"] },
    lullaby: { type: "context", featureProfile: { energy: 0.1, valence: 0.55, arousal: 0.1, acousticness: 0.7 }, related: ["calm", "soft", "sleep music"] },
    // === MOOD / VIBE EXPANSION ===
    scary: { type: "mood", featureProfile: { valence: 0.15, arousal: 0.6, energy: 0.5 }, related: ["dark", "eerie", "cinematic"] },
    tender: { type: "mood", featureProfile: { valence: 0.6, arousal: 0.2, energy: 0.2, acousticness: 0.6 }, related: ["soft", "romantic", "gentle"] },
    exciting: { type: "mood", featureProfile: { valence: 0.7, arousal: 0.8, energy: 0.8, danceability: 0.65 }, related: ["energetic", "upbeat", "happy"] },
    triumphant: { type: "mood", featureProfile: { valence: 0.8, arousal: 0.75, energy: 0.75 }, related: ["epic", "uplifting", "cinematic"] },
    mysterious: { type: "mood", featureProfile: { valence: 0.35, arousal: 0.4, energy: 0.35 }, related: ["dark", "atmospheric", "cinematic"] },
    eerie: { type: "mood", featureProfile: { valence: 0.15, arousal: 0.45, energy: 0.3 }, related: ["scary", "dark", "atmospheric"] },
    haunting: { type: "mood", featureProfile: { valence: 0.25, arousal: 0.35, energy: 0.3 }, related: ["ethereal", "atmospheric", "dark"] },
    soothing: { type: "mood", featureProfile: { valence: 0.6, arousal: 0.15, energy: 0.2, acousticness: 0.5 }, related: ["calm", "relaxed", "peaceful"] },
    dramatic: { type: "mood", featureProfile: { arousal: 0.7, energy: 0.65 }, related: ["cinematic", "epic", "orchestral"] },
    bittersweet: { type: "mood", featureProfile: { valence: 0.4, arousal: 0.35, energy: 0.4 }, related: ["melancholic", "nostalgic", "tender"] },
    wistful: { type: "mood", featureProfile: { valence: 0.35, arousal: 0.25, energy: 0.3, acousticness: 0.5 }, related: ["nostalgic", "melancholic", "calm"] },
    serene: { type: "mood", featureProfile: { valence: 0.6, arousal: 0.1, energy: 0.15, acousticness: 0.6 }, related: ["peaceful", "calm", "ambient"] },
    contemplative: { type: "mood", featureProfile: { valence: 0.4, arousal: 0.2, energy: 0.25, instrumentalness: 0.5 }, related: ["calm", "atmospheric", "mellow"] },
    gritty: { type: "mood", featureProfile: { energy: 0.7, valence: 0.35, acousticness: 0.15 }, related: ["raw", "dark", "aggressive"] },
    uplifting: { type: "vibe", featureProfile: { valence: 0.75, arousal: 0.65, energy: 0.65 }, related: ["happy", "hopeful", "bright"] },
    // === ERA / DECADE ===
    "80s synth pop": { type: "era", featureProfile: { energy: 0.6, danceability: 0.7, acousticness: 0.05, valence: 0.6 }, related: ["synth", "pop", "electronic", "new wave"] },
    "90s alternative": { type: "era", featureProfile: { energy: 0.7, valence: 0.4, acousticness: 0.2, danceability: 0.4 }, related: ["grunge", "alternative", "rock"] },
    "70s funk": { type: "era", featureProfile: { energy: 0.7, danceability: 0.85, valence: 0.7, acousticness: 0.3 }, related: ["funk", "groovy", "disco"] },
    retro: { type: "era", featureProfile: { acousticness: 0.3 }, related: ["vintage", "classic rock", "70s funk"] },
    vintage: { type: "era", featureProfile: { acousticness: 0.35 }, related: ["retro", "warm", "analog"] },
    futuristic: { type: "era", featureProfile: { acousticness: 0.05, instrumentalness: 0.6, energy: 0.6 }, related: ["electronic", "synth", "synthwave"] },
    "modern electronic": { type: "era", featureProfile: { acousticness: 0.05, energy: 0.65, danceability: 0.7 }, related: ["electronic", "house", "techno"] },
};

export const VOCABULARY_TERMS = Object.keys(VOCAB_DEFINITIONS);


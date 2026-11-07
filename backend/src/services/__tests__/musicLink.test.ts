/** Which addresses are music links, and which site each belongs to. */
import { recogniseMusicLink, requireMusicLink } from "../musicLink";

describe("a real address on a supported site", () => {
    it("is recognised with its platform", () => {
        expect(recogniseMusicLink("https://www.youtube.com/playlist?list=PL123")).toEqual({
            platform: "youtube",
            domain: "youtube.com",
            url: "https://www.youtube.com/playlist?list=PL123",
        });
    });
});

describe("every supported site's real addresses", () => {
    it.each([
        ["https://youtube.com/watch?v=abc", "youtube", "youtube.com"],
        ["https://m.youtube.com/watch?v=abc", "youtube", "youtube.com"],
        ["https://youtu.be/abc", "youtube", "youtu.be"],
        ["https://music.youtube.com/playlist?list=OLAK5", "youtubeMusic", "music.youtube.com"],
        ["https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M", "spotify", "spotify.com"],
        ["https://www.deezer.com/en/playlist/1313621735", "deezer", "deezer.com"],
        ["https://soundcloud.com/artist/sets/mix", "soundcloud", "soundcloud.com"],
        ["https://on.soundcloud.com/abc123", "soundcloud", "soundcloud.com"],
        ["https://www.mixcloud.com/someone/playlists/mix/", "mixcloud", "mixcloud.com"],
        ["http://www.youtube.com/watch?v=abc", "youtube", "youtube.com"],
    ])("%s is %s on %s", (address, platform, domain) => {
        expect(recogniseMusicLink(address)).toEqual({ platform, domain, url: address });
    });
});

describe("an address that is not on a supported site", () => {
    it.each([
        "https://youtube.com.evil.invalid/playlist?list=x",
        "https://notyoutube.com/watch?v=abc",
        "https://music.youtube.com.evil.invalid/playlist?list=x",
        "https://youtube.com@evil.invalid/",
        "https://evil.invalid/?u=youtube.com",
        "https://evil.invalid/spotify.com/playlist/x",
        "https://evil.invalid/#youtu.be",
        "https://youtube.com.:evil@evil.invalid/",
    ])("%s is refused", (address) => {
        expect(recogniseMusicLink(address)).toBeNull();
    });
});

describe("a Bandcamp address", () => {
    it.each([
        "https://artist.bandcamp.com/album/record",
        "https://artist.bandcamp.com/track/song",
        "https://bandcamp.com/",
        "http://www.bandcamp.com/discover",
    ])("%s is refused, as nothing can import from Bandcamp", (address) => {
        expect(recogniseMusicLink(address)).toBeNull();
    });
});

describe("an Apple Music or Tidal address", () => {
    it.each([
        "https://music.apple.com/us/playlist/x",
        "https://music.apple.com/us/album/x/123",
        "https://tidal.com/browse/playlist/x",
        "https://listen.tidal.com/playlist/abc",
    ])("%s is refused, as nothing can import from either", (address) => {
        expect(recogniseMusicLink(address)).toBeNull();
    });
});

describe("an address that is not http or https", () => {
    it.each([
        "file:///etc/passwd",
        "ftp://youtube.com/x",
        "javascript:alert(1)",
        "spotify:playlist:abc",
        "ftp://open.spotify.com/playlist/abc",
    ])("%s is refused", (address) => {
        expect(recogniseMusicLink(address)).toBeNull();
    });
});

describe("input that is not an address", () => {
    it.each([undefined, null, 42, {}, ["https://youtube.com/x"], "", "not a url", "https://", "youtube.com/watch?v=abc"])(
        "%p is refused without an error",
        (input) => {
            expect(recogniseMusicLink(input)).toBeNull();
        },
    );
});

describe("the address handed onward", () => {
    it("is the one that was checked, so another reader of it sees the same host", () => {
        expect(recogniseMusicLink("https://youtube.com\\@evil.invalid/")).toEqual({
            platform: "youtube",
            domain: "youtube.com",
            url: "https://youtube.com/@evil.invalid/",
        });
        expect(recogniseMusicLink("HTTPS://WWW.YouTube.COM/playlist?list=x y")).toEqual({
            platform: "youtube",
            domain: "youtube.com",
            url: "https://www.youtube.com/playlist?list=x%20y",
        });
    });
});

describe("requiring a music link", () => {
    it("returns the recognised link", () => {
        expect(requireMusicLink("https://www.youtube.com/playlist?list=PL123")).toEqual(
            recogniseMusicLink("https://www.youtube.com/playlist?list=PL123"),
        );
    });

    it("throws one error for anything that is not a music link", () => {
        for (const input of ["https://evil.invalid/?u=youtube.com", "not a link", 42, null]) {
            expect(() => requireMusicLink(input)).toThrow("Not a link to a supported music site");
        }
    });
});

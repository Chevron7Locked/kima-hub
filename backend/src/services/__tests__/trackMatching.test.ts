import {
  matchTrackToLibrary,
  type MatchCandidate,
  type SourceTrack,
} from "../trackMatching";

const candidate = (
  id: string,
  title: string,
  artistName: string,
  albumTitle = "Album",
): MatchCandidate => ({ id, title, albumId: `al-${id}`, albumTitle, artistName });

describe("matchTrackToLibrary", () => {
  it("matches exact title with agreeing album at confidence 100", () => {
    const source: SourceTrack = {
      title: "Home",
      artist: "Depapepe",
      album: "WANDERLAND",
    };
    const result = matchTrackToLibrary(source, [
      candidate("t1", "Home", "DEPAPEPE", "Wanderland"),
    ]);
    expect(result?.matchType).toBe("exact");
    expect(result?.confidence).toBe(100);
    expect(result?.candidate.id).toBe("t1");
  });

  it("matches exact title when the source has no album hint at 90", () => {
    const source: SourceTrack = {
      title: "Home",
      artist: "Depapepe",
      album: "Unknown Album",
    };
    const result = matchTrackToLibrary(source, [
      candidate("t1", "Home", "DEPAPEPE", "Wanderland"),
    ]);
    expect(result?.matchType).toBe("exact");
    expect(result?.confidence).toBe(90);
  });

  it("matches exact title on a DIFFERENT album only at 85 (probable)", () => {
    const source: SourceTrack = {
      title: "Home",
      artist: "Depapepe",
      album: "WANDERLAND",
    };
    const result = matchTrackToLibrary(source, [
      candidate("t1", "Home", "DEPAPEPE", "OTHER ALBUM"),
    ]);
    expect(result?.matchType).toBe("exact");
    expect(result?.confidence).toBe(85);
  });

  it("matches suffix-stripped titles (\"Song (Remastered)\" vs \"Song\")", () => {
    const source: SourceTrack = {
      title: "Horse With No Name (Remastered)",
      artist: "America",
      album: "History",
    };
    const result = matchTrackToLibrary(source, [
      candidate("t1", "Horse With No Name", "America", "History"),
    ]);
    expect(result?.matchType).toBe("exact");
  });

  it("matches containment: \"Sordid Affair\" vs \"Sordid Affair (Feat. Ryan James)\"", () => {
    const source: SourceTrack = {
      title: "Sordid Affair",
      artist: "Comatose White",
      album: "Self-Titled",
    };
    const result = matchTrackToLibrary(source, [
      candidate("t1", "Sordid Affair (Feat. Ryan James)", "Comatose White"),
    ]);
    expect(result?.matchType).toBe("fuzzy");
    expect(result?.confidence).toBeGreaterThanOrEqual(80);
  });

  it("does not match when no candidate shares the title", () => {
    const source: SourceTrack = {
      title: "Nonexistent Track",
      artist: "Some Artist",
      album: "Some Album",
    };
    expect(
      matchTrackToLibrary(source, [candidate("t1", "A Totally Different Song", "Some Artist")]),
    ).toBeNull();
  });

  it("does not match an empty pool", () => {
    expect(
      matchTrackToLibrary({ title: "Any", artist: "Any" }, []),
    ).toBeNull();
  });

  it("title-only mode accepts a same-title candidate from another artist", () => {
    const source: SourceTrack = { title: "Song Of The Year", artist: "Keane" };
    const result = matchTrackToLibrary(
      source,
      [candidate("t1", "Song Of The Year", "Not Keane")],
      { requireArtistMatch: false },
    );
    // Exact title wins regardless of artist when the caller opts out of the
    // artist gate — that is the compilation/Various-Artists fallback.
    expect(result?.candidate.id).toBe("t1");
  });

  it("keeps artist gating on by default and does not jump to unrelated artists", () => {
    const source: SourceTrack = { title: "96 Proof Of Love", artist: "Kari Faux" };
    const result = matchTrackToLibrary(source, [
      candidate("t1", "96 Proof Of Love (Alternate)", "Kari Faux"),
    ]);
    expect(result?.candidate.id).toBe("t1");
    expect(result?.matchType).toBe("fuzzy");
  });

  describe("titles outside English letters", () => {
    const pool = [
      candidate("first-love", "First Love", "宇多田ヒカル", "First Love"),
      candidate("hanataba", "花束を君に", "宇多田ヒカル", "Fantôme"),
      candidate("michi", "道", "宇多田ヒカル", "Fantôme"),
    ];

    it("matches the song asked for, not the artist's first such song", () => {
      const result = matchTrackToLibrary({ title: "道", artist: "宇多田ヒカル", album: "Fantôme" }, pool);
      expect(result?.candidate.id).toBe("michi");
      expect(result?.confidence).toBe(100);
    });

    it("matches nothing when the library lacks the song", () => {
      expect(matchTrackToLibrary({ title: "桜流し", artist: "宇多田ヒカル" }, pool)).toBeNull();
    });

    it("matches nothing across artists and scripts when the title differs", () => {
      expect(
        matchTrackToLibrary({ title: "Группа крови", artist: "Кино" }, pool, { requireArtistMatch: false }),
      ).toBeNull();
    });

    it("matches a Russian title by its words, ignoring case", () => {
      const result = matchTrackToLibrary({ title: "ГРУППА КРОВИ", artist: "Кино" }, [
        candidate("other", "Звезда по имени Солнце", "Кино"),
        candidate("blood", "Группа крови", "Кино"),
      ]);
      expect(result?.candidate.id).toBe("blood");
    });

    it("never lets two titles with no letters or digits match through the fold", () => {
      expect(matchTrackToLibrary({ title: "???", artist: "Artist" }, [candidate("t1", "!!!", "Artist")])).toBeNull();
    });
  });

  it("treats a no-break space as a space between words", () => {
    const result = matchTrackToLibrary({ title: "Je t\u2019aime\u00A0moi non plus", artist: "Serge Gainsbourg" }, [
      candidate("t1", "Je t'aime moi non plus", "Serge Gainsbourg"),
    ]);
    expect(result?.candidate.id).toBe("t1");
    expect(result?.matchType).toBe("exact");
  });
});

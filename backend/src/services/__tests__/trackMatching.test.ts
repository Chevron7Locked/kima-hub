import {
  matchTrackToLibrary,
  toMatchCandidates,
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

describe("toMatchCandidates", () => {
  const song = (o: { displayTitle?: string | null; displayName?: string | null }) => ({
    id: "s1",
    title: "File Title",
    displayTitle: o.displayTitle,
    albumId: "al1",
    album: { title: "Album", artist: { name: "File Artist", displayName: o.displayName } },
  });

  it("gives one candidate for a song nobody edited", () => {
    expect(toMatchCandidates(song({}))).toEqual([
      { id: "s1", title: "File Title", albumId: "al1", albumTitle: "Album", artistName: "File Artist" },
    ]);
  });

  it("gives a candidate for each title and artist name the song is known by", () => {
    const pairs = toMatchCandidates(song({ displayTitle: "Shown Title", displayName: "Shown Artist" })).map((c) => [c.title, c.artistName]);
    expect(pairs.sort()).toEqual([
      ["File Title", "File Artist"], ["File Title", "Shown Artist"], ["Shown Title", "File Artist"], ["Shown Title", "Shown Artist"],
    ]);
  });

  it("does not repeat a name that was edited to itself or to nothing", () => {
    expect(toMatchCandidates(song({ displayTitle: "File Title", displayName: "File Artist" }))).toHaveLength(1);
    expect(toMatchCandidates(song({ displayTitle: "", displayName: "" }))).toHaveLength(1);
  });
});

describe("a song's twin candidates (one per name it is known by)", () => {
  const twins = toMatchCandidates({
    id: "song-a",
    title: "Midnight Drive",
    displayTitle: "Midnight Drive (Shown)",
    albumId: "al-a",
    album: { title: "Album", artist: { name: "Rawfile Band", displayName: "Shownname Band" } },
  });
  const rival = candidate("song-b", "Midnight Drive", "Rawfile Bandits");
  const permutations = <T,>(xs: T[]): T[][] =>
    xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]));

  it("matches a source that names the shown artist", () => {
    const result = matchTrackToLibrary({ title: "Midnight Drive", artist: "Shownname Band", album: "Unknown Album" }, twins);
    expect(result?.candidate.id).toBe("song-a");
    expect(result?.matchType).toBe("exact");
  });

  it.each([
    ["the shown artist and the file's title", { title: "Midnight Drive", artist: "Shownname Band" }],
    ["the shown artist and the shown title", { title: "Midnight Drive (Shown)", artist: "Shownname Band" }],
    ["the file's artist and the shown title", { title: "Midnight Drive (Shown)", artist: "Rawfile Band" }],
    ["a near title and the shown artist (the fuzzy stages)", { title: "Midnight Drives", artist: "Shownname Band" }],
    ["the shown artist with a featured credit", { title: "Midnight Drive", artist: "Shownname Band feat. Someone" }],
  ])("never lets a twin or a rival tie it away from its song: %s", (_what, source) => {
    for (const pool of permutations([...twins, rival])) {
      expect(matchTrackToLibrary(source, pool)?.candidate.id).toBe("song-a");
    }
  });

  it("gives the same song whichever twin the ladder reaches first", () => {
    for (const pool of permutations(twins)) {
      for (const source of [
        { title: "Midnight Drive", artist: "Shownname Band" },
        { title: "Midnight Drive (Shown)", artist: "Rawfile Band" },
        { title: "Midnight Driver", artist: "Shownname Band" },
      ]) {
        expect(matchTrackToLibrary(source, pool)?.candidate.id).toBe("song-a");
      }
    }
  });

  it("keeps its song when another song's own artist name is the shown name, whatever the pool order", () => {
    const namesake = candidate("song-c", "Midnight Drive Reprise", "Shownname Band");
    for (const pool of permutations([...twins, namesake])) {
      expect(matchTrackToLibrary({ title: "Midnight Drive", artist: "Shownname Band" }, pool)?.candidate.id).toBe("song-a");
      expect(matchTrackToLibrary({ title: "Midnight Drive (Shown)", artist: "Shownname Band" }, pool)?.candidate.id).toBe("song-a");
    }
  });

  it("does not match a source of another artist and another song", () => {
    expect(matchTrackToLibrary({ title: "Completely Other Song", artist: "Zxqv Jkw Ptyl" }, twins)).toBeNull();
  });
});

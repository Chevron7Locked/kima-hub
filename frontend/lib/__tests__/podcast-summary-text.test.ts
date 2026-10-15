import { it, expect } from "vitest";
import { plain } from "@/features/podcast/components/PreviewEpisodes";

// An episode summary is shown as text: markup gone, entities decoded, spacing collapsed.
it("shows a summary's words, with entities as the characters they stand for", () => {
    expect(plain("<p>Tom &amp; Jerry&nbsp;&mdash; it&#39;s <b>on</b></p>\n<p>again</p>")).toBe("Tom & Jerry — it's on again");
});

it("keeps words from separate paragraphs and lines apart, and inline markup joined", () => {
    expect(plain("<p>First.</p><p>Second.</p>a<br>b<ul><li>one</li><li>two</li></ul>")).toBe("First. Second. a b one two");
    expect(plain("<b>on</b>ly")).toBe("only");
});

it("runs nothing in a summary", () => {
    (window as unknown as { __ran?: boolean }).__ran = false;
    expect(plain('<img src=x onerror="window.__ran=true">hi<script>window.__ran=true</script>')).toBe("hi");
    expect((window as unknown as { __ran?: boolean }).__ran).toBe(false);
});

it("is empty for no summary", () => {
    expect(plain(undefined)).toBe("");
});

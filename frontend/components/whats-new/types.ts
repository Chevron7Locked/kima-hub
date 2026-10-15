/** A release as the server sends it to the window and the changelog. */

export interface ReleaseLink {
    label: string;
    href: string;
}

export interface ItemBase {
    key: string;
    title: string;
    summary: string;
    body: string;
    links?: ReleaseLink[];
}

export type ReleaseItem =
    | (ItemBase & { kind: "note" })
    | (ItemBase & {
          kind: "action";
          cta: string;
          run?: "wipeEnrichment";
          confirmTitle?: string;
          confirmMessage?: string;
          confirmLabel?: string;
          /** What closing without acting means for this item; said in the footer. */
          ifClosed?: string;
          requires?: "savedMoodMix" | "retiredMoodMix" | "admin";
      })
    | (ItemBase & { kind: "choice"; defaultValue: false; discloses?: string; requires?: "admin" });

export interface Release {
    version: string;
    title: string;
    summary: string;
    date: string;
    note?: { from: string; body: string };
    items: ReleaseItem[];
}

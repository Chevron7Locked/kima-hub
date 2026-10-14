const SIZES = {
    window: { gap: "", text: "text-[0.9375rem]" },
    page: { gap: "mt-2 ", text: "text-sm" },
} as const;

/** A release item's text: blank lines separate paragraphs; a block of lines that each start with "- " is a list.
 * `window` is the release window's reading size, `page` the changelog page's denser one. */
export function ReleaseBody({ text, size }: { text: string; size: keyof typeof SIZES }) {
    const { gap, text: textSize } = SIZES[size];
    return (
        <>
            {text.split("\n\n").map((block, i) => {
                const lines = block.split("\n");
                if (lines.every((l) => l.startsWith("- "))) {
                    return (
                        <ul key={i} className={`${gap}flex flex-col gap-2 pl-5 list-disc marker:text-brand`}>
                            {lines.map((l, j) => (
                                <li key={j} className={`pl-1 ${textSize} leading-relaxed text-[var(--text-secondary)]`}>
                                    {l.slice(2)}
                                </li>
                            ))}
                        </ul>
                    );
                }
                return (
                    <p key={i} className={`${gap}${textSize} leading-relaxed text-[var(--text-secondary)] max-w-[62ch]`}>
                        {block}
                    </p>
                );
            })}
        </>
    );
}

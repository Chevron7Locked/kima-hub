import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/* text-micro is a custom @theme font-size token (10px, globals.css). Tailwind's
 * own scale ends at text-xs, so tailwind-merge has no record of it and files it
 * under text colors — any later text-* color in the same cn() call then strips
 * it, and the element inherits the parent font size. Register it as a font-size
 * so size and color coexist. */
const twMerge = extendTailwindMerge({
    extend: {
        classGroups: {
            "font-size": [{ text: ["micro"] }],
        },
    },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

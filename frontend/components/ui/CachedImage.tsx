"use client";

import Image, { type ImageLoader, type ImageProps } from "next/image";
import { memo, useState } from "react";

interface CachedImageProps extends Omit<ImageProps, "src"> {
    src: string | null | undefined;
    fill?: boolean;
}

const SIZE_PARAM = /([?&])size=\d+/;
// The server resizes library covers up to this width (backend imageStorage.resizeImageBuffer).
const MAX_COVER_WIDTH = 2048;

/** Asks the library's resizing endpoint for the width the browser picked from the srcset. */
const coverLoader: ImageLoader = ({ src, width }) => src.replace(SIZE_PARAM, `$1size=${Math.min(width, MAX_COVER_WIDTH)}`);

/*
 * Cover art is served cache-first by the service worker for /api/library/cover-art/*. A library cover asked for at
 * a size is offered at several widths, so a 2x or 3x screen gets a sharp one; a fill image needs `sizes` for the
 * browser to choose by, and without it keeps the one size it was given. Anything else is used as given.
 */
const CachedImage = memo(function CachedImage({
    src,
    alt = "",
    ...props
}: CachedImageProps) {
    const [failedSrc, setFailedSrc] = useState<string | null>(null);

    if (!src || failedSrc === src) {
        return null;
    }

    const resizable = src.includes("/api/library/cover-art") && SIZE_PARAM.test(src) && (!props.fill || !!props.sizes);

    return (
        <Image
            src={src}
            alt={alt}
            {...(resizable ? { loader: coverLoader } : { unoptimized: true })}
            {...props}
            loading={props.loading ?? (props.priority || props.preload ? undefined : "lazy")}
            onError={(e) => {
                setFailedSrc(src);
                props.onError?.(e);
            }}
        />
    );
});

export { CachedImage };

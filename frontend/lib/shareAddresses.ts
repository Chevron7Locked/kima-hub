/* The backend addresses of one share, as the browser reaches them. The token is encoded wherever it sits in an address. */

const base = (token: string) => `/api/share/${encodeURIComponent(token)}`;

export const shareResolvePath = (token: string): string => base(token);

export const shareStreamPath = (token: string, trackId: string): string =>
    `${base(token)}/stream/${encodeURIComponent(trackId)}`;

/** The share's cover route for one cover, the only one that serves a cover to a stranger. */
export const shareCoverPath = (token: string, coverId: string): string =>
    `${base(token)}/cover-art/${encodeURIComponent(coverId)}?size=500`;

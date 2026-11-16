/* The backend addresses of one share, as the browser reaches them. The token is encoded wherever it sits in an address. */

const base = (token: string) => `/api/share/${encodeURIComponent(token)}`;

/** The share as a person opens it: the backend counts one visit. */
export const shareResolvePath = (token: string): string => base(token);

/** The share read for another reason (a page card, a check after a playback error): the backend counts no visit. */
export const shareUncountedPath = (token: string): string => `${base(token)}?count=0`;

export const shareStreamPath = (token: string, trackId: string): string =>
    `${base(token)}/stream/${encodeURIComponent(trackId)}`;

/** The share's cover route for one cover, the only one that serves a cover to a stranger. */
export const shareCoverPath = (token: string, coverId: string): string =>
    `${base(token)}/cover-art/${encodeURIComponent(coverId)}?size=500`;

/** Typed CustomEvents that tell listeners to refetch queries after data changes. */

export type QueryEventType = "audiobook-progress-updated" | "podcast-progress-updated";

export interface QueryEventDetail {
    [key: string]: unknown;
}

/** Dispatch a typed query event. */
export function dispatchQueryEvent(
    eventType: QueryEventType,
    detail?: QueryEventDetail
): void {
    window.dispatchEvent(
        new CustomEvent(eventType, { detail: detail || {} })
    );
}

/** Subscribe to a typed query event; returns the unsubscribe function. */
export function subscribeQueryEvent(
    eventType: QueryEventType,
    handler: (event: CustomEvent<QueryEventDetail>) => void
): () => void {
    const listener = handler as EventListener;
    window.addEventListener(eventType, listener);
    
    return () => {
        window.removeEventListener(eventType, listener);
    };
}

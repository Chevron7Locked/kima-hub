/**
 * Query Events - Typed event system for cache invalidation
 * 
 * Provides a type-safe wrapper around CustomEvent for triggering React Query cache invalidation.
 * Events are dispatched when data changes and listeners refetch queries to update the UI.
 */

/**
 * Available query event types
 */
export type QueryEventType =
    | "audiobook-progress-updated"
    | "podcast-progress-updated"
    | "library-updated"
    | "mixes-updated"; // Include existing event for consistency

/**
 * Event payload interface - can be extended for event-specific data
 */
export interface QueryEventDetail {
    [key: string]: unknown;
}

/**
 * Dispatch a typed query event
 * 
 * @param eventType - The type of event to dispatch
 * @param detail - Optional event payload data
 * 
 * @example
 * dispatchQueryEvent("audiobook-progress-updated", { audiobookId: "123" });
 */
export function dispatchQueryEvent(
    eventType: QueryEventType,
    detail?: QueryEventDetail
): void {
    window.dispatchEvent(
        new CustomEvent(eventType, { detail: detail || {} })
    );
}

/**
 * Subscribe to a typed query event
 * 
 * @param eventType - The type of event to listen for
 * @param handler - Callback function to execute when event fires
 * @returns Cleanup function to remove the event listener
 * 
 * @example
 * const unsubscribe = subscribeQueryEvent("audiobook-progress-updated", () => {
 *     queryClient.refetchQueries({ queryKey: ["audiobook", id] });
 * });
 * // Later: unsubscribe();
 */
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

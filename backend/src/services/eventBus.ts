import { EventEmitter } from "events";

export type SSEEventType =
    | "notification"
    | "notification:cleared"
    | "download:progress"
    | "download:queued"
    | "download:complete"
    | "download:failed"
    | "search:result"
    | "search:complete"
    | "scan:progress"
    | "scan:complete"
    | "import:progress"
    | "discover:progress"
    | "discover:complete";

export interface SSEEvent {
    type: SSEEventType;
    userId: string;
    payload: Record<string, unknown>;
}

const CHANNEL = "sse";

class EventBus {
    private emitter: EventEmitter;

    constructor() {
        this.emitter = new EventEmitter();
        this.emitter.setMaxListeners(100);
    }

    emit(event: SSEEvent): void {
        this.emitter.emit(CHANNEL, event);
    }

    subscribe(listener: (event: SSEEvent) => void): () => void {
        this.emitter.on(CHANNEL, listener);
        return () => {
            this.emitter.off(CHANNEL, listener);
        };
    }
}

export const eventBus = new EventBus();

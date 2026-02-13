/**
 * Heartbeat Monitor
 *
 * Detects when audio playback stalls or stops unexpectedly.
 * Polls currentTime and triggers callbacks when playback appears frozen.
 */

export interface HeartbeatConfig {
  /** Polling interval in ms (default: 1000) */
  interval: number;
  /** Number of stale polls before triggering stall (default: 3) */
  staleThreshold: number;
  /** Tolerance for time change detection in seconds (default: 0.1) */
  timeTolerance: number;
  /** Buffer timeout in ms before declaring error (default: 10000) */
  bufferTimeout: number;
}

export interface HeartbeatCallbacks {
  /** Called when playback appears stalled but audio reports playing */
  onStall: () => void;
  /** Called when playback stopped without expected event */
  onUnexpectedStop: () => void;
  /** Called when buffer timeout expires */
  onBufferTimeout: () => void;
  /** Called when playback recovers from stall */
  onRecovery: () => void;
  /** Get current time from audio engine */
  getCurrentTime: () => number;
  /** Check if audio engine reports playing */
  isActuallyPlaying: () => boolean;
}

const DEFAULT_CONFIG: HeartbeatConfig = {
  interval: 1000,
  staleThreshold: 3,
  timeTolerance: 0.1,
  bufferTimeout: 10000,
};

export class HeartbeatMonitor {
  private config: HeartbeatConfig;
  private callbacks: HeartbeatCallbacks;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private bufferTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private lastKnownTime: number = 0;
  private staleCount: number = 0;
  private isStalled: boolean = false;
  private isRunning: boolean = false;
  private lastTickTime: number = 0;
  private debugEnabled: boolean = false;

  constructor(callbacks: HeartbeatCallbacks, config: Partial<HeartbeatConfig> = {}) {
    this.callbacks = callbacks;
    this.config = { ...DEFAULT_CONFIG, ...config };

    if (typeof window !== 'undefined') {
      this.debugEnabled = localStorage.getItem('lidifyAudioDebug') === '1';
    }
  }

  /**
   * Start monitoring playback
   */
  start(): void {
    if (this.isRunning) return;

    this.isRunning = true;
    this.lastKnownTime = this.callbacks.getCurrentTime();
    this.staleCount = 0;
    this.lastTickTime = Date.now();
    this.isStalled = false;

    if (this.debugEnabled) {
      console.log('[Heartbeat] Started monitoring');
    }

    this.intervalId = setInterval(() => this.tick(), this.config.interval);
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (!this.isRunning) return;

    this.isRunning = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    this.clearBufferTimeout();
    this.staleCount = 0;
    this.isStalled = false;

    if (this.debugEnabled) {
      console.log('[Heartbeat] Stopped monitoring');
    }
  }

  /**
   * Start buffer timeout (called when entering BUFFERING state)
   */
  startBufferTimeout(): void {
    this.clearBufferTimeout();

    this.bufferTimeoutId = setTimeout(() => {
      if (this.debugEnabled) {
        console.log('[Heartbeat] Buffer timeout expired');
      }
      this.callbacks.onBufferTimeout();
    }, this.config.bufferTimeout);
  }

  /**
   * Clear buffer timeout (called when recovering from BUFFERING)
   */
  clearBufferTimeout(): void {
    if (this.bufferTimeoutId) {
      clearTimeout(this.bufferTimeoutId);
      this.bufferTimeoutId = null;
    }
  }

  /**
   * Notify that playback has progressed (resets stale counter)
   */
  notifyProgress(time: number): void {
    if (Math.abs(time - this.lastKnownTime) >= this.config.timeTolerance) {
      this.lastKnownTime = time;
      this.staleCount = 0;

      // If we were stalled, we've recovered
      if (this.isStalled) {
        this.isStalled = false;
        this.clearBufferTimeout();
        this.callbacks.onRecovery();

        if (this.debugEnabled) {
          console.log('[Heartbeat] Recovered from stall');
        }
      }
    }
  }

  private tick(): void {
    const now = Date.now();
    const wallClockDelta = now - this.lastTickTime;
    this.lastTickTime = now;

    // If wall-clock gap is > 3x interval, tab was likely backgrounded.
    // Reset stale counter to avoid false-positive stall detection.
    if (wallClockDelta > this.config.interval * 3) {
      this.lastKnownTime = this.callbacks.getCurrentTime();
      this.staleCount = 0;
      if (this.debugEnabled) {
        console.log(`[Heartbeat] Tab resume detected (${wallClockDelta}ms gap), reset stale counter`);
      }
      return;
    }

    const currentTime = this.callbacks.getCurrentTime();
    const isActuallyPlaying = this.callbacks.isActuallyPlaying();
    const timeDelta = Math.abs(currentTime - this.lastKnownTime);

    if (timeDelta < this.config.timeTolerance) {
      // Time hasn't changed
      this.staleCount++;

      if (this.debugEnabled && this.staleCount > 0) {
        console.log(`[Heartbeat] Stale count: ${this.staleCount}, time: ${currentTime.toFixed(2)}`);
      }

      if (this.staleCount >= this.config.staleThreshold) {
        if (!isActuallyPlaying) {
          // Howler stopped but we didn't get an event -- fire once only
          if (!this.isStalled) {
            this.isStalled = true;
            if (this.debugEnabled) {
              console.log('[Heartbeat] Unexpected stop detected');
            }
            this.callbacks.onUnexpectedStop();
          }
        } else if (!this.isStalled) {
          // Howler says playing but time isn't moving -- network stall
          this.isStalled = true;
          if (this.debugEnabled) {
            console.log('[Heartbeat] Stall detected');
          }
          this.callbacks.onStall();
        }
      }
    } else {
      // Time is moving -- reset stale counter
      this.lastKnownTime = currentTime;
      this.staleCount = 0;

      if (this.isStalled) {
        this.isStalled = false;
        this.clearBufferTimeout();
        this.callbacks.onRecovery();

        if (this.debugEnabled) {
          console.log('[Heartbeat] Recovered from stall');
        }
      }
    }
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    this.stop();
  }
}

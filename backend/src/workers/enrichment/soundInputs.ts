/**
 * What the moods and the similarity step both wait on: analysis (MusiCNN) and sound vectors (CLAP) settled for
 * the whole library. One rule, so the two steps stay independent of each other.
 */

/** The counts the moods' inputs are judged by. */
export interface SoundInputs {
    audioAnalysis: { pending: number; processing: number; failed: number };
    clapEmbeddings: { pending: number; processing: number; retrying: number };
}

/**
 * True when nothing that feeds the moods is still being answered: no analysis waiting, running or failed and due a
 * retry, and no sound vector waiting, running or retrying. The moods are scored from both, and the similarity step
 * waits on the same inputs.
 */
export function soundInputsSettled(progress: SoundInputs): boolean {
    return (
        progress.audioAnalysis.pending === 0 &&
        progress.audioAnalysis.processing === 0 &&
        progress.audioAnalysis.failed === 0 &&
        progress.clapEmbeddings.pending === 0 &&
        progress.clapEmbeddings.processing === 0 &&
        progress.clapEmbeddings.retrying === 0
    );
}

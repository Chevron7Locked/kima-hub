/**
 * Finishes a settings load for the person who asked for it: `show` gets the answer, a failure becomes the load error,
 * and loading ends. Once someone else is signed in (`current()` false) every part of the answer is dropped.
 */
export function settleFor<T>(
    load: Promise<T>,
    current: () => boolean,
    show: (data: T) => void,
    setLoadError: (message: string | null) => void,
    setIsLoading: (loading: boolean) => void,
): Promise<void> {
    return load
        .then((data) => {
            if (current()) show(data);
        })
        .catch((error) => {
            if (current()) setLoadError(error instanceof Error ? error.message : "Failed to load settings");
        })
        .finally(() => {
            if (current()) setIsLoading(false);
        });
}

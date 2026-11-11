/**
 * Sets environment variables for a test and returns the function that puts them back. A variable that
 * was unset is deleted again: assigning `undefined` to `process.env` would store the text "undefined".
 * An `undefined` value unsets the variable until restore.
 */
export function setEnv(vars: Record<string, string | undefined>): () => void {
    const before = Object.keys(vars).map((name) => [name, process.env[name]] as const);
    const assign = (name: string, value: string | undefined) => {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    };
    for (const [name, value] of Object.entries(vars)) assign(name, value);
    return () => {
        for (const [name, value] of before) assign(name, value);
    };
}

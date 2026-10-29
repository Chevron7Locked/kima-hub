/** An in-memory stand-in for the app's Redis client: get, del and a multi() chain that applies setex and del on exec. */
export function memoryRedisMock(store: Map<string, string>) {
    return {
        redisClient: {
            get: jest.fn(async (k: string) => store.get(k) ?? null),
            del: jest.fn(async (k: string) => { store.delete(k); return 1; }),
            multi: jest.fn(() => {
                const ops: Array<() => void> = [];
                const chain = {
                    setex: (k: string, _ttl: number, v: string) => { ops.push(() => store.set(k, v)); return chain; },
                    del: (k: string) => { ops.push(() => store.delete(k)); return chain; },
                    sadd: () => chain,
                    expire: () => chain,
                    exec: async () => { ops.forEach((op) => op()); return []; },
                };
                return chain;
            }),
        },
    };
}

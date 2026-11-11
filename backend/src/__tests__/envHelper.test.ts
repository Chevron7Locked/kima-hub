import { setEnv } from "./helpers/env";

const A = "KIMA_ENV_HELPER_TEST_A";
const B = "KIMA_ENV_HELPER_TEST_B";

afterEach(() => {
    delete process.env[A];
    delete process.env[B];
});

it("sets variables and puts back their old values", () => {
    process.env[A] = "before";
    const restore = setEnv({ [A]: "during" });
    expect(process.env[A]).toBe("during");
    restore();
    expect(process.env[A]).toBe("before");
});

it("a variable that was unset is unset again, not the text undefined", () => {
    const restore = setEnv({ [A]: "during" });
    restore();
    expect(A in process.env).toBe(false);
});

it("undefined unsets a variable until restore", () => {
    process.env[B] = "before";
    const restore = setEnv({ [B]: undefined });
    expect(B in process.env).toBe(false);
    restore();
    expect(process.env[B]).toBe("before");
});

it("a second setEnv inside the first restores in order", () => {
    process.env[A] = "outer-before";
    const outer = setEnv({ [A]: "outer" });
    const inner = setEnv({ [A]: "inner" });
    inner();
    expect(process.env[A]).toBe("outer");
    outer();
    expect(process.env[A]).toBe("outer-before");
});

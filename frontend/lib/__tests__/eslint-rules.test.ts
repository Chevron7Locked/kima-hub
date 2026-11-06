// @vitest-environment node
/**
 * Kima's lint rules, run through ESLint itself: what they stop, what they leave alone, and, through the real project
 * config, that they are switched on and that each message says what to do instead.
 */
import { describe, expect, it } from "vitest";
import path from "path";
import { ESLint, RuleTester } from "eslint";
import kima from "../../eslint-rules/kima.mjs";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
    languageOptions: { ecmaVersion: "latest", sourceType: "module", parserOptions: { ecmaFeatures: { jsx: true } } },
});

const toast = { messageId: "toast" };
const uppercase = { messageId: "uppercase" };

tester.run("no-toast", kima.rules["no-toast"], {
    valid: [
        `import { notify } from "@/lib/notify"; notify.error("couldn't save");`,
        `const label = "toast"; const toasted = true;`,
        `const breakfast = { toast: 2 };`,
        `import x from "toasted-notes";`,
        `import x from "@/lib/toasty";`,
    ],
    invalid: [
        { code: `import { toast } from "sonner";`, errors: [toast] },
        { code: `import { thing } from "sonner/dist";`, errors: [toast] },
        { code: `import { Toaster } from "@/components/ui/sonner";`, errors: [toast] },
        { code: `import { useToast } from "@/hooks/use-toast";`, errors: [toast] },
        { code: `import ReactHot from "react-hot-toast";`, errors: [toast] },
        { code: `import { show } from "@/lib/toast";`, errors: [toast] },
        { code: `import T from "@/components/ui/toaster";`, errors: [toast] },
        { code: `export { toast } from "sonner";`, errors: [toast] },
        { code: `export * from "sonner";`, errors: [toast] },
        { code: `const lib = require("sonner");`, errors: [toast] },
        { code: `const lib = await import("sonner");`, errors: [toast] },
        { code: `toast("saved");`, errors: [toast] },
        { code: `toast.success("saved");`, errors: [toast] },
        { code: `window.toast("saved");`, errors: [toast] },
        { code: `const t = useToast();`, errors: [toast] },
        { code: `const page = <Toaster />;`, errors: [toast] },
        { code: `const page = <ToastProvider />;`, errors: [toast] },
        { code: `const page = <ToastViewport />;`, errors: [toast] },
    ],
});

tester.run("no-uppercase-styling", kima.rules["no-uppercase-styling"], {
    valid: [
        `const a = <p className="text-sm lowercase">hi</p>;`,
        `const a = <p>must contain an uppercase letter</p>;`,
        `const hint = "must contain an uppercase letter";`,
        `const subclass = "must be uppercase";`,
        `const a = <input placeholder="uppercase" />;`,
        `const a = <p style={{ textTransform: "none" }} />;`,
        `const a = code.toUpperCase();`,
        `const a = cn(mode === "capitalize" && "text-xs");`,
        `const toastClass = (kind) => { switch (kind) { case "uppercase": return "x"; default: return "y"; } };`,
        `const a = <Foo style={{ content: "must be uppercase" }} />;`,
        `const styles = ["uppercase"];`,
        `const a = chart.cx("uppercase");`,
        `const a = { uppercase: true };`,
    ],
    invalid: [
        { code: `const a = <p className="uppercase" />;`, errors: [uppercase] },
        { code: `const a = <p className="text-xs uppercase tracking-wide" />;`, errors: [uppercase] },
        { code: `const a = <p className="md:capitalize" />;`, errors: [uppercase] },
        { code: `const a = <p className="[text-transform:uppercase]" />;`, errors: [uppercase] },
        { code: "const a = <p className={`text-xs uppercase ${size}`} />;", errors: [uppercase] },
        { code: `const a = <Foo titleClassName="uppercase" />;`, errors: [uppercase] },
        { code: `const a = <p className={cn("text-xs", on && "uppercase")} />;`, errors: [uppercase] },
        { code: `const a = utils.cn("uppercase");`, errors: [uppercase] },
        { code: `const a = tv({ base: "uppercase" });`, errors: [uppercase] },
        { code: `const a = twJoin("uppercase");`, errors: [uppercase] },
        { code: `const a = cx("uppercase");`, errors: [uppercase] },
        { code: `const labelClass = "capitalize text-sm";`, errors: [uppercase] },
        { code: `const baseStyles = "rounded-md uppercase";`, errors: [uppercase] },
        { code: `const a = <p className={base + " uppercase"} />;`, errors: [uppercase] },
        { code: `function sizeClass() { return "uppercase"; }`, errors: [uppercase] },
        { code: `const rowClass = (on) => (on ? "uppercase" : "");`, errors: [uppercase] },
        { code: `const a = cn({ uppercase: on });`, errors: [uppercase] },
        { code: `el.style.textTransform = "uppercase";`, errors: [uppercase] },
        { code: `const variants = { titleClass: "uppercase" };`, errors: [uppercase] },
        { code: `const a = <p style={{ textTransform: "uppercase" }} />;`, errors: [uppercase] },
        { code: `const a = <p style={{ textTransform: on ? "capitalize" : "none" }} />;`, errors: [uppercase] },
        { code: "const a = { textTransform: `uppercase` };", errors: [uppercase] },
    ],
});

describe("the project's own ESLint config", () => {
    it("reports both rules, each with its fix", async () => {
        const eslint = new ESLint({ cwd: path.resolve(__dirname, "../..") });
        const source = [
            `import { toast } from "sonner";`,
            `export const A = () => <p className="uppercase">{toast("hi")}</p>;`,
            `export const heading = { textTransform: "capitalize" as const };`,
        ].join("\n");
        const [result] = await eslint.lintText(source, { filePath: "components/Probe.tsx" });
        const byRule = (id: string) => result.messages.filter((m) => m.ruleId === id).map((m) => m.message).join(" ");
        expect(byRule("kima/no-toast")).toContain("@/lib/notify");
        expect(byRule("kima/no-uppercase-styling")).toContain("Remove `uppercase`");
        expect(byRule("kima/no-uppercase-styling")).toContain("Remove `textTransform: capitalize`");
        expect(byRule("kima/no-uppercase-styling")).toContain(".font-mono");
    }, 60_000);
});

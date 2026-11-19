/**
 * No module under `src` reaches itself through its imports. A cycle loads only while one side imports lazily
 * (`await import(...)`) or reads the other only after load, so a lazy import counts as an edge here: a static
 * import added later on the wrong side would break load order with nothing to say why. Type-only imports are
 * erased and do not count. A module that needs to tell one that imports it takes a callback instead
 * (`services/downloads/owners.ts`, `lidarrService.onOutage`).
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

const SRC = path.resolve(__dirname, "..");

function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== "__tests__" && entry.name !== "node_modules") sourceFiles(full, out);
        } else if (entry.name.endsWith(".ts") && !/\.(test|d)\.ts$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

function resolveImport(from: string, specifier: string): string | null {
    if (!specifier.startsWith(".")) return null;
    const base = path.resolve(path.dirname(from), specifier);
    for (const candidate of [`${base}.ts`, path.join(base, "index.ts"), base]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    return null;
}

function isTypeOnly(node: ts.ImportDeclaration): boolean {
    const clause = node.importClause;
    if (!clause) return false;
    if (clause.isTypeOnly) return true;
    const named = clause.namedBindings;
    return !clause.name && !!named && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly);
}

/** Each module's runtime imports: static, re-exports, `import()` and `require()` of a relative path. */
function importsOf(file: string): string[] {
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const found = new Set<string>();
    const add = (specifier: string) => {
        const target = resolveImport(file, specifier);
        if (target) found.add(target);
    };
    const visit = (node: ts.Node) => {
        if (ts.isImportDeclaration(node) && !isTypeOnly(node)) {
            add((node.moduleSpecifier as ts.StringLiteral).text);
        } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) {
            add((node.moduleSpecifier as ts.StringLiteral).text);
        } else if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
            const lazy = node.expression.kind === ts.SyntaxKind.ImportKeyword;
            const required = ts.isIdentifier(node.expression) && node.expression.text === "require";
            if (lazy || required) add(node.arguments[0].text);
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return [...found];
}

/** Groups of two or more modules that each reach the others (Tarjan's strongly connected components). */
function cycles(graph: Map<string, string[]>): string[][] {
    let next = 0;
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const stack: string[] = [];
    const onStack = new Set<string>();
    const groups: string[][] = [];
    const visit = (v: string) => {
        index.set(v, next);
        low.set(v, next);
        next++;
        stack.push(v);
        onStack.add(v);
        for (const w of graph.get(v) ?? []) {
            if (!index.has(w)) {
                visit(w);
                low.set(v, Math.min(low.get(v)!, low.get(w)!));
            } else if (onStack.has(w)) {
                low.set(v, Math.min(low.get(v)!, index.get(w)!));
            }
        }
        if (low.get(v) !== index.get(v)) return;
        const group: string[] = [];
        let w: string;
        do {
            w = stack.pop()!;
            onStack.delete(w);
            group.push(w);
        } while (w !== v);
        if (group.length > 1 || graph.get(v)!.includes(v)) groups.push(group);
    };
    for (const v of graph.keys()) if (!index.has(v)) visit(v);
    return groups;
}

it("finds no import cycle under src, lazy imports included", () => {
    const files = sourceFiles(SRC);
    const graph = new Map(files.map((file) => [file, importsOf(file)] as const));
    for (const [file, targets] of graph) graph.set(file, targets.filter((t) => graph.has(t)));
    const found = cycles(graph).map((group) =>
        group
            .map((file) => path.relative(SRC, file))
            .sort()
            .map((file) => `${file} -> ${graph.get(path.join(SRC, file))!.filter((t) => group.includes(t)).map((t) => path.relative(SRC, t)).join(", ")}`)
    );
    expect(found).toEqual([]);
});

it("sees a cycle when one is there", () => {
    const graph = new Map([
        ["a", ["b"]],
        ["b", ["c"]],
        ["c", ["a"]],
        ["d", ["a"]],
    ]);
    expect(cycles(graph).map((g) => g.sort())).toEqual([["a", "b", "c"]]);
});

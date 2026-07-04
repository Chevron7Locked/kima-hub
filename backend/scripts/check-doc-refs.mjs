#!/usr/bin/env node
// spring-clean guard (rule R6): every backticked `*.ts/.test.ts/.sql/.js` reference and
// every relative markdown link in a tracked .md must resolve to a real tracked file.
// Catches the "doc describes a renamed/removed/moved file" rot class. Exit 1 on any dead ref.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
const md = execSync("git ls-files '*.md'", { encoding: "utf8" }).split("\n").filter(Boolean);
const linkRe = /\[[^\]]*\]\(([^)]+)\)/g;
const refRe = /`([\w./-]+\.(?:ts|test\.ts|js|sql))`/g;
const tracked = new Set(execSync("git ls-files", { encoding: "utf8" }).split("\n").filter(Boolean).map(f => f.split("/").pop()));
let dead = 0;
for (const f of md) {
  const txt = execSync(`cat ${JSON.stringify(f)}`, { encoding: "utf8" });
  for (const m of txt.matchAll(linkRe)) {
    const l = m[1].split("#")[0].trim();
    if (!l || /^(https?:|mailto:|#)/.test(l)) continue;
    if (!existsSync(join(dirname(f), l))) { console.error(`DEAD LINK: ${f} -> ${l}`); dead++; }
  }
  for (const m of txt.matchAll(refRe)) {
    if (!tracked.has(m[1].split("/").pop())) { console.error(`DEAD FILE REF: ${f} -> \`${m[1]}\``); dead++; }
  }
}
if (dead) { console.error(`\n${dead} dead doc reference(s).`); process.exit(1); }
console.log("doc refs OK: no dead links or file references in tracked .md");

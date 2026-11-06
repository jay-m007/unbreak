// Benchmark helper: runs Unbreak on one cloned project and prints a JSON line.
// Usage: node bench/run-one.ts <projectDir> <package> <targetVersion>
import { migrate } from "../src/migrate.ts";
import { diffText } from "../src/report.ts";
import { writeFileSync } from "node:fs";

const [dir, pkg, to] = process.argv.slice(2);
const t0 = Date.now();
try {
  const r = migrate({ projectDir: dir, pkg, to });
  writeFileSync(dir + ".diff", diffText(r));
  console.log(JSON.stringify({
    dir, ok: true, from: r.from, to: r.to, ms: Date.now() - t0,
    broken: r.brokenBefore.length, hidden: r.hiddenBreaks.length, fixed: r.fixed.length,
    undone: r.rejected.length, remaining: r.remaining.length, files: r.updated.size,
    fixes: r.fixed.map((f) => f.usage.summary),
    review: r.fixed.filter((f) => f.usage.review).map((f) => `${f.usage.summary}: ${f.usage.review}`),
    rejectedReasons: r.rejected.map((x) => `${x.usage.summary}: ${x.reason}`),
    remainingErrors: r.remaining.map((d) => d.message.slice(0, 160)),
  }));
} catch (e) {
  console.log(JSON.stringify({ dir, ok: false, ms: Date.now() - t0, error: String(e instanceof Error ? e.message : e).slice(0, 300) }));
}

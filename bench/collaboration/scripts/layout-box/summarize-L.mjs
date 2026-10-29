// summarize-L.mjs <run dir>: one layout-cost stack step's summary.json and
// VERDICT from what run-step.sh leaves (meta.json, T-* timestamps,
// monitor.tsv, each generator's stress.json, latencies.json and docker
// inspect). Plain Node, no dependencies: it runs in the stack's
// node:22-alpine `tools` service on the box.
//
// Windows: baseline is the 20 s before the generators start; hold runs from
// 30 s after they start (joins done) to the end of the step's minutes.
// CPU is the collaboration container's cgroup usage over the hold, as ms of
// CPU per second (1000 = one core). Memory is the summed VmRSS of its
// processes (`R` rows) and its working set (memory.current less
// inactive_file); per room is the hold's mean less the baseline's, divided by
// the rooms (it includes each room's two sockets).
// Verdict: `ok` when every generator exited 0 or 2 (2: only the local p95
// budget missed) and nothing aborted; `abort` on ABORT; else `fail`.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const run = process.argv[2];
if (!run) throw new Error('usage: summarize-L.mjs <run dir>');
const file = (name) => path.join(run, name);
const read = (name) => (existsSync(file(name)) ? readFileSync(file(name), 'utf8') : null);
const json = (name) => {
  try {
    return JSON.parse(read(name) ?? 'null');
  } catch {
    return null;
  }
};
const meta = json('meta.json');
const at = (name) => Number(read(name)?.trim());
const baseline = [at('T-baseline'), at('T-generators')];
const hold = [at('T-generators') + 30_000, at('T-generators') + meta.minutes * 60_000];

const cpu = []; // [ms, usage_usec]
const rss = []; // [ms, MiB]
const working = []; // [ms, MiB]
for (const line of (read('monitor.tsv') ?? '').split('\n')) {
  const cells = line.split('\t');
  const now = Number(cells[0]);
  if (cells[1] === 'C' && cells[2] === 'collaboration') {
    cpu.push([now, Number(cells[3])]);
    working.push([now, (Number(cells[4]) - Number(cells[6])) / 1_048_576]);
  }
  if (cells[1] === 'R' && cells[2] === 'collaboration') rss.push([now, Number(cells[3]) / 1024]);
}
const within = (rows, [from, to]) => rows.filter(([now]) => now >= from && now <= to);
const mean = (rows) => (rows.length ? rows.reduce((sum, [, v]) => sum + v, 0) / rows.length : null);
const max = (rows) => (rows.length ? Math.max(...rows.map(([, v]) => v)) : null);
const round = (v, digits = 1) => (v === null || Number.isNaN(v) ? null : Number(v.toFixed(digits)));

const held = within(cpu, hold);
const cpuMsPerSecond =
  held.length > 1
    ? ((held.at(-1)[1] - held[0][1]) / 1000) / ((held.at(-1)[0] - held[0][0]) / 1000)
    : null;
const memory = (rows) => {
  const base = mean(within(rows, baseline));
  const during = mean(within(rows, hold));
  return {
    baselineMB: round(base),
    holdMB: round(during),
    peakMB: round(max(rows)),
    perRoomMB: base === null || during === null ? null : round((during - base) / meta.rooms, 2),
  };
};

const gens = readdirSync(run).filter((name) => /^gen\d$/.test(name));
const latencies = [];
const failures = [];
const exits = [];
for (const gen of gens) {
  const lat = json(`${gen}/latencies.json`);
  if (lat) for (const values of Object.values(lat)) latencies.push(...values);
  const report = json(`${gen}/stress.json`);
  if (report?.failures) failures.push(...report.failures.map((f) => `${gen}: ${f}`));
  const inspect = json(`${gen}.inspect.json`);
  if (Array.isArray(inspect) && inspect[0]) exits.push(inspect[0].State.ExitCode);
}
latencies.sort((a, b) => a - b);
const pct = (p) => (latencies.length ? latencies[Math.round((latencies.length - 1) * p)] : null);

const verdict = existsSync(file('ABORT'))
  ? `abort: ${read('ABORT').trim()}`
  : exits.length && exits.every((code) => code === 0 || code === 2)
    ? 'ok'
    : `fail: exits ${exits.join(',')}`;
const summary = {
  ...meta,
  cpuMsPerSecond: round(cpuMsPerSecond),
  cpuMsPerSecondPerRoom: cpuMsPerSecond === null ? null : round(cpuMsPerSecond / meta.rooms, 2),
  rss: memory(rss),
  workingSet: memory(working),
  markerLatencyMs: { count: latencies.length, p50: pct(0.5), p95: pct(0.95), max: pct(1) },
  failures,
  verdict,
};
writeFileSync(file('summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(file('VERDICT'), `${verdict}\n`);
console.log(JSON.stringify(summary));

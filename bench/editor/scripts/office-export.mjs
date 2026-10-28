// Times the browser export of each seeded Office file (office-export-prep.ts)
// and samples the renderer's resident memory while it runs: four runs per
// file on a fresh page, the first cold. Each export starts a fresh worker, as a
// Download would. Needs this worktree's MSW dev server (preview config
// clone-download, port 5271) or OFFICE_EXPORT_URL.
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { chromium } from '@playwright/test';

const CASES = [
  ['docx', 'long-handbook.docx'], ['docx', 'docx-text-192.docx'], ['docx', 'docx-table-96.docx'],
  ['docx', 'docx-picture-24.docx'], ['docx', 'docx-picture-64.docx'],
  ['xlsx', 'large-gradebook.xlsx'], ['xlsx', 'rows-50k.xlsx'], ['xlsx', 'xlsx-formula-8000.xlsx'],
  ['xlsx', 'xlsx-style-8000.xlsx'],
  ['pptx', 'pptx-text-400.pptx'], ['pptx', 'jp_llm2.pptx'], ['pptx', 'pptx-picture-40.pptx'],
];
const url = process.env.OFFICE_EXPORT_URL || 'http://localhost:5271/bench/editor/scripts/office-export.html';

// Resident memory (MiB) of the browser's renderer processes, where the page
// and its workers run.
function rendererRss(browserPid) {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=,command=']).toString().trim().split('\n');
  const procs = rows.map((row) => {
    const [pid, ppid, rss, ...cmd] = row.trim().split(/\s+/);
    return { cmd: cmd.join(' '), pid: +pid, ppid: +ppid, rss: +rss };
  });
  const tree = new Set([browserPid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of procs) if (tree.has(p.ppid) && !tree.has(p.pid)) { tree.add(p.pid); grew = true; }
  }
  return procs.filter((p) => tree.has(p.pid) && p.cmd.includes('--type=renderer')).reduce((sum, p) => sum + p.rss, 0) / 1024;
}

const browser = await chromium.launch({ headless: true });
const browserPid = browser.process?.()?.pid ?? null;
const results = [];
try {
  for (const [format, name] of CASES) {
    // A fresh page per file, so one file's leftovers never count against the next.
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForFunction(() => typeof window.officeExportProbe === 'function');
    const pid = browserPid ?? Number(execFileSync('pgrep', ['-n', '-f', 'chrome-headless-shell|Chromium']).toString());
    for (let run = 0; run < 4; run++) {
      const before = rendererRss(pid);
      let peak = before;
      const sampler = setInterval(() => { peak = Math.max(peak, rendererRss(pid)); }, 50);
      try {
        const out = await page.evaluate(([f, n]) => window.officeExportProbe(f, n), [format, name]);
        peak = Math.max(peak, rendererRss(pid));
        const row = { format, name, run, ...out, rssBeforeMiB: before, rssPeakMiB: peak, rssDeltaMiB: peak - before };
        results.push(row);
        console.log(JSON.stringify(row));
      } finally {
        clearInterval(sampler);
      }
    }
    await page.close();
  }
} finally {
  await mkdir('bench/editor/.results/office-export', { recursive: true });
  await writeFile('bench/editor/.results/office-export/results.json',
    JSON.stringify({ browser: browser.version(), cpu: os.cpus()[0].model, date: new Date().toISOString(), results }, null, 2));
  await browser.close();
}

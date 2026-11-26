// Lode Integration Guard, GitHub Action side (D28, LOD-60): the fallback for monorepos and for teams
// that won't install apps. Runs in the team's own CI on pull_request events. Reads the 9 config files
// in each folder at the base commit and at the checked-out commit (both through git, so untracked or
// generated files don't count), runs the shared guard, writes the result to the job summary and, if
// allowed, posts or updates one pull request comment. Nothing from the repository is sent to Lode: the
// only Lode calls are GET requests for public files.
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { normalize } from 'node:path';
import { execFileSync } from 'node:child_process';
import { FILES, GUARD_UA, MARKER, TIMEOUT_MS, runGuard, lodeReader } from '../lib/guard.mjs';

const log = (s) => process.stdout.write(`${s}\n`);
const yes = (v, dflt) => (v === undefined || v === '' ? dflt : ['true', 'yes', '1', 'on'].includes(String(v).trim().toLowerCase()));

export function dirsFrom(input) {
  const dirs = String(input ?? '.').split(',').map((d) => d.trim()).filter(Boolean).map((d) => normalize(d).replace(/\\/g, '/').replace(/\/$/, '') || '.');
  const ok = [...new Set(dirs.filter((d) => !d.startsWith('..') && !d.startsWith('/')))].slice(0, 20);
  return ok.length ? ok : ['.'];
}

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 5 * 1024 * 1024 });

// The 9 files in one folder at one commit (a missing file is null)
export function filesAtCommit(cwd, rev, dir) {
  const out = {};
  for (const f of FILES) {
    const path = dir === '.' ? f : `${dir}/${f}`;
    try { out[f] = git(['show', `${rev}:${path}`], cwd); } catch { out[f] = null; }
  }
  return out;
}

function ensureCommit(cwd, sha) {
  try { git(['cat-file', '-e', `${sha}^{commit}`], cwd); return true; } catch {}
  try { git(['fetch', '--no-tags', '--depth=1', 'origin', sha], cwd); return true; } catch { return false; }
}

const api = () => process.env.GITHUB_API_URL || 'https://api.github.com';
const headers = (token) => ({ authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': GUARD_UA, 'content-type': 'application/json' });
const BOTS = new Set(['github-actions[bot]']);

// This Action's own earlier comment: starts with the marker and was posted by a bot account
async function findComment({ token, repo, number, fetchImpl }) {
  for (let page = 1; page <= 10; page++) {
    const res = await fetchImpl(`${api()}/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`, { headers: headers(token), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status} listing comments`);
    const batch = await res.json();
    const mine = batch.find((c) => typeof c.body === 'string' && c.body.startsWith(MARKER) && (c.user?.type === 'Bot' || BOTS.has(c.user?.login)));
    if (mine) return mine;
    if (batch.length < 100) return null;
  }
  return null;
}

async function upsertComment({ token, repo, number, body, fetchImpl, onlyIfExists = false }) {
  const mine = await findComment({ token, repo, number, fetchImpl });
  if (!mine && onlyIfExists) return false;
  const res = mine
    ? await fetchImpl(`${api()}/repos/${repo}/issues/comments/${mine.id}`, { method: 'PATCH', headers: headers(token), body: JSON.stringify({ body }), signal: AbortSignal.timeout(TIMEOUT_MS) })
    : await fetchImpl(`${api()}/repos/${repo}/issues/${number}/comments`, { method: 'POST', headers: headers(token), body: JSON.stringify({ body }), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} posting the comment`);
  return true;
}

export async function main({ cwd, fetchImpl = globalThis.fetch } = {}) {
  const env = process.env;
  cwd ??= env.GITHUB_WORKSPACE || process.cwd();
  const event = env.GITHUB_EVENT_PATH && existsSync(env.GITHUB_EVENT_PATH) ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const pr = event.pull_request;
  if (!pr?.base?.sha) { log('Lode Integration Guard runs on pull_request events only; nothing to do.'); return { action: 'ignored' }; }
  if (!ensureCommit(cwd, pr.base.sha)) { log(`Could not read the base commit ${pr.base.sha}. Nothing checked.`); return { action: 'no-base' }; }
  const dirs = dirsFrom(env.INPUT_DIRS);
  const result = await runGuard({
    baseSets: dirs.map((d) => filesAtCommit(cwd, pr.base.sha, d)),
    headSets: dirs.map((d) => filesAtCommit(cwd, 'HEAD', d)),
    labels: dirs,
    // LODE_UA lets Lode's own test runs mark themselves (e.g. lode-guard-test) so they're left out of Lode's figures
    read: lodeReader({ fetchImpl, base: env.LODE_BASE || 'https://trylode.io', ua: env.LODE_UA || GUARD_UA }),
  });
  const commenting = yes(env.INPUT_COMMENT, true) && env.GITHUB_TOKEN && env.GITHUB_REPOSITORY && pr.number;
  if (result.quiet) {
    log('No known integration added or removed. Nothing to report.');
    // An earlier comment from this Action would now be out of date
    if (commenting) {
      try { if (await upsertComment({ token: env.GITHUB_TOKEN, repo: env.GITHUB_REPOSITORY, number: pr.number, body: `${MARKER}\nLode: no known integration is added or removed by this pull request now.`, fetchImpl, onlyIfExists: true })) log('Earlier comment updated.'); }
      catch (e) { log(`Could not update the earlier comment (${e.message}).`); }
    }
    return { action: 'quiet' };
  }
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${result.report.text}\n`);
  log(result.report.title);
  if (commenting) {
    try { await upsertComment({ token: env.GITHUB_TOKEN, repo: env.GITHUB_REPOSITORY, number: pr.number, body: result.report.text, fetchImpl }); log('Pull request comment posted.'); }
    catch (e) { log(`Could not post the comment (${e.message}); give the workflow pull-requests: write, or set comment: false. The result is in the job summary.`); }
  }
  return { action: 'reported', added: result.diff.added.map((a) => a.id), removed: result.diff.removed.map((a) => a.id) };
}

if (process.argv[1]?.endsWith('run.mjs')) {
  main().catch((e) => { log(`Lode Integration Guard could not run: ${e.message}. It never blocks a merge.`); process.exit(0); });
}

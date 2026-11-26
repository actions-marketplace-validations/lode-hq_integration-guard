// Lode Integration Guard (D28, LOD-60): the core shared by the GitHub App and the GitHub Action.
//
// What it does: given the 9 config files below at a pull request's base and head, it finds which
// integrations the change adds or removes (matched with Lode's public package list,
// /api/stack-signals.json) and writes a short report of Lode's published facts for them. It is quiet
// when no known integration changes.
//
// What it reads: only the 9 files in FILES (and only the variable NAMES in .env.example are parsed;
// values are never used), plus Lode's public data through a `read` function the caller supplies.
// Nothing is written or sent anywhere by this module. The Action passes a reader that makes GET
// requests for Lode's public /api/ files; the App's server is meant to pass a reader over the data it
// already ships (mcp/bundle.json), so it makes no requests at all. Any future sharing (D28 collection)
// needs Paul's yes, the privacy wording and an explicit opt-in by the installer; it is not in this code.
//
// The parsing and stack logic are the Integration Check skill's own exported functions, so the guard,
// the skill's `stack` command and the MCP tool check_stack give the same answers. In the public repository
// (lode-hq/integration-guard) that file is copied in as lib/vendor/lode.mjs by scripts/guard-export.mjs,
// which rewrites this import. Lode's repository is the source; edit here, then export.
import {
  parsePackageJson, parseRequirements, parsePyproject, parseGemfile, parseGoMod, parseEnvNames,
  detectStack, detectFramework, stackPairs, stackCheck, stackOverlap, priceLine, STACK_NOTE,
} from './vendor/lode.mjs';

// The only files the guard reads. The GitHub App requests single-file read access to exactly these
// paths (GitHub allows up to 10). Keep this list and PERMISSIONS.md the same.
export const FILES = ['package.json', 'requirements.txt', 'pyproject.toml', 'Gemfile', 'go.mod', '.env.example', 'vercel.json', 'netlify.toml', 'supabase/config.toml'];
export const GUARD_NAME = 'Lode Integration Guard';
export const GUARD_UA = 'lode-guard/0.1 (+https://trylode.io/agents/)';
export const MARKER = '<!-- lode-integration-guard -->';
export const TIMEOUT_MS = 15000;
const MAX_RECORDS = 60;
const MAX_TEXT = 60000; // GitHub caps a check run summary at 65,535 characters

const stripBom = (s) => (typeof s === 'string' ? s.replace(/^﻿/, '') : s);
export function jsonOk(text) {
  if (typeof text !== 'string') return true; // a missing file is fine
  try { JSON.parse(stripBom(text)); return true; } catch { return false; }
}

// { 'package.json': '...', ... } (missing files absent or null) -> the manifest shape the skill uses
export function manifestsFrom(files = {}) {
  const t = (p) => (typeof files[p] === 'string' ? stripBom(files[p]) : null);
  const pkg = t('package.json'), req = t('requirements.txt'), py = t('pyproject.toml'), gem = t('Gemfile'), gomod = t('go.mod'), env = t('.env.example');
  return {
    npm: pkg ? parsePackageJson(pkg) : [],
    pypi: [...(req ? parseRequirements(req) : []), ...(py ? parsePyproject(py) : [])],
    gem: gem ? parseGemfile(gem) : [],
    go: gomod ? parseGoMod(gomod) : [],
    env: env ? parseEnvNames(env) : [],
    files: FILES.filter((f) => t(f) !== null),
  };
}

// A package.json that can't be parsed (a merge conflict, a stray character) on one side would look like
// every package was removed or added. Compare that file only when both sides parse; otherwise use the
// same content on both sides and say so.
export function alignUnparsable(baseSets = [], headSets = [], labels = []) {
  const notes = [];
  const base = baseSets.map((s) => ({ ...s })), head = headSets.map((s) => ({ ...s }));
  for (let i = 0; i < Math.max(base.length, head.length); i++) {
    const b = base[i] ?? {}, h = head[i] ?? {};
    const okB = jsonOk(b['package.json']), okH = jsonOk(h['package.json']);
    if (okB && okH) continue;
    const where = labels[i] && labels[i] !== '.' ? `${labels[i]}/package.json` : 'package.json';
    const side = !okB && !okH ? 'at either commit' : !okH ? 'in this pull request' : 'on the base branch';
    notes.push(`${where} couldn't be read as JSON ${side}, so it wasn't compared.`);
    const keep = okH ? h['package.json'] : okB ? b['package.json'] : null;
    if (base[i]) base[i]['package.json'] = keep;
    if (head[i]) head[i]['package.json'] = keep;
  }
  return { baseSets: base, headSets: head, notes };
}

// One or more folders' files -> the known products found, merged by product id
export function detectAll(fileSets = [], signalsDoc = {}) {
  const byId = new Map();
  for (const files of fileSets) {
    for (const a of detectStack(manifestsFrom(files), signalsDoc)) {
      const prev = byId.get(a.id);
      byId.set(a.id, prev ? { ...prev, evidence: [...new Set([...prev.evidence, ...a.evidence])] } : a);
    }
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function frameworkOf(fileSets = []) {
  for (const files of fileSets) { const fw = detectFramework(manifestsFrom(files)); if (fw) return fw; }
  return undefined;
}

export function diffStacks(base = [], head = []) {
  const b = new Set(base.map((a) => a.id)), h = new Set(head.map((a) => a.id));
  return { added: head.filter((a) => !b.has(a.id)), removed: base.filter((a) => !h.has(a.id)), kept: head.filter((a) => b.has(a.id)) };
}

const dmy = (iso) => { const m = String(iso ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : 'date not recorded'; };
const list = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const recordLine = (p, i, rec) => {
  const lim = (rec?.limitations || []).length;
  return `- On ${p.name}: ${p.name} plan needed: ${i.plan_needed}${lim ? `; ${lim} documented limitation${lim === 1 ? '' : 's'}` : ''}. [Lode record](${i.url}), verified ${dmy(i.last_verified)}${i.held ? '. Held: not yet confirmed by Lode' : ''}.`;
};

// Pure: the diff and the stack check for the head stack -> markdown. `unfetched` holds record ids the
// run didn't read (stack too large); an app with one of those is "not checked", never "no record".
export function formatReport({ diff, res, pairs = [], records = [], unfetched = [], notes = [], files = FILES }) {
  if (!diff.added.length && !diff.removed.length) return null;
  const rec = new Map(records.filter(Boolean).map((r) => [r.id, r]));
  const skipped = new Set(unfetched);
  const out = [MARKER];
  const parts = [];
  if (diff.added.length) parts.push(`adds ${list(diff.added.map((a) => a.name))}`);
  if (diff.removed.length) parts.push(`removes ${list(diff.removed.map((a) => a.name))}`);
  const title = `Lode: this pull request ${parts.join(' and ')}`;
  out.push(`### ${title}`);

  const addedIds = new Set();
  for (const a of diff.added) {
    out.push('', `**${a.name}**${a.platform ? ' (a platform Lode covers)' : ''}`);
    if (a.platform) {
      // A platform was added: show what Lode has for the other apps in this repo on it
      const p = res.platforms.find((x) => x.platform === a.platform);
      const others = pairs.filter((x) => x.platform === a.platform);
      if (!p || !others.length) { out.push(`- None of the other apps found here are on ${a.name} in Lode's data.`); continue; }
      for (const i of p.integrations) { addedIds.add(i.id); out.push(recordLine(p, i, rec.get(i.id))); }
      const notChecked = others.filter((x) => x.ids.some((id) => skipped.has(id))).map((x) => x.app);
      const missing = p.not_in_lode.filter((n) => !notChecked.includes(n));
      if (missing.length) out.push(`- Lode has no record on ${a.name} for ${list(missing)}. That means not documented by Lode, not unsupported.`);
      if (notChecked.length) out.push(`- Not checked (too many integrations in this repo for one run): ${list(notChecked)}.`);
      continue;
    }
    const mine = pairs.filter((x) => x.app === a.name);
    const priced = mine.flatMap((m) => m.ids).map((id) => rec.get(id)).filter((r) => (r?.pricing?.plans || []).length)
      .sort((x, y) => (x.lode?.publish_state === 'live' ? 0 : 1) - (y.lode?.publish_state === 'live' ? 0 : 1))[0];
    if (priced) {
      const line = priceLine(priced);
      out.push(`- Price (as recorded by Lode): ${line.length > 200 ? `${line.slice(0, 197)}...` : line} (from the [Lode record](${priced.url}), verified ${dmy(priced.verification?.last_verified)})`);
    }
    let any = false;
    for (const p of res.platforms) {
      for (const i of p.integrations.filter((x) => mine.some((m) => m.platform === p.platform && m.ids.includes(x.id)))) {
        any = true; addedIds.add(i.id); out.push(recordLine(p, i, rec.get(i.id)));
      }
    }
    const notChecked = mine.filter((m) => m.ids.some((id) => skipped.has(id))).map((m) => res.platforms.find((p) => p.platform === m.platform)?.name ?? m.platform);
    if (notChecked.length) out.push(`- Not checked on ${list(notChecked)} (too many integrations in this repo for one run).`);
    if (!any && !notChecked.length) {
      const plats = res.platforms.filter((p) => p.platform !== a.platform).map((p) => p.name);
      out.push(plats.length
        ? `- Lode has no record for ${a.name} on ${list(plats)}. That means not documented by Lode, not unsupported.`
        : `- No other platform Lode covers was found in these files, so there is nothing to check ${a.name} against yet.`);
    }
  }

  // Objects written into a platform by more than one app, only where an added integration is one of them
  for (const p of res.platforms) {
    const mineNames = new Set(p.integrations.filter((i) => addedIds.has(i.id)).map((i) => i.app));
    const shared = (p.overlap?.writes ?? []).filter((w) => w.apps.length > 1 && w.apps.some((x) => mineNames.has(x.app)));
    if (shared.length) {
      out.push('', `**Written into ${p.name} by more than one app in this repo** (from each app's docs):`);
      for (const w of shared.slice(0, 10)) out.push(`- ${w.object}: ${w.apps.map((x) => x.app).join(', ')}`);
    }
  }

  if (diff.removed.length) out.push('', `Removed: ${list(diff.removed.map((a) => a.name))}.`);
  for (const n of notes) out.push('', n);
  out.push('', `<sub>${STACK_NOTE} Read only: ${files.join(', ')} (variable names only from .env.example). Nothing from this repository is stored by Lode. Why these permissions: PERMISSIONS.md in the Lode Integration Guard repository.</sub>`);
  let text = out.join('\n');
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}\n\n(cut short)`;
  return { title: title.slice(0, 250), text };
}

// Lode's public files over HTTPS. GET only, a fixed user agent, a time limit, no credentials.
export function lodeReader({ fetchImpl = globalThis.fetch, base = 'https://trylode.io', ua = GUARD_UA, timeoutMs = TIMEOUT_MS } = {}) {
  const root = String(base).replace(/\/$/, '');
  return async (path) => {
    const res = await fetchImpl(`${root}${path}`, { method: 'GET', headers: { 'user-agent': ua, accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Lode answered HTTP ${res.status} for ${path}`);
    return res.json();
  };
}

// The whole check: files at base and head (one map per folder) -> { quiet, diff, report }
export async function runGuard({ baseSets = [], headSets = [], labels = [], read }) {
  const aligned = alignUnparsable(baseSets, headSets, labels);
  const [signals, index, vendors] = await Promise.all([read('/api/stack-signals.json'), read('/api/index.json'), read('/api/vendors/index.json')]);
  const head = detectAll(aligned.headSets, signals || {});
  const diff = diffStacks(detectAll(aligned.baseSets, signals || {}), head);
  if (!diff.added.length && !diff.removed.length) return { quiet: true, diff, report: null };
  const covered = (index?.ecosystems || []).filter((e) => e.status !== 'planned').map((e) => e.slug);
  const listings = Object.fromEntries((vendors?.vendors || []).map((v) => [v.id, v.integrations || []]));
  const fw = frameworkOf(aligned.headSets);
  const input = { apps: head, platforms: [], ...(fw ? { framework: fw } : {}) };
  const { pairs } = stackPairs(input, { listings, covered });
  // Records for the added apps (and on added platforms) first, then the rest, up to the cap
  const addedNames = new Set(diff.added.map((a) => a.name));
  const addedPlatforms = new Set(diff.added.map((a) => a.platform).filter(Boolean));
  const first = pairs.filter((p) => addedNames.has(p.app) || addedPlatforms.has(p.platform)).flatMap((p) => p.ids);
  const all = [...new Set([...first, ...pairs.flatMap((p) => p.ids)])];
  const ids = all.slice(0, MAX_RECORDS), unfetched = all.slice(MAX_RECORDS);
  const records = (await Promise.all(ids.map((id) => { const [app, eco] = id.split('--'); return read(`/api/integrations/${eco}/${app}.json`); }))).filter(Boolean);
  const res = stackCheck(input, { records, listings, covered, limits: [], names: Object.fromEntries((index?.ecosystems || []).map((e) => [e.slug, e.name])) }, stackOverlap);
  return { quiet: false, diff, report: formatReport({ diff, res, pairs, records, unfetched, notes: aligned.notes }) };
}

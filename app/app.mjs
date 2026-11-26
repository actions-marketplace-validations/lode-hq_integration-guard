// Lode Integration Guard, GitHub App side (D28, LOD-60). Not deployed: the app isn't registered yet.
//
// Permissions it is built for: single-file read on the 9 paths in FILES, checks write, metadata read.
// On a check suite for a pull request it reads those files at the base and head commits, runs the
// shared guard and, only when a known integration is added or removed, creates one check run with a
// neutral conclusion (it never blocks a merge). It stores nothing and sends nothing about the repo to
// Lode: the only Lode calls are GET requests for public /api/ files.
//
// To confirm with the private test app before relying on it (see TEST-APP.md):
//  - single-file access reads these paths at any commit, not only the default branch;
//  - check_suite events arrive with Checks permission alone and carry pull_requests[0].base.sha.
// Known limits (TEST-APP.md): a branch pushed before its pull request is opened is compared with the
// default branch tip (a pull request into another branch is compared with the default branch too); pull requests from forks carry no pull_requests
// entry and are not checked; base.sha is the base branch tip, so a base branch that gained an
// integration after the branch was cut can show as "removes".
//
// The HTTP entrypoint (not written yet; it goes live only with Paul's yes) must verify the signature on
// the raw body with verifySignature, answer GitHub within 10 seconds and do the work after, never log
// the payload, and pass `read` over the bundled data (mcp/bundle.json) so no request to Lode is made.
import { createHmac, createSign, timingSafeEqual } from 'node:crypto';
import { FILES, GUARD_NAME, GUARD_UA, TIMEOUT_MS, runGuard, lodeReader } from '../lib/guard.mjs';

const GH = 'https://api.github.com';
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

// GitHub signs each webhook with the app's webhook secret (header X-Hub-Signature-256: sha256=<hex>)
export function verifySignature(secret, rawBody, header) {
  if (!secret || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const want = Buffer.from(`sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`);
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}

// The app's own short-lived JWT (RS256), used only to ask GitHub for an installation token
export function appJwt(appId, privateKeyPem, now = Date.now()) {
  const iat = Math.floor(now / 1000) - 60;
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iat, exp: iat + 540, iss: String(appId) }));
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKeyPem);
  return `${head}.${body}.${b64url(sig)}`;
}

async function gh(fetchImpl, path, { token, method = 'GET', body, accept = 'application/vnd.github+json' } = {}) {
  const res = await fetchImpl(`${GH}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept, 'user-agent': GUARD_UA, 'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return res;
}

// The token is limited to the one repository the event is about
export async function installationToken(fetchImpl, { appId, privateKey, installationId, repositoryId, now }) {
  const res = await gh(fetchImpl, `/app/installations/${installationId}/access_tokens`, { token: appJwt(appId, privateKey, now), method: 'POST', body: repositoryId ? { repository_ids: [repositoryId] } : {} });
  if (!res.ok) throw new Error(`GitHub refused an installation token (HTTP ${res.status})`);
  return (await res.json()).token;
}

// Reads only the paths in FILES at one commit. A missing file is null.
export async function readFiles(fetchImpl, { owner, repo, ref, token }) {
  const out = {};
  for (const path of FILES) {
    const res = await gh(fetchImpl, `/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`, { token, accept: 'application/vnd.github.raw+json' });
    if (res.status === 404) { out[path] = null; continue; }
    if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status} reading ${path}`);
    out[path] = await res.text();
  }
  return out;
}

// Which commits to compare, from a webhook. Only pull requests; anything else is ignored.
export function commitsFrom(name, payload) {
  if (name === 'check_suite' && ['requested', 'rerequested'].includes(payload?.action)) {
    const cs = payload.check_suite, pr = cs?.pull_requests?.[0];
    if (!cs?.head_sha) return null;
    if (pr?.base?.sha) return { base: pr.base.sha, head: cs.head_sha };
    // A branch pushed before its pull request is opened (the usual order; confirmed live 26-11-2026) arrives
    // with no pull_requests. Compare it with the default branch tip instead; the check sits on the commit, so
    // it shows on the pull request when that opens. Pushes to the default branch itself are ignored.
    const def = payload.repository?.default_branch;
    if (cs.head_branch && def && cs.head_branch !== def && !(cs.pull_requests?.length)) return { base: def, head: cs.head_sha, against: 'default-branch' };
    return null;
  }
  // Only reachable if the Pull requests permission is ever granted (a decision for Paul; not designed in)
  if (name === 'pull_request' && ['opened', 'synchronize', 'reopened'].includes(payload?.action)) {
    const pr = payload.pull_request;
    if (!pr?.base?.sha || !pr?.head?.sha) return null;
    return { base: pr.base.sha, head: pr.head.sha };
  }
  return null;
}

// One webhook in -> at most one check run out. Returns what it did, for logs and tests.
export async function handleEvent({ name, payload }, { appId, privateKey, fetchImpl = globalThis.fetch, lodeBase, read, now } = {}) {
  const commits = commitsFrom(name, payload);
  if (!commits) return { action: 'ignored' };
  const owner = payload.repository?.owner?.login, repo = payload.repository?.name, installationId = payload.installation?.id;
  if (!owner || !repo || !installationId) return { action: 'ignored' };
  const token = await installationToken(fetchImpl, { appId, privateKey, installationId, repositoryId: payload.repository?.id, now });
  const [baseFiles, headFiles] = await Promise.all([readFiles(fetchImpl, { owner, repo, ref: commits.base, token }), readFiles(fetchImpl, { owner, repo, ref: commits.head, token })]);
  const result = await runGuard({ baseSets: [baseFiles], headSets: [headFiles], read: read ?? lodeReader({ fetchImpl, base: lodeBase }) });
  if (result.quiet) return { action: 'quiet' };
  const res = await gh(fetchImpl, `/repos/${owner}/${repo}/check-runs`, {
    token, method: 'POST',
    body: { name: GUARD_NAME, head_sha: commits.head, status: 'completed', conclusion: 'neutral', output: { title: result.report.title, summary: result.report.text } },
  });
  if (!res.ok) throw new Error(`GitHub refused the check run (HTTP ${res.status})`);
  return { action: 'check-run', added: result.diff.added.map((a) => a.id), removed: result.diff.removed.map((a) => a.id) };
}

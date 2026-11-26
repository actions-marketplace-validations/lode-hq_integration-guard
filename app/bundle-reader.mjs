// Lode Integration Guard, GitHub App side (LOD-60): answers the guard's reads of Lode's public files
// (/api/stack-signals.json, /api/index.json, /api/vendors/index.json, /api/integrations/{eco}/{app}.json)
// from data the server already holds, so the App makes no request to Lode at all. The shapes match the
// public files: Lode's site and its MCP server build both from the same records (mcp/bundle.json holds
// the public view of every record the site shows).
export function bundleReader({ bundle, signals }) {
  const views = bundle.views ?? {};
  const byId = new Map((bundle.records ?? []).map((r) => [r.id, views[r.id] ?? r]));
  const files = {
    '/api/stack-signals.json': signals,
    '/api/index.json': { ecosystems: (bundle.ecosystems ?? []).map((e) => ({ slug: e.slug, name: e.name, status: e.status })) },
    '/api/vendors/index.json': {
      vendors: (bundle.vendors ?? []).map((v) => ({ id: v.id, name: v.name, integrations: Object.values(v.marketplaces ?? {}).flat().map((m) => m.integration_id) })),
    },
  };
  return async (path) => {
    if (files[path]) return files[path];
    const m = String(path).match(/^\/api\/integrations\/([^/]+)\/([^/]+)\.json$/);
    return m ? byId.get(`${m[2]}--${m[1]}`) ?? null : null;
  };
}

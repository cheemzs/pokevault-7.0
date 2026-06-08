// api/pokeprice.js
// Vercel serverless proxy for PokémonPriceTracker API v2.
//
// Required env vars (set in Vercel dashboard):
//   POKEPRICE_API_KEY      — PokémonPriceTracker API bearer token
//   SUPABASE_URL           — your Supabase project URL
//   SUPABASE_SERVICE_KEY   — Supabase service_role key (never sent to client)

const BASE = 'https://www.pokemonpricetracker.com/api/v2';

// ── Supabase cache writer (fire-and-forget, never blocks the response) ────────
async function sbInsertCacheRows(rows) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key || !rows.length) return;
  try {
    await fetch(`${url}/rest/v1/price_history_cache`, {
      method: 'POST',
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=ignore-duplicates',
      },
      body: JSON.stringify(rows),
    });
  } catch (e) {
    console.warn('Supabase cache write failed (non-fatal):', e.message);
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS — allows the browser to call /api/pokeprice from the same Vercel domain
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.POKEPRICE_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'POKEPRICE_API_KEY is not set in Vercel environment variables.' });

  const headers = { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' };

  const {
    action,
    name,
    set,
    id,
    language,
    days,
    includeHistory,
    includeEbay,
  } = req.query;

  const lang        = language === 'japanese' ? 'japanese' : 'english';
  const historyDays = parseInt(days, 10) || 0;
  const wantHistory = includeHistory === 'true' && historyDays > 0;
  const wantEbay    = includeEbay === 'true';
  const today       = new Date().toISOString().split('T')[0];

  // Build upstream query params
  function baseParams(searchStr) {
    const p = new URLSearchParams({ language: lang });
    if (searchStr)   p.set('search', searchStr);
    if (wantHistory) { p.set('includeHistory', 'true'); p.set('days', String(historyDays)); }
    if (wantEbay)    p.set('includeEbay', 'true');
    return p;
  }

  // Normalise API response shape to a flat results array
  function toResults(data) {
    return Array.isArray(data.data) ? data.data : (data.data ? [data.data] : []);
  }

  // Extract the best available price from a result object
  function extractPrice(r) {
    return r.prices?.market    ?? r.prices?.lowPrice ?? r.prices?.midPrice
        ?? r.japanesePrice     ?? r.averagePrice     ?? r.marketPrice
        ?? r.price             ?? null;
  }

  // Write price snapshots to Supabase cache — non-blocking
  function cacheResults(results, type) {
    const rows = results
      .map(r => {
        const price  = type === 'sealed' ? (r.unopenedPrice ?? null) : extractPrice(r);
        const itemId = String(r.tcgPlayerId || r.id || r.productId || '').trim();
        if (price == null || !itemId) return null;
        return { item_id: itemId, type, price: Number(price), language: lang, recorded_date: today };
      })
      .filter(Boolean);
    if (rows.length) sbInsertCacheRows(rows); // intentionally not awaited
  }

  // ── action=search  (card name / set search) ───────────────────────────────
  if (action === 'search') {
    if (!name) return res.status(400).json({ error: 'Missing param: name' });
    const searchStr = set ? `${name.trim()} ${set.trim()}` : name.trim();
    const params = baseParams(searchStr);
    params.set('limit', '20');
    try {
      const upstream = await fetch(`${BASE}/cards?${params}`, { headers });
      const body = await upstream.text();
      if (!upstream.ok) return res.status(upstream.status).json({ error: 'Upstream error', detail: body });
      const data    = JSON.parse(body);
      const results = toResults(data);
      cacheResults(results, 'card');
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
      return res.status(200).json({ results, metadata: data.metadata ?? {} });
    } catch (err) {
      return res.status(500).json({ error: 'Fetch failed', detail: err.message });
    }
  }

  // ── action=bynumber  (exact card number, e.g. 199/165) ───────────────────
  if (action === 'bynumber') {
    if (!name) return res.status(400).json({ error: 'Missing param: name (card number)' });
    const params = baseParams(name.trim());
    params.set('limit', '30');
    if (set) params.set('set', set.trim());
    try {
      const upstream = await fetch(`${BASE}/cards?${params}`, { headers });
      const body = await upstream.text();
      if (!upstream.ok) return res.status(upstream.status).json({ error: 'Upstream error', detail: body });
      const data = JSON.parse(body);
      const all  = toResults(data);
      const num  = name.trim().toLowerCase();
      // Prefer exact number match; fall back to full result set if nothing matches
      const matched = all.filter(r => {
        const cn   = (r.cardNumber || '').toLowerCase();
        const full = `${cn}/${r.totalSetNumber || ''}`.toLowerCase();
        return cn === num || full === num || full.startsWith(num + '/');
      });
      const results = matched.length ? matched : all;
      cacheResults(results, 'card');
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
      return res.status(200).json({ results, metadata: data.metadata ?? {} });
    } catch (err) {
      return res.status(500).json({ error: 'Fetch failed', detail: err.message });
    }
  }

  // ── action=sealed  (sealed products — MUST use /sealed-products endpoint) ─
  if (action === 'sealed') {
    const params = baseParams(name ? name.trim() : undefined);
    params.set('limit', '20');
    if (set) params.set('set', set.trim());
    try {
      // NOTE: endpoint is /sealed-products, NOT /sealed
      const upstream = await fetch(`${BASE}/sealed-products?${params}`, { headers });
      const body = await upstream.text();
      if (!upstream.ok) return res.status(upstream.status).json({ error: 'Upstream error', detail: body });
      const data    = JSON.parse(body);
      const results = toResults(data);
      cacheResults(results, 'sealed');
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
      return res.status(200).json({ results, metadata: data.metadata ?? {} });
    } catch (err) {
      return res.status(500).json({ error: 'Fetch failed', detail: err.message });
    }
  }

  // ── action=card  (single card by TCGPlayer ID) ────────────────────────────
  if (action === 'card') {
    if (!id) return res.status(400).json({ error: 'Missing param: id' });
    const params = baseParams();
    params.set('tcgPlayerId', id.trim());
    try {
      const upstream = await fetch(`${BASE}/cards?${params}`, { headers });
      const body = await upstream.text();
      if (!upstream.ok) return res.status(upstream.status).json({ error: 'Upstream error', detail: body });
      const data    = JSON.parse(body);
      const results = toResults(data);
      cacheResults(results, 'card');
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
      return res.status(200).json({ results, metadata: data.metadata ?? {} });
    } catch (err) {
      return res.status(500).json({ error: 'Fetch failed', detail: err.message });
    }
  }

  return res.status(400).json({ error: 'Invalid action. Valid values: search | bynumber | sealed | card' });
}

/**
 * Restock ETA API – uses SOS Inventory v2 API.
 * GET ?sku=XXX → { "eta": "YYYY-MM-DD" } or { "eta": null }
 *
 * Response shape (SOS v2):
 * - Item: itemRaw.data[] and optionally matchedItem (from item?search=sku).
 * - POs: purchaseorder?itemId=X returns body with data[] (not purchaseOrders).
 * - PO date: expectedDate or date.
 */

const SOS_API_BASE = process.env.SOS_API_BASE || 'https://api.sosinventory.com/api/v2';
const SOS_AUTH_HEADER = process.env.SOS_AUTH_HEADER || '';

function getAuthHeader() {
  const raw = (SOS_AUTH_HEADER || '').trim();
  if (raw.toLowerCase().startsWith('bearer ')) return raw;
  if (raw) return `Bearer ${raw}`;
  return '';
}

async function fetchSOS(path) {
  const url = `${SOS_API_BASE.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
  const auth = getAuthHeader();
  if (!auth) {
    throw new Error('SOS_AUTH_HEADER is not set');
  }
  const res = await fetch(url, {
    headers: {
      Authorization: auth,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SOS API error ${res.status}: ${text}`);
  }
  return res.json();
}

/** Time an async fn and return { result, ms }. Logs to console for Vercel. */
async function timed(label, fn) {
  const start = Date.now();
  const result = await fn();
  const ms = Date.now() - start;
  console.log(`[SOS timing] ${label}: ${ms}ms`);
  return { result, ms };
}

/**
 * Resolve item by SKU. Uses matchedItem when present, else finds in itemRaw.data or data[] by sku.
 */
function getItemFromItemResponse(body, sku) {
  const targetSku = (sku || '').trim().toUpperCase();
  if (!targetSku) return null;

  if (body.matchedItem && String((body.matchedItem.sku || '')).trim().toUpperCase() === targetSku) {
    return body.matchedItem;
  }
  // Single item response (e.g. item?id=X)
  if (body.sku && String((body.sku || '')).trim().toUpperCase() === targetSku) {
    return body;
  }
  const data = body.itemRaw?.data ?? body.data;
  if (Array.isArray(data)) {
    const found = data.find(
      (it) => String((it.sku || '')).trim().toUpperCase() === targetSku
    );
    if (found) return found;
  }
  return null;
}

/**
 * Filter POs to only those that have this item on at least one line.
 * SOS may return the same PO list for every itemId; filtering by lines ensures we use the right POs.
 */
function filterPOsByItemId(poResponse, itemId) {
  const list = poResponse.data || poResponse.poRaw?.data || poResponse.purchaseOrders || [];
  if (!Array.isArray(list) || !itemId) return list;
  return list.filter((po) => {
    const lines = po.lines || [];
    return lines.some((line) => (line.item && (line.item.id === itemId || line.item.id == itemId)));
  });
}

/**
 * Get earliest ETA from PO list. POs are in response.data (SOS v2).
 * Uses expectedDate first, then date; ignores deleted/past as needed.
 * Returns { eta, debugDates } when debugDates requested.
 */
function getEarliestEtaFromPOs(poListOrResponse, options = {}) {
  const list = Array.isArray(poListOrResponse)
    ? poListOrResponse
    : (poListOrResponse.data || poListOrResponse.poRaw?.data || poListOrResponse.purchaseOrders || []);
  if (!Array.isArray(list) || list.length === 0) {
    return options.debug ? { eta: null, debugDates: [], poCount: 0 } : null;
  }

  const now = new Date();
  let earliest = null;
  const debugDates = [];

  for (const po of list) {
    if (po.deleted) continue;
    const dateStr = po.expectedDate ?? po.expectedShip ?? po.date ?? po.shipDate;
    if (options.debug) {
      debugDates.push({
        poId: po.id,
        number: po.number,
        date: dateStr || null,
        expectedDate: po.expectedDate || null,
      });
    }
    if (!dateStr) continue;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) continue;
    if (d < now) continue; // skip past dates
    if (!earliest || d < earliest) earliest = d;
  }

  const eta = earliest ? earliest.toISOString().slice(0, 10) : null;
  if (options.debug) {
    return { eta, debugDates, poCount: list.length };
  }
  return eta;
}

/**
 * Get ETA for a single SKU. Returns { eta, debug? }. Used by single and batch endpoints.
 * Item lookup: run exact + first search page in parallel to minimize round-trips; cap fallback pages.
 */
async function getEtaForSku(sku, options = {}) {
  const debug = options.debug === true;
  const skuTrim = (sku || '').trim();
  if (!skuTrim) return { eta: null };

  const encodedSku = encodeURIComponent(skuTrim);
  const pageSize = 500;
  const maxFallbackPages = 2; // only 2 extra search pages for speed (500 + 500 + 500 = 1500 items max)
  const timing = { itemParallelMs: 0, itemFallbackMs: 0, purchaseOrderMs: 0, totalMs: 0 };
  const totalStart = Date.now();

  // 1) Item by SKU – run exact and first search page in parallel (2 round-trips in parallel, not sequential)
  let item = null;
  const { result: parallelResults, ms: itemParallelMs } = await timed('item_lookup_parallel', () =>
    Promise.all([
      fetchSOS(`item?sku=${encodedSku}`).catch(() => null),
      fetchSOS(`item?search=${encodedSku}&start=0&maxresults=${pageSize}`).catch(() => null),
    ])
  );
  timing.itemParallelMs = itemParallelMs;
  const [exactRes, firstSearchRes] = parallelResults;
  if (exactRes) item = getItemFromItemResponse(exactRes, skuTrim);
  if (!item && firstSearchRes) item = getItemFromItemResponse(firstSearchRes, skuTrim);

  // 2) If still not found, try at most maxFallbackPages more search pages (sequential but capped)
  let itemFallbackMs = 0;
  for (let p = 1; p <= maxFallbackPages && !item; p++) {
    const start = p * pageSize;
    const { result: searchRes, ms } = await timed(`item_search_page_${p}`, () =>
      fetchSOS(`item?search=${encodedSku}&start=${start}&maxresults=${pageSize}`)
    );
    itemFallbackMs += ms;
    item = getItemFromItemResponse(searchRes, skuTrim);
  }
  timing.itemFallbackMs = itemFallbackMs;

  if (!item || !item.id) {
    timing.totalMs = Date.now() - totalStart;
    console.log(`[SOS timing] sku=${skuTrim} total=${timing.totalMs}ms`, JSON.stringify(timing));
    const out = { eta: null };
    if (debug) out.debug = { resolvedItem: null, message: 'No item found for this SKU', timing };
    return out;
  }

  // 3) POs for this item – filter by line item so we only use POs that actually contain this SKU
  const { result: poRes, ms: purchaseOrderMs } = await timed('purchaseorder', () =>
    fetchSOS(`purchaseorder?itemId=${item.id}`)
  );
  timing.purchaseOrderMs = purchaseOrderMs;
  timing.totalMs = Date.now() - totalStart;
  console.log(`[SOS timing] sku=${skuTrim} total=${timing.totalMs}ms`, JSON.stringify(timing));
  const rawList = poRes.data || poRes.poRaw?.data || poRes.purchaseOrders || [];
  const posForItem = filterPOsByItemId(poRes, item.id);
  const listToUse = posForItem.length > 0 ? posForItem : rawList;
  const result = getEarliestEtaFromPOs(listToUse, { debug });

  const eta = typeof result === 'object' ? result.eta : result;
  const out = { eta };
  if (debug) {
    out.debug = {
      requestedSku: skuTrim,
      resolvedItemId: item.id,
      resolvedItemSku: item.sku || null,
      resolvedItemName: item.name || null,
      rawPoCount: rawList.length,
      posWithItemOnLine: posForItem.length,
      poCountUsed: typeof result === 'object' ? result.poCount : undefined,
      poDates: typeof result === 'object' ? result.debugDates : undefined,
      timing,
    };
  }
  return out;
}

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed', eta: null });
  }

  const sku = (req.query.sku || '').trim();
  const debug = req.query.debug === '1' || req.query.debug === 'true';
  if (!sku) {
    return res.status(400).json({ error: 'Missing sku', eta: null });
  }

  try {
    const out = await getEtaForSku(sku, { debug });
    return res.status(200).json(out);
  } catch (err) {
    console.error('restock-eta error:', err.message);
    return res.status(500).json({
      error: err.message || 'Server error',
      eta: null,
    });
  }
}

module.exports = handler;
module.exports.getEtaForSku = getEtaForSku;

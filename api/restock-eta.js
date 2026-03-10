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

module.exports = async function handler(req, res) {
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
    // 1) Item by SKU – try exact sku= first, then search with pagination (item may not be in first 200)
    let item = null;
    try {
      const exactRes = await fetchSOS(`item?sku=${encodeURIComponent(sku)}`);
      item = getItemFromItemResponse(exactRes, sku);
    } catch (_) {
      // item?sku= may 404 or not exist; fall back to search
    }
    if (!item) {
      let start = 0;
      const pageSize = 200;
      const maxPages = 70; // ~14k items
      for (let p = 0; p < maxPages; p++) {
        const searchRes = await fetchSOS(
          `item?search=${encodeURIComponent(sku)}&start=${start}&maxresults=${pageSize}`
        );
        item = getItemFromItemResponse(searchRes, sku);
        if (item) break;
        const raw = searchRes.itemRaw || searchRes;
        const count = raw.count ?? raw.data?.length ?? 0;
        const totalCount = raw.totalCount ?? 0;
        if (count === 0 || (totalCount > 0 && start + count >= totalCount)) break;
        start += pageSize;
      }
    }
    if (!item || !item.id) {
      const out = { eta: null };
      if (debug) out.debug = { resolvedItem: null, message: 'No item found for this SKU' };
      return res.status(200).json(out);
    }

    // 2) POs for this item – filter by line item so we only use POs that actually contain this SKU
    const poRes = await fetchSOS(`purchaseorder?itemId=${item.id}`);
    const rawList = poRes.data || poRes.poRaw?.data || poRes.purchaseOrders || [];
    const posForItem = filterPOsByItemId(poRes, item.id);
    // If no POs have lines (or none match), API may have already filtered by itemId – use raw list
    const listToUse = posForItem.length > 0 ? posForItem : rawList;
    const result = getEarliestEtaFromPOs(listToUse, { debug });

    const eta = typeof result === 'object' ? result.eta : result;
    const out = { eta };
    if (debug) {
      out.debug = {
        requestedSku: sku,
        resolvedItemId: item.id,
        resolvedItemSku: item.sku || null,
        resolvedItemName: item.name || null,
        rawPoCount: rawList.length,
        posWithItemOnLine: posForItem.length,
        poCountUsed: typeof result === 'object' ? result.poCount : undefined,
        poDates: typeof result === 'object' ? result.debugDates : undefined,
      };
    }

    return res.status(200).json(out);
  } catch (err) {
    console.error('restock-eta error:', err.message);
    return res.status(500).json({
      error: err.message || 'Server error',
      eta: null,
    });
  }
}

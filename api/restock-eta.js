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
 * Get earliest ETA from PO list. POs are in response.data (SOS v2).
 * Uses expectedDate first, then date; ignores deleted/past as needed.
 */
function getEarliestEtaFromPOs(poResponse) {
  const list = poResponse.data || poResponse.poRaw?.data || poResponse.purchaseOrders || [];
  if (!Array.isArray(list) || list.length === 0) return null;

  const now = new Date();
  let earliest = null;

  for (const po of list) {
    if (po.deleted) continue;
    const dateStr = po.expectedDate ?? po.expectedShip ?? po.date ?? po.shipDate;
    if (!dateStr) continue;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) continue;
    if (d < now) continue; // optional: skip past dates
    if (!earliest || d < earliest) earliest = d;
  }

  if (!earliest) return null;
  return earliest.toISOString().slice(0, 10); // YYYY-MM-DD
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
      return res.status(200).json({ eta: null });
    }

    // 2) POs for this item – SOS v2 returns data[] (not purchaseOrders)
    const poRes = await fetchSOS(`purchaseorder?itemId=${item.id}`);
    const eta = getEarliestEtaFromPOs(poRes);

    return res.status(200).json({ eta });
  } catch (err) {
    console.error('restock-eta error:', err.message);
    return res.status(500).json({
      error: err.message || 'Server error',
      eta: null,
    });
  }
}

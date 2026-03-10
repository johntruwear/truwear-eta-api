/**
 * Batch Restock ETA API – one request for many SKUs.
 * GET ?skus=SKU1,SKU2,SKU3 or POST body { "skus": ["SKU1","SKU2","SKU3"] }
 * Response: { "SKU1": "YYYY-MM-DD", "SKU2": null, "SKU3": "YYYY-MM-DD" }
 * ETAs are resolved in parallel for speed.
 */

const { getEtaForSku } = require('./restock-eta');

function parseSkus(req) {
  if (req.method === 'POST' && req.body && Array.isArray(req.body.skus)) {
    return req.body.skus.map((s) => (s != null ? String(s).trim() : '')).filter(Boolean);
  }
  const q = (req.query.skus || '').trim();
  if (!q) return [];
  return q.split(',').map((s) => s.trim()).filter(Boolean);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const skus = parseSkus(req);
  if (skus.length === 0) {
    return res.status(400).json({ error: 'Missing skus (GET ?skus=A,B,C or POST {"skus":["A","B","C"]})' });
  }

  // De-duplicate and preserve order for consistent response keys
  const unique = [...new Set(skus)];
  const limit = 100; // cap to avoid timeouts
  const toFetch = unique.slice(0, limit);

  try {
    const results = await Promise.all(
      toFetch.map((sku) =>
        getEtaForSku(sku).then((r) => ({ sku, eta: r.eta })).catch(() => ({ sku, eta: null }))
      )
    );
    const bySku = {};
    results.forEach(({ sku, eta }) => {
      bySku[sku] = eta;
    });
    return res.status(200).json(bySku);
  } catch (err) {
    console.error('restock-eta-batch error:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
};

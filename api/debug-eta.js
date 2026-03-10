// api/debug-eta.js
// Debug SOS v2 item + purchaseorder responses for a SKU

export default async function handler(req, res) {
  const { sku } = req.query;
  if (!sku) {
    res.status(400).json({ error: 'sku required' });
    return;
  }

  const base = process.env.SOS_API_BASE;
  const authHeader = process.env.SOS_AUTH_HEADER;

  if (!base || !authHeader) {
    res.status(500).json({ error: 'SOS API not configured' });
    return;
  }

  try {
    // 1) Get items by search (v2 uses data[])
    const itemRes = await fetch(
      `${base}/item?search=${encodeURIComponent(sku)}`,
      {
        headers: {
          'Authorization': authHeader,
          'Accept': 'application/json',
          'Host': 'api.sosinventory.com'
        }
      }
    );

    const itemText = await itemRes.text();
    let itemJson = null;
    try {
      itemJson = JSON.parse(itemText);
    } catch {
      // leave as text
    }

    let matchedItem = null;

    if (itemRes.ok && itemJson && Array.isArray(itemJson.data)) {
      matchedItem = itemJson.data.find((it) => it.sku === sku) || null;
    }

    let poJson = null;
    let poText = null;

    if (matchedItem && matchedItem.id) {
      const poRes = await fetch(
        `${base}/purchaseorder?itemId=${encodeURIComponent(matchedItem.id)}`,
        {
          headers: {
            'Authorization': authHeader,
            'Accept': 'application/json',
            'Host': 'api.sosinventory.com'
          }
        }
      );

      poText = await poRes.text();
      try {
        poJson = JSON.parse(poText);
      } catch {
        // leave as text
      }
    }

    res.status(200).json({
      sku,
      matchedItem,
      itemRaw: itemJson || itemText,
      poRaw: poJson || poText
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'debug_error' });
  }
}

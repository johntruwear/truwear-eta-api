   // api/restock-eta.js
   // Vercel serverless function to return earliest restock ETA for a SKU from SOS Inventory

   export default async function handler(req, res) {
     if (req.method !== 'GET') {
       res.status(405).json({ error: 'Method not allowed' });
       return;
     }

     const { sku } = req.query;
     if (!sku) {
       res.status(400).json({ error: 'sku required' });
       return;
     }

     const base = process.env.SOS_API_BASE;
     const authHeader = process.env.SOS_AUTH_HEADER;

     if (!base || !authHeader) {
       res.status(500).json({ error: 'SOS API not configured', eta: null });
       return;
     }

     try {
       // 1) Look up item by SKU (assumes SOS v2 uses `code` as SKU)
       const itemRes = await fetch(
         `${base}/item?code=${encodeURIComponent(sku)}`,
         {
           headers: {
             'Authorization': authHeader,
             'Accept': 'application/json',
             'Host': 'api.sosinventory.com'
           }
         }
       );

       if (!itemRes.ok) {
         console.error('Item lookup failed', await itemRes.text());
         return res.status(200).json({ eta: null });
       }

       const itemJson = await itemRes.json();
       const item = itemJson.items && itemJson.items[0];
       if (!item || !item.id) {
         return res.status(200).json({ eta: null });
       }

       // 2) Fetch open purchase orders that include this item
       const poRes = await fetch(
         `${base}/purchaseorder?status=Open&itemId=${encodeURIComponent(
           item.id
         )}`,
         {
           headers: {
             'Authorization': authHeader,
             'Accept': 'application/json',
             'Host': 'api.sosinventory.com'
           }
         }
       );

       if (!poRes.ok) {
         console.error('PO lookup failed', await poRes.text());
         return res.status(200).json({ eta: null });
       }

       const poJson = await poRes.json();
       const purchaseOrders = poJson.purchaseOrders || [];
       if (!purchaseOrders.length) {
         return res.status(200).json({ eta: null });
       }

       // 3) Find earliest expectedDate where qty outstanding > 0
       const etas = [];

       for (const po of purchaseOrders) {
         const lines = po.lines || [];
         const line = lines.find((l) => l.item && l.item.id === item.id);
         if (!line) continue;

         const ordered = line.quantity || 0;
         const received = line.quantityReceived || 0;
         const outstanding = ordered - received;

         if (outstanding <= 0) continue;
         if (!po.expectedDate) continue;

         const d = new Date(po.expectedDate);
         if (!Number.isNaN(d.getTime())) {
           etas.push(d);
         }
       }

       if (!etas.length) {
         return res.status(200).json({ eta: null });
       }

       etas.sort((a, b) => a - b);
       const earliest = etas[0].toISOString();

       return res.status(200).json({ eta: earliest });
     } catch (err) {
       console.error('Error in /api/restock-eta', err);
       return res.status(500).json({ eta: null, error: 'internal_error' });
     }
   }

   // api/debug-eta.js
   // Temporary debug endpoint to see raw SOS data for a SKU

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

       const itemText = await itemRes.text();
       let itemJson = null;
       try {
         itemJson = JSON.parse(itemText);
       } catch {
         // leave as text
       }

       let poJson = null;
       let poText = null;

       if (itemRes.ok && itemJson && itemJson.items && itemJson.items[0]) {
         const item = itemJson.items[0];

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

         poText = await poRes.text();
         try {
           poJson = JSON.parse(poText);
         } catch {
           // leave as text
         }
       }

       res.status(200).json({
         sku,
         itemRaw: itemJson || itemText,
         poRaw: poJson || poText
       });
     } catch (e) {
       console.error(e);
       res.status(500).json({ error: 'debug_error' });
     }
   }

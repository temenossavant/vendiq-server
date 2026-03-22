const http = require('http');
const https = require('https');

const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

function handleCORS(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function callAnthropic(payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(data)
      }
    };
    const req = https.request(options, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch (e) { reject(new Error('Bad response from Anthropic')); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  if (handleCORS(req, res)) return;

  if (req.method === 'POST' && req.url === '/api/search') {
    try {
      if (!API_KEY) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'API key not configured on server' }));
        return;
      }
      const body = await readBody(req);
      const { type, query, imageData, mimeType } = body;

      let messages;

      if (type === 'amazon') {
        messages = [{
          role: 'user',
          content: `Search Amazon.com for "${query}". Find the current buy box or average selling price.\n\nReturn ONLY valid JSON, no markdown:\n{"name":"exact product name","price":6.99,"size":"small","confidence":"high"}\n\nsize: small(under 1lb), large(1-3lb), oversized(over 3lb). confidence: high if real listing found, low if estimating.`
        }];
      } else if (type === 'bulk') {
        messages = [{
          role: 'user',
          content: `Search for wholesale/bulk pricing for "${query}". Check Alibaba, Sam's Club, Costco Business, wholesale distributors. Find price per unit buying 50-100+ units.\n\nReturn ONLY valid JSON, no markdown:\n{"price":1.50,"source":"Alibaba","minQty":100,"confidence":"high"}\n\nconfidence: high if real bulk listing found, low if estimating.`
        }];
      } else if (type === 'scan') {
        messages = [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: imageData } },
            { type: 'text', text: 'Read this bulk supplier listing screenshot.\n\nReturn ONLY valid JSON, no markdown:\n{"name":"product name","bulkPrice":2.50,"sellPrice":null,"source":"supplier name","size":"small","confidence":"high"}\n\nbulkPrice = price per unit in bulk. sellPrice = Amazon price if visible, otherwise null. size: small/large/oversized.' }
          ]
        }];
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid type. Use amazon, bulk, or scan.' }));
        return;
      }

      const payload = {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 700,
        messages
      };

      // Add web search for amazon and bulk queries
      if (type === 'amazon' || type === 'bulk') {
        payload.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
      }

      const result = await callAnthropic(payload);
      const text = result.body.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');

      const match = text.replace(/```json|```/g, '').trim().match(/\{[\s\S]*\}/);
      if (!match) throw new Error('No JSON in response');
      const parsed = JSON.parse(match[0]);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, data: parsed }));

    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, keySet: !!API_KEY }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`Vendiq server running on port ${PORT}`);
  console.log(`API key configured: ${!!API_KEY}`);
});

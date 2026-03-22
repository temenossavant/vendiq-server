const http = require('http');
const https = require('https');

const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

function handleCORS(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
  return false;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch(e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// Single API call — web_search_20250305 is server-side, Anthropic runs it automatically
function anthropicCall(payload) {
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
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(new Error('Bad response from Anthropic')); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function extractText(response) {
  if (!response || !response.content) throw new Error('Empty response from API');
  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
  if (!text) throw new Error('No text in response — model may have only used tools');
  return text;
}

function parseJSON(text) {
  const clean = text.replace(/```json|```/g, '').trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON found in response');
  return JSON.parse(match[0]);
}

const MODEL = 'claude-sonnet-4-20250514';
const WEB_SEARCH = [{ type: 'web_search_20250305', name: 'web_search' }];

const server = http.createServer(async (req, res) => {
  if (handleCORS(req, res)) return;

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, keySet: !!API_KEY }));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/search') {
    try {
      if (!API_KEY) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'API key not configured on server' }));
        return;
      }

      const body = await readBody(req);
      const { type, query, imageData, mimeType } = body;

      let response;

      if (type === 'amazon') {
        response = await anthropicCall({
          model: MODEL,
          max_tokens: 1024,
          tools: WEB_SEARCH,
          messages: [{
            role: 'user',
            content: `Search Amazon.com for the current selling price of: "${query}"

Find the buy box price or most common selling price.

Respond with ONLY a JSON object, no other text:
{"name":"full product name","price":6.99,"size":"small","confidence":"high"}

size options: small (under 1 lb), large (1-3 lb), oversized (over 3 lb)
confidence: high if you found a real listing, low if estimating`
          }]
        });

      } else if (type === 'bulk') {
        response = await anthropicCall({
          model: MODEL,
          max_tokens: 1024,
          tools: WEB_SEARCH,
          messages: [{
            role: 'user',
            content: `Search for the wholesale or bulk purchase price for: "${query}"

Check Alibaba, Sam's Club, Costco Business Delivery, or wholesale distributors.
Find the price per unit when buying in bulk (50+ units).

Respond with ONLY a JSON object, no other text:
{"price":1.50,"source":"Alibaba","minQty":100,"confidence":"high"}

confidence: high if you found a real listing, low if estimating`
          }]
        });

      } else if (type === 'scan') {
        if (!imageData) throw new Error('No image data provided');
        response = await anthropicCall({
          model: MODEL,
          max_tokens: 1024,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: imageData }
              },
              {
                type: 'text',
                text: `Look at this product listing image and extract the pricing information.

Respond with ONLY a JSON object, no other text:
{"name":"product name","bulkPrice":2.50,"sellPrice":null,"source":"supplier name","size":"small","confidence":"high"}

bulkPrice = price per unit shown. sellPrice = Amazon/retail price if visible, otherwise null.
size: small (under 1lb), large (1-3lb), oversized (over 3lb)`
              }
            ]
          }]
        });

      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid type. Use: amazon, bulk, or scan.' }));
        return;
      }

      // Log the full response for debugging
      console.log('API response stop_reason:', response.stop_reason);
      console.log('Content types:', (response.content || []).map(b => b.type));

      const text = extractText(response);
      console.log('Extracted text:', text.substring(0, 200));

      const parsed = parseJSON(text);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, data: parsed }));

    } catch (err) {
      console.error('Search error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`Vendiq server running on port ${PORT}`);
  console.log(`API key configured: ${!!API_KEY}`);
});

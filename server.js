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

function apiPost(payload) {
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
        catch(e) { reject(new Error('Bad Anthropic response')); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Handles the full agentic loop — keeps going until Claude
// finishes with text after running web searches
async function runLoop(initialMessages, tools) {
  const messages = [...initialMessages];
  const MAX_TURNS = 6;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const payload = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages
    };
    if (tools) payload.tools = tools;

    const response = await apiPost(payload);
    console.log(`Turn ${turn + 1} — stop_reason: ${response.stop_reason}, content types: ${(response.content || []).map(b => b.type).join(', ')}`);

    if (response.error) {
      throw new Error(`Anthropic error: ${response.error.message}`);
    }

    // Extract any text from this response
    const textBlocks = (response.content || []).filter(b => b.type === 'text');
    const text = textBlocks.map(b => b.text).join('');

    // If we have text and Claude is done, return it
    if (response.stop_reason === 'end_turn' && text) {
      return text;
    }

    // If Claude used a tool (web search), we need to acknowledge and continue
    if (response.stop_reason === 'tool_use') {
      const toolUseBlocks = (response.content || []).filter(b => b.type === 'tool_use');

      // Add assistant turn with what Claude said (including tool use)
      messages.push({ role: 'assistant', content: response.content });

      // Build tool results to send back — for server-side web_search,
      // Anthropic runs the search so we acknowledge each tool_use block
      const toolResults = toolUseBlocks.map(block => ({
        type: 'tool_result',
        tool_use_id: block.id,
        content: 'Search executed. Please provide your final answer as a JSON object.'
      }));

      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // If we have text even without end_turn, return it
    if (text) return text;

    // If Claude stopped for any other reason, try next turn
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: 'Please provide your final answer now as a JSON object only.' });
  }

  throw new Error('Max turns reached without a final text response');
}

function parseJSON(text) {
  const clean = text.replace(/```json|```/g, '').trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON found in response');
  return JSON.parse(match[0]);
}

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
        res.end(JSON.stringify({ ok: false, error: 'API key not configured' }));
        return;
      }

      const body = await readBody(req);
      const { type, query, imageData, mimeType } = body;
      let text;

      if (type === 'amazon') {
        text = await runLoop([{
          role: 'user',
          content: `Search Amazon.com for the current selling price of: "${query}"

Find the buy box price or most common selling price for this product.

You MUST respond with ONLY this JSON object and nothing else:
{"name":"full product name","price":6.99,"size":"small","confidence":"high"}

size: small (under 1lb), large (1-3lb), oversized (over 3lb)
confidence: high if real listing found, low if estimating`
        }], WEB_SEARCH);

      } else if (type === 'bulk') {
        text = await runLoop([{
          role: 'user',
          content: `Search for the wholesale or bulk purchase price for: "${query}"

Check Alibaba, Sam's Club, Costco Business Delivery, or wholesale distributors.
Find the cost per unit when buying 50+ units in bulk.

You MUST respond with ONLY this JSON object and nothing else:
{"price":1.50,"source":"Alibaba","minQty":100,"confidence":"high"}

confidence: high if real listing found, low if estimating`
        }], WEB_SEARCH);

      } else if (type === 'scan') {
        if (!imageData) throw new Error('No image data provided');
        text = await runLoop([{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: imageData } },
            { type: 'text', text: `Extract the pricing from this product listing image.

You MUST respond with ONLY this JSON object and nothing else:
{"name":"product name","bulkPrice":2.50,"sellPrice":null,"source":"supplier name","size":"small","confidence":"high"}

bulkPrice = price per unit. sellPrice = retail/Amazon price if visible, otherwise null.
size: small (under 1lb), large (1-3lb), oversized (over 3lb)` }
          ]
        }], null); // no web search for image scan

      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid type. Use: amazon, bulk, or scan.' }));
        return;
      }

      console.log('Final text:', text.substring(0, 300));
      const parsed = parseJSON(text);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, data: parsed }));

    } catch (err) {
      console.error('Error:', err.message);
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

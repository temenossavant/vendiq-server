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
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

function anthropicRequest(payload) {
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
        catch(e) { reject(new Error('Bad response from Anthropic')); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Handles multi-turn tool use (web search needs 2 round trips)
async function runWithTools(messages, tools, model) {
  const payload = { model, max_tokens: 1024, messages };
  if (tools) payload.tools = tools;

  let result = await anthropicRequest(payload);
  let response = result.body;

  // If Claude wants to use a tool, process the tool call and send results back
  if (response.stop_reason === 'tool_use') {
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    const toolResults = toolUseBlocks.map(block => ({
      type: 'tool_result',
      tool_use_id: block.id,
      content: JSON.stringify(block.input)
    }));

    // Build follow-up conversation with tool results
    const followUpMessages = [
      ...messages,
      { role: 'assistant', content: response.content },
      { role: 'user', content: toolResults }
    ];

    const followUp = await anthropicRequest({
      model,
      max_tokens: 1024,
      messages: followUpMessages,
      tools: tools
    });
    response = followUp.body;
  }

  // Extract final text from response
  const text = (response.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  if (!text) throw new Error('No text in response');
  return text;
}

function parseJSON(text) {
  const match = text.replace(/```json|```/g, '').trim().match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON found in response');
  return JSON.parse(match[0]);
}

const WEB_SEARCH_TOOL = [{ type: 'web_search_20250305', name: 'web_search' }];
const MODEL = 'claude-sonnet-4-20250514';

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
        res.end(JSON.stringify({ ok: false, error: 'API key not set on server' }));
        return;
      }

      const body = await readBody(req);
      const { type, query, imageData, mimeType } = body;
      let text;

      if (type === 'amazon') {
        const messages = [{
          role: 'user',
          content: `Search Amazon.com for the current selling price of: "${query}"\n\nReturn ONLY this JSON (no markdown, no explanation):\n{"name":"exact product name","price":6.99,"size":"small","confidence":"high"}\n\nsize must be: small (under 1lb), large (1-3lb), or oversized (over 3lb).\nconfidence: "high" if you found a real listing, "low" if estimating.`
        }];
        text = await runWithTools(messages, WEB_SEARCH_TOOL, MODEL);

      } else if (type === 'bulk') {
        const messages = [{
          role: 'user',
          content: `Search for wholesale or bulk pricing for: "${query}"\n\nCheck Alibaba, Sam's Club, Costco Business Delivery, and wholesale distributors. Find the price per unit when buying 50-200 units.\n\nReturn ONLY this JSON (no markdown, no explanation):\n{"price":1.50,"source":"Alibaba","minQty":100,"confidence":"high"}\n\nconfidence: "high" if you found a real listing, "low" if estimating.`
        }];
        text = await runWithTools(messages, WEB_SEARCH_TOOL, MODEL);

      } else if (type === 'scan') {
        if (!imageData) throw new Error('No image data provided');
        const messages = [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: imageData } },
            { type: 'text', text: 'Read this bulk supplier listing screenshot and extract the product info.\n\nReturn ONLY this JSON (no markdown, no explanation):\n{"name":"product name","bulkPrice":2.50,"sellPrice":null,"source":"supplier name","size":"small","confidence":"high"}\n\nbulkPrice = price per unit in bulk. sellPrice = Amazon price if visible on screen, otherwise null. size: small/large/oversized.' }
          ]
        }];
        // Image scan doesn't need web search
        text = await runWithTools(messages, null, MODEL);

      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid type. Use: amazon, bulk, or scan.' }));
        return;
      }

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

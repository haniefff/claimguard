'use strict';
/**
 * ClaimGuard — public read-only check endpoint (Wildcard track).
 *
 * POST /v1/check { to, data, value, wallet } — simulates ONE candidate call
 * against BSC (chain 56) using only public read-only JSON-RPC:
 *   1. target must have code on-chain (eth_getCode)
 *   2. wallet balance must be above zero (eth_getBalance, when a wallet is given)
 *   3. eth_call with the exact calldata must succeed
 *
 * Verdicts: ok | wait | fatal. This endpoint NEVER executes a transaction,
 * never signs anything, and holds no keys. It is the ON-CHAIN half of the
 * ClaimGuard gate only: the Binance preview checks (allowance/authority
 * changes, RISK flags, requestId) are NOT covered here and must still run
 * in the CLI gate (fire.js / pi-fire.js) before any execute.
 *
 * Stdlib only — no dependencies. Run: `node endpoint/server.cjs`
 * (PORT env, default 3001).
 */
const http = require('http');

const RPC_URL = process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org/';
const PORT = Number(process.env.PORT || 3001);
const RPC_TIMEOUT_MS = 15000;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const startedAt = Date.now();
let requestCount = 0;

const isAddress = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
const isHex = (v) => typeof v === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(v);

function toHexValue(v) {
  if (v === undefined || v === null || v === '') return '0x0';
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error('value must be a non-negative integer');
    return '0x' + BigInt(v).toString(16);
  }
  if (typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v)) return v;
  if (typeof v === 'string' && /^[0-9]+$/.test(v)) return '0x' + BigInt(v).toString(16);
  throw new Error('value must be a hex string, decimal string, or number');
}

async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error('rpc http ' + res.status);
  const json = await res.json();
  if (json.error) throw new Error('rpc error: ' + (json.error.message || JSON.stringify(json.error)));
  return json.result;
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 65536) return reject(new Error('body too large'));
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleCheck(body) {
  const checks = [];
  let verdict = 'ok';

  const to = body.to;
  const data = body.data === undefined ? '0x' : body.data;
  const wallet = body.wallet === undefined ? null : body.wallet;
  let value;
  try {
    value = toHexValue(body.value);
  } catch (e) {
    return { verdict: 'fatal', checks: [{ name: 'input', pass: false, detail: e.message }], scope: SCOPE };
  }

  if (!isAddress(to)) {
    return { verdict: 'fatal', checks: [{ name: 'input', pass: false, detail: 'to must be a 0x address' }], scope: SCOPE };
  }
  if (!isHex(data)) {
    return { verdict: 'fatal', checks: [{ name: 'input', pass: false, detail: 'data must be 0x hex' }], scope: SCOPE };
  }
  if (wallet !== null && !isAddress(wallet)) {
    return { verdict: 'fatal', checks: [{ name: 'input', pass: false, detail: 'wallet must be a 0x address' }], scope: SCOPE };
  }

  // 1. Target must have code on-chain.
  let code;
  try {
    code = await rpc('eth_getCode', [to, 'latest']);
  } catch (e) {
    return { verdict: 'unknown', checks: [{ name: 'rpc', pass: false, detail: 'eth_getCode failed: ' + e.message }], scope: SCOPE };
  }
  if (code === '0x' || code === '0x0') {
    checks.push({ name: 'target_has_code', pass: false, detail: 'no code at ' + to });
    return { verdict: 'fatal', checks, scope: SCOPE };
  }
  checks.push({ name: 'target_has_code', pass: true, detail: 'code present, ' + (code.length / 2 - 1) + ' bytes' });

  // 2. Wallet balance above zero (only when a wallet is given).
  if (wallet) {
    let bal;
    try {
      bal = await rpc('eth_getBalance', [wallet, 'latest']);
    } catch (e) {
      return { verdict: 'unknown', checks, scope: SCOPE };
    }
    if (BigInt(bal) === 0n) {
      checks.push({ name: 'wallet_balance', pass: false, detail: 'wallet balance is zero' });
      return { verdict: 'wait', checks, scope: SCOPE };
    }
    checks.push({ name: 'wallet_balance', pass: true, detail: 'balance ' + bal + ' wei' });
  }

  // 3. Exact-call simulation must succeed.
  let sim;
  try {
    sim = await rpc('eth_call', [{ from: wallet || ZERO_ADDRESS, to, data, value }, 'latest']);
  } catch (e) {
    checks.push({ name: 'simulation', pass: false, detail: 'eth_call reverted: ' + e.message });
    return { verdict: 'wait', checks, scope: SCOPE };
  }
  checks.push({ name: 'simulation', pass: true, detail: 'eth_call succeeded, return ' + String(sim).slice(0, 66) });

  return { verdict, checks, scope: SCOPE, to, data, value };
}

const SCOPE = 'on-chain simulation only — Binance preview checks (allowance/authority changes, RISK flags, requestId) are NOT covered by this endpoint; run the CLI gate before any execute';

const server = http.createServer(async (req, res) => {
  requestCount++;
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, {
        ok: true,
        service: 'claimguard-check',
        version: '1.0.0',
        uptime_s: Math.floor((Date.now() - startedAt) / 1000),
        requests: requestCount,
        scope: SCOPE,
      });
    }
    if (req.method === 'POST' && req.url === '/v1/check') {
      let raw;
      try {
        raw = await readBody(req);
      } catch (e) {
        return send(res, 400, { verdict: 'fatal', error: e.message });
      }
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        return send(res, 400, { verdict: 'fatal', error: 'invalid JSON' });
      }
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return send(res, 400, { verdict: 'fatal', error: 'body must be a JSON object' });
      }
      const out = await handleCheck(body);
      return send(res, 200, out);
    }
    return send(res, 404, { ok: false, error: 'not found — use GET /health or POST /v1/check' });
  } catch (e) {
    return send(res, 500, { verdict: 'unknown', error: String(e && e.message ? e.message : e) });
  }
});

server.listen(PORT, () => {
  console.log('ClaimGuard check endpoint listening on:' + PORT + ' (POST /v1/check, GET /health)');
});

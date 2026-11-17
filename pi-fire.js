#!/usr/bin/env node
// pi-fire.js — one-shot free Pi seat (mintFree) via Binance Agentic Wallet (baw) on BSC.
// Why not fastmint fire.js: fire.js refuses when balance < value + 0.0003 BNB, and the
// wallet holds 0.00026795 BNB. At ~0.05 gwei the mint costs ~0.00001 BNB gas, so the baw
// preview->execute path works fine (verified: 17:24 WIB preview reached simulation and
// failed only with NotStarted 0x6f312cbd). This script mirrors fire.js safety checks
// (sim spin, preview simCode, no allowance/authority changes, no RISK, outflow cap,
// one broadcast with a shared lock) but without fire.js's 0.0003 BNB reserve gate.
// Never runs auth signin. Never broadcasts twice. --dry stops before execute.
// Usage: node pi-fire.js [--dry] [--timeout 600] [--label pi_free]
'use strict';
const L = require('./lib');
const { ethers, log } = L;
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TO = '0xEADd830D4e0B0C11c5A16D692AeFb4C960dF0fe4'; // PiGenesis
const WALLET = '0xc77F305683F19AD95AB246Aa06f371C6f3792A4e';
const AGENT_ID = 109210569949633609659609415762566109907213210770780038913888244282756082299732n;
const GEN_IFACE = new ethers.Interface([
  'function agentIdOf(address) view returns (uint256,bool)',
  'function freeLeft(uint256) view returns (uint256)',
  'function freeSold() view returns (uint256)',
  'function mintFree(uint256 shares, address inviter) returns (uint256 n)',
  'error NotStarted()', 'error FreeGone()', 'error SoldOut()', 'error AlreadyClaimed()',
  'error SaleClosed()', 'error NoAgentId()', 'error QuotaExceeded()', 'error NoShares()',
]);
const DATA = GEN_IFACE.encodeFunctionData('mintFree', [1, ethers.ZeroAddress]); // shares=1, inviter=0x0
const VALUE_WEI = 0n;
let START = L.parseStart('19:00'); // today 19:00 WIB = 12:00 UTC

const a = process.argv.slice(2);
const o = { timeout: 600, grace: 8, label: 'pi_free', dry: false };
for (let i = 0; i < a.length; i++) {
  const k = a[i]; const nx = () => a[++i];
  if (k === '--dry') o.dry = true;
  else if (k === '--timeout') o.timeout = +nx();
  else if (k === '--grace') o.grace = +nx();
  else if (k === '--start') START = L.parseStart(nx()); // test override only
  else if (k === '--label') o.label = nx();
  else if (k === '-h' || k === '--help') { console.log('usage: node pi-fire.js [--dry] [--timeout 600] [--label pi_free]'); process.exit(0); }
  else { console.error('unknown arg ' + k); process.exit(2); }
}
const die = (m, code = 1) => { log('STOP ' + m); process.exit(code); };

const RUNS = path.join(__dirname, 'runs'); fs.mkdirSync(RUNS, { recursive: true });
const stamp = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 19).replace(/[-:T]/g, '');
L.setLogFile(path.join(RUNS, `${stamp}_${o.label}${o.dry ? '_dry' : ''}.log`));
// Shared lock with fastmint fire.js (same hash scheme) + our own lock, so no second
// process (fire.js or another pi-fire run) can broadcast this exact call.
const lockKey = crypto.createHash('sha256').update([TO.toLowerCase(), DATA.toLowerCase(), VALUE_WEI.toString()].join('|')).digest('hex').slice(0, 16);
const lockFiles = [path.join(RUNS, `lock_${lockKey}.json`), path.join(RUNS, 'lock_pi_free.json')];
const save = (name, obj) => fs.writeFileSync(path.join(RUNS, `${stamp}_${o.label}_${name}.json`), typeof obj === 'string' ? obj : L.safeJson(obj));

let lastHead = { number: 0, ts: 0 };
async function headLoop(stopAt) {
  while (Date.now() < stopAt) {
    try {
      const b = await L.rpc('eth_getBlockByNumber', ['latest', false], { timeoutMs: 2500 });
      const n = parseInt(b.number, 16), ts = parseInt(b.timestamp, 16);
      if (n > lastHead.number) lastHead = { number: n, ts };
    } catch {}
    await L.sleep(250);
  }
}
function simAll(from) {
  const tx = { from, to: TO, data: DATA, value: '0x0' };
  return new Promise(resolve => {
    const jobs = []; for (const u of L.RPCS) for (const tag of ['latest', 'pending']) jobs.push([u, tag]);
    let left = jobs.length, firstRevert = null, done = false;
    const fin = r => { if (!done) { done = true; resolve(r); } };
    setTimeout(() => fin(firstRevert ? { ok: false, ...firstRevert } : { ok: false, transport: true }), 1500);
    for (const [u, tag] of jobs) {
      L.rpcOne(u, 'eth_call', [tx, tag], 1500).then(
        () => fin({ ok: true, url: u, tag }),
        e => { if (L.isRevert(e) && !firstRevert) { firstRevert = { error: e, url: u, tag }; setTimeout(() => fin({ ok: false, ...firstRevert }), 250); } if (--left === 0) fin(firstRevert ? { ok: false, ...firstRevert } : { ok: false, transport: true }); });
    }
  });
}
function nativeOutflowWei(sim) {
  let max = null;
  for (const b of (sim && sim.balanceChanges) || []) {
    const s = JSON.stringify(b).toLowerCase();
    if (!/0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee|"bnb"|native/.test(s)) continue;
    for (const k of ['amount', 'change', 'value', 'delta', 'balanceChange', 'rawAmount']) {
      if (b[k] == null) continue;
      try { let v = String(b[k]); if (/[.eE]/.test(v)) continue; let w = BigInt(v.replace(/^-/, '')); if (max == null || w > max) max = w; } catch {}
    }
  }
  return max;
}
function checkPreview(r) {
  const j = r.json || {};
  if (!r.ok || !j.data) {
    const e = j.error || {};
    const txt = L.safeJson(j.error || r.stdout || r.stderr).slice(0, 600);
    if (e.code === 351803 || /RISK_BLOCKED|risk/i.test(e.name || '')) return { verdict: 'fatal', why: `Binance risk block ${e.code} ${e.name}: ${e.message} — not bypassing` };
    if (e.code === 351802 || /dev.?mode/i.test(txt)) return { verdict: 'fatal', why: 'Developer Mode off/expired (enable in Binance App) ' + txt };
    if (/UNCONNECTED|not.?log|unauth|sign.?in/i.test(txt)) return { verdict: 'fatal', why: 'wallet session problem — do NOT auth signin automatically; ask the user ' + txt };
    return { verdict: L.classify(txt) === 'wait' ? 'wait' : 'unknown', why: 'preview error ' + txt };
  }
  const d = j.data, sim = d.simulationResult || {};
  if (sim.simulationCode !== '000000000') {
    const txt = L.safeJson(sim).slice(0, 600);
    return { verdict: L.classify(txt) === 'wait' ? 'wait' : 'unknown', why: `preview simulationCode ${sim.simulationCode} ${txt}` };
  }
  if ((sim.allowanceChanges || []).length || (sim.authorityChanges || []).length)
    return { verdict: 'fatal', why: 'preview shows allowance/authority changes — not executing ' + L.safeJson({ a: sim.allowanceChanges, au: sim.authorityChanges }) };
  const risks = d.risks || {};
  const hard = (risks.riskDetails || []).filter(x => String(x.riskType).toUpperCase() === 'RISK');
  const addrHard = Object.entries(risks.addresses || {}).filter(([, v]) => (v.riskDetails || []).some(x => String(x.riskType).toUpperCase() === 'RISK'));
  if (hard.length || addrHard.length) return { verdict: 'fatal', why: 'preview RISK flags — needs user review: ' + L.safeJson({ hard, addrHard }) };
  const out = nativeOutflowWei(sim);
  if (out != null && out > ethers.parseEther('0.003')) return { verdict: 'fatal', why: `native outflow ${ethers.formatEther(out)} BNB > 0.003 cap` };
  if (!d.requestId) return { verdict: 'fatal', why: 'no requestId in preview' };
  return { verdict: 'ok', requestId: d.requestId, requireConfirmation: !!d.requireConfirmation, gas: sim.gasTokenFromData, balanceChanges: sim.balanceChanges };
}
async function receipt(hash) {
  const until = Date.now() + 120000;
  while (Date.now() < until) {
    try { const r = await L.rpc('eth_getTransactionReceipt', [hash], { timeoutMs: 3000 }); if (r) return r; } catch {}
    await L.sleep(400);
  }
  return null;
}

(async () => {
  log(`PI-FIRE ${o.label} to=${TO} mintFree(1, 0x0) value=0 BNB data=${DATA}${o.dry ? ' [DRY]' : ''}`);
  log(`start ${START} = ${L.fmtUnix(START)} (in ${((START * 1000 - Date.now()) / 1000).toFixed(0)}s)`);
  if (!o.dry && lockFiles.some(f => fs.existsSync(f))) die('lock exists — this exact call was already executed. Never auto-repeat.');

  // ---- precheck ----
  const [status, addr, settings, warm] = await Promise.all([
    L.bawStatus(), L.bawEvmAddress(), L.baw(['wallet', 'settings']), L.warmRpcs(),
  ]);
  log(`baw status ${status} | from ${addr} | rpc ${warm.map(w => `${new URL(w.u).host}:${w.err ? 'ERR' : w.ms + 'ms#' + w.block}`).join(' ')}`);
  if (status !== 'CONNECTED') die(`baw wallet status = ${status}. Not running auth signin. Ask the user to reconnect.`);
  if (!addr || addr.toLowerCase() !== WALLET.toLowerCase()) die(`wallet address mismatch: ${addr} (expected ${WALLET})`);
  const dm = settings.json && settings.json.data && settings.json.data.devMode;
  if (!dm || !dm.enabled || (dm.expiresAt && Date.parse(dm.expiresAt) < Date.now())) die('Developer Mode is off/expired — user must enable it in the Binance App.');
  log(`devMode on until ${dm.expiresAt}`);
  const [code, bal, gp] = await Promise.all([
    L.rpc('eth_getCode', [TO, 'latest']),
    L.rpc('eth_getBalance', [addr, 'latest']),
    L.rpc('eth_gasPrice', []),
  ]);
  if (!code || code === '0x') die(`${TO} has no code on BSC`);
  const balWei = BigInt(bal);
  log(`balance ${ethers.formatEther(balWei)} BNB | gasPrice ${(Number(BigInt(gp)) / 1e9).toFixed(4)} gwei`);
  if (balWei <= 0n) die('balance is 0 — cannot pay gas');
  // on-chain eligibility (read-only)
  const callView = async (frag, args) => {
    const r = await L.rpc('eth_call', [{ to: TO, data: GEN_IFACE.encodeFunctionData(frag, args) }, 'latest'], { timeoutMs: 8000 });
    return GEN_IFACE.decodeFunctionResult(frag, r);
  };
  const [id, ok] = await callView('agentIdOf', [addr]);
  if (!ok || id !== AGENT_ID) die(`agentIdOf mismatch ok=${ok} id=${id}`);
  const freeLeft = (await callView('freeLeft', [id]))[0];
  const freeSold = (await callView('freeSold'))[0];
  log(`agentId ok, freeLeft=${freeLeft} freeSold=${freeSold}`);
  if (freeLeft === 0n) die('freeLeft = 0 — free seat already taken or gone. Nothing to do.');
  if (freeSold >= 1000n) die('freeSold >= 1000 — free pool sold out. Nothing to do.');

  // ---- wait until start ----
  const startMs = START * 1000;
  const deadline = startMs + o.timeout * 1000;
  headLoop(deadline + 5000);
  if (startMs > Date.now() + 2000) {
    while (Date.now() < startMs - 2000) {
      const left = startMs - 2000 - Date.now();
      if (left > 25000 && left < 27000) { const s = await L.bawStatus(); log(`T-${((startMs - Date.now()) / 1000).toFixed(0)}s baw status ${s}`); if (s !== 'CONNECTED') die('session dropped before start'); }
      await L.sleep(Math.min(1000, Math.max(20, left)));
    }
  }
  log(`spinning eth_call (latest+pending x ${L.RPCS.length} RPCs) head #${lastHead.number} ts ${lastHead.ts}`);

  // ---- spin ----
  let attempt = 0, lastLogName = '', previews = 0, previewInFlight = false;
  for (;;) {
    if (Date.now() > deadline) die(`timeout ${o.timeout}s after start, still not mintable`);
    attempt++;
    let trigger = null;
    const sim = await simAll(addr);
    if (sim.ok) trigger = `eth_call OK (${new URL(sim.url).host} ${sim.tag})`;
    else if (sim.transport) { log('all RPC transport errors'); await L.sleep(250); continue; }
    else {
      const d = await L.decodeRevert(sim.error, GEN_IFACE);
      let c = L.classify(d.name);
      if (c === 'unknown') c = (Date.now() < startMs + o.grace * 1000) ? 'wait' : 'fatal';
      if (Date.now() < startMs && c === 'fatal' && !/sold|gone|already|taken|used|agent|eligible|expired|ended/i.test(d.name)) c = 'wait';
      const nm = `${d.name}${d.sel ? ' ' + d.sel : ''}`;
      if (nm !== lastLogName || attempt % 25 === 0) { log(`sim #${attempt} REVERT ${nm} [${c}] head #${lastHead.number} ts ${lastHead.ts}`); lastLogName = nm; }
      if (c === 'fatal') die(`terminal revert: ${nm}${d.args ? ' ' + d.args.join(',') : ''} — not sending`);
      if (o.eager !== false && lastHead.ts >= START && !previewInFlight && previews < 6) trigger = `eager (head ts ${lastHead.ts} >= start)`;
      if (!trigger) { await L.sleep(120); continue; }
    }
    log(`TRIGGER ${trigger}`);
    if (o.dry) { log(`DRY: would preview+execute now. calldata ${DATA} value 0`); process.exit(0); }

    // ---- preview ----
    previewInFlight = true; previews++;
    const t0 = Date.now();
    const pr = await L.baw(['contract-call', 'preview', '--binanceChainId', '56', '--from', addr, '--to', TO, '--value', '0', '--inputData', DATA], 30000);
    previewInFlight = false;
    save(`preview${previews}`, pr.stdout || pr.stderr);
    const ck = checkPreview(pr);
    log(`preview ${pr.ms}ms verdict ${ck.verdict}${ck.why ? ' ' + ck.why : ''}${ck.requestId ? ' requestId ' + ck.requestId + ' requireConfirmation ' + ck.requireConfirmation + ' gas ' + ck.gas : ''}`);
    if (ck.verdict === 'wait' || (ck.verdict === 'unknown' && Date.now() < startMs + o.grace * 1000)) {
      if (previews >= 20) die('too many previews without success');
      await L.sleep(250); continue;
    }
    if (ck.verdict !== 'ok') die(ck.why || 'preview failed');

    // ---- execute exactly once ----
    if (lockFiles.some(f => fs.existsSync(f))) die('lock appeared — another run executed this call');
    for (const f of lockFiles) fs.writeFileSync(f, L.safeJson({ t: L.wib(), to: TO, data: DATA, value: '0', requestId: ck.requestId, state: 'executing' }));
    const ex = await L.baw(['contract-call', 'execute', '--requestId', ck.requestId], 90000);
    save('exec', ex.stdout || ex.stderr);
    const ed = ex.json && ex.json.data;
    for (const f of lockFiles) fs.writeFileSync(f, L.safeJson({ t: L.wib(), to: TO, data: DATA, value: '0', requestId: ck.requestId, state: ed ? ed.status : 'exec_error', exec: ex.json || ex.stdout }));
    if (!ex.ok || !ed) {
      log(`EXECUTE ERROR (${ex.ms}ms) — NOT retrying. ${L.safeJson(ex.json || ex.stdout || ex.stderr).slice(0, 800)}`);
      log('Check `baw wallet tx-history --json` / `baw wallet tx-lock --json` before any manual retry.');
      process.exit(1);
    }
    log(`EXECUTE ${ed.status} (${ex.ms}ms, preview→execute ${Date.now() - t0}ms) orderId ${ed.orderId} txHash ${ed.txHash || '-'} ${ed.message || ''}`);
    if (ed.status === 'PENDING_CONFIRMATION' || !ed.txHash) { log('Needs approval in the Binance App (abnormal/large tx). Not resending — user must approve in the app.'); process.exit(0); }
    log(`BscScan ${L.SCAN}/tx/${ed.txHash}`);
    const rc = await receipt(ed.txHash);
    if (!rc) { log('receipt not found in 120s — check BscScan; NOT resending'); process.exit(0); }
    const st = parseInt(rc.status, 16);
    save('receipt', rc);
    log(`RECEIPT status ${st === 1 ? 'SUCCESS' : 'REVERTED'} block ${parseInt(rc.blockNumber, 16)} gasUsed ${parseInt(rc.gasUsed, 16)} logs ${rc.logs.length} | ${L.SCAN}/tx/${ed.txHash}`);
    process.exit(st === 1 ? 0 : 1);
  }
})().catch(e => { log('ERR ' + (e.stack || e.message)); process.exit(1); });

# ClaimGuard check endpoint (read-only)

Public HTTPS service for the Wildcard track. It answers one question —
**is this exact call safe to simulate right now, against this exact
contract?** — using only public read-only BSC JSON-RPC. It never executes
a transaction, never signs anything, and holds no keys.

## Run locally

```sh
node endpoint/server.cjs        # PORT env, default 3001
```

## API

### `GET /health`

```json
{ "ok": true, "service": "claimguard-check", "version": "1.0.0", "uptime_s": 123, "requests": 42, "scope": "..." }
```

### `POST /v1/check`

Request:

```json
{ "to": "0x58e8f1b34B60687B36BCdc78e02a2fd443De71Ab", "data": "0x", "value": "0x0", "wallet": "0xc77F305683F19AD95AB246Aa06f371C6f3792A4e" }
```

Response:

```json
{
  "verdict": "ok",
  "checks": [
    { "name": "target_has_code", "pass": true, "detail": "code present, 12345 bytes" },
    { "name": "wallet_balance", "pass": true, "detail": "balance 0x... wei" },
    { "name": "simulation", "pass": true, "detail": "eth_call succeeded, return 0x..." }
  ],
  "scope": "on-chain simulation only — ...",
  "to": "0x58e8...",
  "data": "0x",
  "value": "0x0"
}
```

Verdicts: `ok` (all on-chain checks passed), `wait` (simulation reverted
or wallet empty — try later, do not execute), `fatal` (bad input or target
has no code), `unknown` (RPC failed — do not treat as ok).

## Honest scope

This endpoint is the **on-chain half** of the ClaimGuard gate only. The
Binance preview checks from the CLI gate (`fire.js` / `pi-fire.js`) —
allowance/authority changes, RISK flags, `requestId` presence — are NOT
covered here, because they need the Binance preview API, which is not
available from a public service. Run the CLI gate before any execute.

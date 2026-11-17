# Wildcard — ClaimGuard: a wallet transaction guard for BSC free-mint claims

> **STATUS: SUBMISSION PACK — REPO LIVE, NOT SUBMITTED.**
> Prepared 15 Nov 2026 for zkVerify Agent Games Season 01, Wildcard track.
> Wildcard prize: 100,000 VFY per track (50,000 / 30,000 / 20,000 for 1st / 2nd / 3rd).
> Season: 21 Oct – 21 Nov 2026. Wildcard judging looks for: useful problem, working
> implementation, clear explanation, verifiability (optional plus), and a public share (bonus).
> **Repo created 17 Nov 2026. No live endpoint exists yet. Nothing here has been submitted.**
> Companion Creator Track article (published 17 Nov 2026): https://github.com/haniefff/agent-games-season-01/blob/main/creator/article.md

## Agent link

**Public repository:** `github.com/haniefff/claimguard`

Repo structure:

```
claimguard/
├── README.md            # this file (use case, checks, limits, how to run)
├── SKILL.md             # fastmint-fcfs skill notes: recon -> fire -> report
├── lib.js               # shared helpers: baw calls, RPC, classify, safe JSON
├── fire.js              # generic gate: eth_call -> baw preview -> 6 checks -> execute ONCE
├── pi-fire.js           # single-target variant (PiGenesis mintFree), with lock file
├── recon.js / recon.sh  # read-only recon: find contract, selectors, free slots
├── ethers.umd.min.js    # vendored ethers v6 UMD build (no npm install needed)
└── .env.example         # blank values only — never commit secrets
```

The gate code in this repo (`fire.js`, `pi-fire.js`, `lib.js`, `recon.js` — Node.js, ethers v6, vendored above so it runs with no install step) works locally and is driven through the Binance Agentic Wallet
(`baw`) CLI on BSC (chainId 56). No private key or seed is handled anywhere in this
code: signing happens inside the Binance App; the scripts only ever call
`baw contract-call preview` / `execute --requestId`.

## Use case — the problem, who it helps, what it does

**Problem.** Free-mint / FCFS claim pages on BSC are a race against bots, and the
pages themselves cannot be trusted at face value: a site can show one address while
its own config lists another, a "free" claim can hide an approval, and a call that
was valid a minute ago can revert now because the sale has not started or the free
pool is gone. The user this was built for is mobile-only on Android, holds
~0.0003 BNB, and cannot afford a single wasted transaction. One wrong click costs
real gas; one silent approval costs far more.

**Who it helps.** Anyone claiming free or gas-only mints from a small wallet —
especially mobile-only users who cannot babysit a desktop terminal and need the
machine to refuse a bad call on their behalf.

**What it actually does.** ClaimGuard is a deterministic pre-execution gate, not a
trading bot. It never chooses *what* to mint. Given one exact call (contract,
function, calldata, value), it:

1. Runs read-only prechecks: wallet `CONNECTED`, address matches the expected
   wallet, Developer Mode on, target contract has code on-chain (`eth_getCode`),
   balance above zero, on-chain eligibility (e.g. `freeLeft > 0`).
2. Runs `eth_call` with the exact calldata, then `baw contract-call preview`.
3. Applies six checks to the preview (see Build context). **All six must pass.**
4. Executes at most once (`--once`, one-broadcast lock file) — or stops in `--dry`
   mode before execute, logging exactly what it *would* have done.

If anything is unclear, it stops. Fail closed, always.

## Build context — how it works and the key decisions

**The six checks** (`checkPreview()` in `fire.js` / `pi-fire.js` — the whole gate
fits in one readable function):

1. `simulationCode` must be `000000000` — any other code is `wait`/`unknown`, never `ok`.
2. No `allowanceChanges` / `authorityChanges` in the simulation — a "free" claim
   that grants an approval is not free.
3. No hard `RISK` flags in `riskDetails` (global or per-address) — `fatal`, never bypassed.
4. Native outflow capped at intended value + 0.003 BNB; `fire.js` additionally
   rejects `parsedTx.amount > 0` on a value-0 call.
5. A `requestId` must be present in the preview — without it, there is nothing
   legitimate to execute.
6. Binance risk block (`351803` / `RISK_BLOCKED`) is `fatal`; an *unknown* preview
   shape classifies as `unknown` — and `unknown` also stops execution. No guessing.

**Key decisions behind the build:**

- **Deterministic code makes the final call, never the model.** The agent may
  suggest a mint; only the gate can approve firing it.
- **Fail closed on unknown shapes.** A classifier that cannot place an error is
  not a reason to proceed — it is a reason to stop and ask the user.
- **One broadcast, ever, per call.** A lock file records the executed call; the
  same call can never auto-repeat (protects against double-minting after a retry).
- **Preview before execute, always.** `execute` only ever runs with a `requestId`
  from a passing preview — never from a stale or hand-typed id.
- **No secrets in code.** No private key / seed handling; signing stays in the
  Binance App; `.env.example` ships blank values only.

**Real-world evidence (from the author's own wallet
`0xc77F305683F19AD95AB246Aa06f371C6f3792A4e`, BSC):**

- **FEG, 10 Nov 2026:** the mint site's displayed addresses differed from its own
  `config.js`, and the token shown had no code on-chain; a free claim would have
  reverted (`FreeGone`). The gate's address/code precheck is built for exactly this.
- **Pi (π) free seat, 15 Nov 2026, 17:24 WIB:** preview of `mintFree(1, 0x0)` on
  PiGenesis `0xEADd830D4e0B0C11c5A16D692AeFb4C960dF0fe4` reverted with custom error
  `0x6f312cbd` (`NotStarted`, sale opened 19:00 WIB). Check #1 failed; the gate
  stopped before execute. Zero BNB lost. The same flow was validated in `--dry`
  mode first (precheck passed, simulation decoded, stopped safely before preview).

**Limits (stated honestly):** a passing simulation describes chain state *now*, not
at execution time; the gate cannot see off-chain page changes between preview and
execute; it guards one call at a time and does not rank mints. Tested locally in
dry-run mode — no test-count claim is made here.

## Public endpoint plan (NOT built yet — do not claim it exists)

The Wildcard submission form asks for a public HTTPS endpoint. ClaimGuard is
currently a local CLI, so the endpoint is a **plan**, not a live service:

- **Proposed:** `POST https://claimguard.<host>/v1/check` — accepts one candidate
  call `{ to, data, value, wallet }`, runs the read-only precheck + `eth_call` +
  preview-equivalent simulation, and returns `{ verdict: ok | wait | fatal |
  unknown, checks: [...], reason }`. It would **never** execute a transaction
  itself; execution stays a separate, user-confirmed step via the Binance App.
- **Hosting:** a small Node.js service (same `fire.js` gate code) on a host with
  stable HTTPS; health endpoint `GET /health`.
- **What is missing before this can be registered:** a host, a domain, deployment
  of the service, and the user's approval. Until then the submission can only
  point at the public repo + this write-up.

## zkVerify (optional) — the checkable claim

*Sketched, not built. Labelled honestly as a sketch — there is no proof reference yet.*

Wildcard's own guidance suggests zkTLS as "a strong optional way to earn the
verifiability plus": turn a real HTTPS/API response your agent relied on into a
zkVerify-checkable claim, without revealing the full payload.

**Checkable claim (sketch):**

> "At time T, claim call C from wallet W against contract K returned success when
> simulated" — i.e. the `eth_call` / preview the gate relied on returned
> `simulationCode 000000000`, with no allowance/authority changes and no RISK flags.

**How it would work:** a zkTLS proof over the HTTPS response carrying the
simulation result, submitted to zkVerify for verification. A reviewer could then
check *the evidence behind the gate's decision*, not just the gate's own word that
it passed — "here is the proof the preview said OK, at this time, for this exact
call", instead of a screenshot.

**Why it matters here:** the author's core lesson is that "a proof can verify
perfectly and still authorize the wrong action" — verification is necessary, not
sufficient. The six deterministic checks are the *decision* half; a zkTLS proof
over the preview is the *evidence* half. Either half alone can be gamed or
mistaken; together they are what makes a wallet guard auditable. Agents without
zkVerify remain eligible for Wildcard, and this pack does not pretend the
integration exists yet.

## Submission checklist (what is still missing)

- [x] Public repo created at the proposed link (created 17 Nov 2026)
- [ ] Public HTTPS endpoint deployed (host + domain — not built yet)
- [~] Agent Games account registered as AkangBarr / agent AKANG-GK (Proof Gatekeeper, 15 Nov 2026); wallet address for VFY prizes still pending before 21 Nov close
- [ ] Submission form filled from the dashboard (agent link + endpoint + use case)
- [ ] Optional public share (X post / demo) for the Wildcard bonus
- [ ] zkTLS + zkVerify proof reference — sketch only, not built; add only if implemented

*Author: @akang-aja — mobile-only Android, Binance Agentic Wallet on BSC.
Gate logic: `~/workspace/fastmint/fire.js`, `~/workspace/fastmint/pi-fire.js`.*

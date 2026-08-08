# Noctis Proof Server — Deployment Config

Deployment config for the Midnight proof server that the DarkVeil widget's
`ContractProviders` assembly needs at `midnightZk.proofServerUrl`
(`integration/widget/midnight-wallet-bridge.ts`'s `configure()`). This
directory turns that research into something deployable, not a fresh design.

**Status: config-complete, not yet provisioned.** Nobody has run this against
a real VM yet — that's the next action, tracked as a checklist below, not
something done automatically as part of writing these files.

## What's here

| File | Purpose |
|---|---|
| `docker-compose.yml` | Proof server (pinned `8.1.0`) + Caddy TLS reverse proxy |
| `Caddyfile` | Caddy config — **edit the domain before deploying** |

## Why these settings

- **Image tag `8.1.0`, not `latest` or `9.0.0-rc.5`.** `9.0.0-rc.5` was just the newest Docker Hub tag at research time, not a version confirmed compatible with the rest of the stack. Midnight's 2026-07-21 mainnet-upgrade announcement (bringing mainnet in line with preprod) confirms the real validated combination as Node 1.0.0 / Ledger 8.1.0 / Indexer 4.3.3 / **Proof Server 8.1.0** — the same triple independently pulled from the official support matrix during the local devnet work. A version-mismatched proof server fails in a specific, confirmed way: `/prove` returns 400 (binary deserialization failure) or 500 (internal circuit error), not an obvious "wrong version" message — so this is worth getting right before first deploy, not something to notice later from a support ticket.
- **`--num-workers 3`, `--job-capacity 20`, `--job-timeout 300`.** Sized for the Hetzner CPX31 recommendation below (4 vCPU / 8 GB) — one core held back for the HTTP server/GC/OS per the proof-server-configuration skill's own tuning guidance ("production 4-core → 3-4 workers"). `--job-capacity 20` matches that skill's "production (small)" band, appropriate for Noctis's real DV volume (15-75 registrants/launch) — comfortably below the point where an unbounded queue risks OOM under a burst. `--job-timeout 300` covers the DarkVeil circuits' real complexity: measurement found `registerForDarkVeil`'s 20-level Merkle-proof fold to be the single most expensive circuit in the suite (confirmed via its 37MB prover key, the largest of any circuit measured — see the ZK artifacts README's real per-circuit numbers), still well inside the "medium complexity, k=13-15, 300-600s" band.
- **`--memory=6g` limit, 4g reservation.** The configuration skill's own memory table puts a 4-worker production deployment at 8GB minimum; 3 workers plus proof-server + Caddy overhead on an 8GB host leaves headroom without over-committing the whole box.
- **Caddy in front, proof server bound to `127.0.0.1` only.** The DarkVeil widget calls this endpoint from browser JS running on an HTTPS WordPress page — a bare `http://` call would be blocked as mixed content. Caddy gets automatic Let's Encrypt certs from just a domain name (no manual cert lifecycle to manage) and is the standard lightweight choice for a single backend service. The proof server itself has no TLS or auth of its own, so it must never be reachable directly from the public interface.
- **Healthcheck `start_period: 300s`.** Confirmed via the proof-server-operations skill: parameter pre-fetch runs *before* the HTTP listener binds, so `/health` is unreachable (connection refused), not merely slow, for the first 2-5 minutes. A shorter `start_period` would flap the container to "unhealthy" during completely normal startup.

## Provisioning runbook

1. **Provision the VM.** Hetzner CPX31 (4 vCPU / 8 GB / 160 GB SSD, ~$18-21/month) — matches this compose file's sizing, and came out ahead in a cost comparison against DigitalOcean/Fly.io. Any Docker-capable Linux host works; this is the recommended starting point, not a hard requirement.
2. **Point DNS at the VM.** Create an A (and AAAA, if using IPv6) record for the proof-server subdomain (e.g. `proof.noctis.zone`) at the VM's IP. Caddy's ACME challenge needs this to already resolve before first startup.
3. **Install Docker + Docker Compose** on the VM (standard `get.docker.com` install script or distro package).
4. **Copy this directory to the VM** (`scp -r deploy/proof-server user@host:~/`).
5. **Edit `Caddyfile`** — replace the placeholder domain with the real one from step 2.
6. **Start the stack:**
   ```bash
   cd proof-server && docker compose up -d
   ```
7. **Watch startup** (parameter pre-fetch takes 2-5 min):
   ```bash
   docker compose logs -f proof-server
   ```
   Expect `Ensuring zswap key material is available...` early, then the process binding its port once pre-fetch completes.
8. **Verify health and readiness**, both through Caddy (public, TLS) and directly on the host (bypassing Caddy, to isolate proxy issues from proof-server issues):
   ```bash
   curl -sf https://proof.noctis.zone/health
   curl -sf https://proof.noctis.zone/ready | jq .
   curl -sf http://127.0.0.1:6300/version   # on the VM itself
   ```
   Confirm the reported `/version` matches `8.1.0` and `/proof-versions` lists a version the widget bundle's SDK actually produces (cross-check against the `@midnight-ntwrk` package versions pinned in `integration/package.json`).
9. **Wire the URL into the widget config** — `midnightZk.proofServerUrl` in `integration/widget/midnight-wallet-bridge.ts`'s `configure()` call, and the matching `midnight_proof_server_url` Settings field (`inc/cardano/midnight-governor-secrets.php`'s companion settings, per `CHANGELOG.md`'s `[0.9.0]` entry) — both need the same real `https://proof.noctis.zone` value.
10. **End-to-end smoke test**: drive one real `/prove` call against a real circuit (the governor CLI's `publish-allowlist-root` command, or the DarkVeil widget's own registration flow against a live Preprod launch) and confirm it returns a usable proof rather than 400/429/500. This is the step that actually closes out this deployment — everything above is necessary but not sufficient.

## Operational reference

Day-2 monitoring, troubleshooting HTTP codes, log patterns, and capacity
tuning are documented in depth in the `proof-server:proof-server-operations`
and `proof-server:proof-server-configuration` skills (installed locally under
`midnight-expert`) — consult those rather than re-deriving guidance here.
Quick reference for the two endpoints that matter most operationally:

- `GET /health` → 200 while the process is alive (liveness)
- `GET /ready` → 200 while accepting work, 503 once `--job-capacity`'s queue is full (readiness)

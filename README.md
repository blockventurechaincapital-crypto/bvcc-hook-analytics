# BVCC Hook Analytics Dashboard

> Real-time on-chain analytics for the **BlockVenture Chain Capital Dynamic Fee Hook** — a Uniswap v4 hook deployed on 4 networks providing anti-bot protection and dynamic fee management for liquidity pools.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Uniswap v4](https://img.shields.io/badge/Uniswap-v4-ff007a)](https://github.com/Uniswap/v4-core)
[![Chains](https://img.shields.io/badge/Chains-ARB%20%7C%20BNB%20%7C%20Base%20%7C%20ETH-blue)](#deployed-contracts)

---

## What is the BVCC Hook?

The BVCC Dynamic Fee Hook is a Uniswap v4 hook that:

- **Protects liquidity pools** from MEV bots and sandwich attacks
- **Dynamically adjusts fees** based on gas price, volatility, and trading patterns
- **Penalizes bots** with a higher `finalFee` — the surplus goes directly to LPs as extra yield
- **Provides anti-bot detection** at the protocol level (`penaltyApplied=true` on every penalized swap)

This dashboard surfaces all on-chain activity across 4 deployed networks in real time.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  indexer.cjs  (Node.js — runs continuously)         │
│  4 chains in parallel · eth_getLogs · SQLite        │
│  FeeCalculated + Swap events → bvcc_indexer.db      │
└────────────────────┬────────────────────────────────┘
                     │ SQLite reads
┌────────────────────▼────────────────────────────────┐
│  server.js  (Express)                               │
│  GET /api/indexer → JSON (pools + swaps + prices)   │
│  CoinGecko logo resolver · TVL via extsload         │
│  token_logos.json  (persistent logo cache)          │
└────────────────────┬────────────────────────────────┘
                     │ fetch('/api/indexer')
┌────────────────────▼────────────────────────────────┐
│  BVCC Hook Analytics.html  (frontend)               │
│  Vanilla JS · Chart.js · ethers.js · No build step  │
│  Auto-refresh every 60s                             │
└─────────────────────────────────────────────────────┘
```

---

## Features

| Feature | Details |
|---|---|
| **4-chain support** | Arbitrum One · BNB Chain · Base · Ethereum |
| **Continuous indexer** | SQLite-backed, chunk-safe progress (Ctrl+C resumable), 60s polling loop |
| **Real on-chain data** | ethers.js v5 · `eth_getLogs` · FeeCalculated + Swap events |
| **USD pricing** | CoinGecko ETH/BNB price · TVL via PoolManager storage slots |
| **APR per pool** | 7-day window: `(fees7d / tvlUsd) × (365/7) × 100` using `finalFee` (includes bot penalty) |
| **Token logos** | CoinGecko server-side → Trust Wallet → PancakeSwap → SushiSwap → letter fallback |
| **Logo persistence** | `token_logos.json` — survives server restarts, atomic write |
| **Pool deep-dive modal** | Stats · Swap Activity chart (24H/7D/30D/1Y/All) · Fee Revenue stacked bar · Gas donut · Top traders · Recent swaps |
| **Fee Revenue chart** | Stacked bar: Base Fees (gold) + Bonus Fees (green) per day |
| **Bot Penalty KPI** | Count + rate + `+$X extra LP yield` — only counts swaps with `penaltyApplied=true` |
| **Swap + Add Liq buttons** | Uniswap-style buttons in pools table and pool modal · Add Liq URL includes hook address and `isDynamic:true` |
| **Bilingual EN/ES** | 46 `data-i18n` keys · flag icons · persisted in localStorage |
| **Mobile responsive** | Pools table horizontal scroll (all 10 columns) · Chart tabs (Swaps/Chains/Bots/Fees) · Compact KPIs/modals |
| **Export CSV** | Recent swaps filtered by range → download |
| **No build step** | Single HTML file served by Express |

---

## Deployed Contracts

### Arbitrum One (Chain ID: 42161)

| Contract | Address | Explorer |
|---|---|---|
| **BVCC Hook** | `0x2097d7329389264a1542Ad50802bB0DE84a650c4` | [Arbiscan ↗](https://arbiscan.io/address/0x2097d7329389264a1542Ad50802bB0DE84a650c4) |
| PoolManager (v4) | `0x360e68faccca8ca495c1b759fd9eee466db9fb32` | [Arbiscan ↗](https://arbiscan.io/address/0x360e68faccca8ca495c1b759fd9eee466db9fb32) |
| **Deploy block** | `414,666,196` | — |

### BNB Chain (Chain ID: 56)

| Contract | Address | Explorer |
|---|---|---|
| **BVCC Hook** | `0x8a36d8408F5285c3F81509947bc187b3c0eFD0C4` | [BscScan ↗](https://bscscan.com/address/0x8a36d8408F5285c3F81509947bc187b3c0eFD0C4) |
| PoolManager (v4) | `0x28e2ea090877bf75740558f6bfb36a5ffee9e9df` | [BscScan ↗](https://bscscan.com/address/0x28e2ea090877bf75740558f6bfb36a5ffee9e9df) |
| **Deploy block** | `72,781,693` | — |

### Base (Chain ID: 8453)

| Contract | Address | Explorer |
|---|---|---|
| **BVCC Hook** | `0x2c56c1302B6224B2bB1906c46F554622e12F10C4` | [Basescan ↗](https://basescan.org/address/0x2c56c1302B6224B2bB1906c46F554622e12F10C4) |
| PoolManager (v4) | `0x498581ff718922c3f8e6a244956af099b2652b2b` | [Basescan ↗](https://basescan.org/address/0x498581ff718922c3f8e6a244956af099b2652b2b) |
| **Deploy block** | `39,977,919` | — |

### Ethereum Mainnet (Chain ID: 1)

| Contract | Address | Explorer |
|---|---|---|
| **BVCC Hook** | `0xF9CED7D0F5292aF02385410Eda5B7570b10b50c4` | [Etherscan ↗](https://etherscan.io/address/0xF9CED7D0F5292aF02385410Eda5B7570b10b50c4) |
| PoolManager (v4) | `0x000000000004444c5dc75cb358380d2e3de08a90` | [Etherscan ↗](https://etherscan.io/address/0x000000000004444c5dc75cb358380d2e3de08a90) |
| **Deploy block** | `24,096,297` | — |

---

## Quick Start

```bash
git clone https://github.com/blockventurechaincapital-crypto/bvcc-hook-analytics
cd bvcc-hook-analytics

# Configure RPCs (public endpoints included by default)
cp .env.example .env

# Install root deps (Express + dotenv)
npm install

# Install indexer deps (better-sqlite3, ethers@5, dotenv)
cd indexer && npm install && cd ..

# Start indexer (background — indexes FeeCalculated events into SQLite)
node indexer/indexer.cjs &

# Start server (serves dashboard + /api/indexer)
node server.js
# Open http://localhost:3000
```

**Production (VPS with PM2 + Nginx):**
```bash
pm2 start indexer/indexer.cjs --name bvcc-indexer
pm2 start server.js --name bvcc-server
pm2 save && pm2 startup
```

---

## Configuration

All RPC endpoints are defined in `.env` (copy from `.env.example`):

```env
# Indexer — 4 fallback RPCs per chain, tried in order
ARB_RPCS=https://arb-one.api.pocket.network,...
BSC_RPCS=https://bsc.publicnode.com,...
BASE_RPCS=https://base-rpc.publicnode.com,...
ETH_RPCS=https://ethereum-rpc.publicnode.com,...

# Server — single RPC per chain for TVL extsload calls
ARB_RPC=https://arbitrum-one.public.blastapi.io
BSC_RPC=https://bsc.publicnode.com
BASE_RPC=https://base-rpc.publicnode.com
ETH_RPC=https://ethereum-rpc.publicnode.com

PORT=3000
```

Default values are free public endpoints — no API keys required. Replace with paid RPCs (Alchemy, Infura, QuickNode) for better reliability on production.

---

## How It Works

```
indexer.cjs (runs continuously)
    │
    ├─ 4 chains in parallel (3s stagger)
    │     Each chain: loop every 60s
    │
    ├─ getWorkingProvider()
    │     Tests RPCs in order, picks first responsive
    │
    ├─ fetchFeeEvents() — eth_getLogs, 2000-block chunks
    │     FeeCalculated(poolId, user, baseFee, finalFee,
    │                   gasPrice, gasLevel, penaltyApplied, strategy)
    │
    ├─ parseReceipt()
    │     Matches Swap event by poolId (multi-hop safe)
    │     Resolves amountIn/amountOut with ERC20 decimals
    │
    ├─ insertPool() / insertSwap()
    │     SQLite — UNIQUE(chain, txHash, poolId) prevents duplicates
    │
    └─ setState('last_block_{chain}', to)
          Saved per chunk — resumable after Ctrl+C

server.js (Express)
    │
    ├─ GET /api/indexer
    │     Reads SQLite pools + recent swaps
    │     Calculates TVL via PoolManager extsload
    │     Calculates volume24h, fees7d, apr7d per pool
    │     Resolves token logos (CoinGecko → cached in token_logos.json)
    │     Returns JSON consumed by frontend
    │
    └─ GET / → serves BVCC Hook Analytics.html
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | HTML5 / CSS3 / Vanilla JS (no framework) |
| Charts | [Chart.js v4.4.0](https://www.chartjs.org/) |
| Blockchain | [ethers.js v5.7.2](https://docs.ethers.org/v5/) |
| Database | SQLite via [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) |
| Server | [Express.js](https://expressjs.com/) |
| Config | [dotenv](https://github.com/motdotla/dotenv) |
| Fonts | Inter + JetBrains Mono (Google Fonts) |
| Logo prices | CoinGecko API (free tier) |
| i18n | Vanilla JS — `data-i18n` attributes + TRANSLATIONS object |

---

## Project Structure

```
bvcc-hook-analytics/
├── BVCC Hook Analytics.html    ← main dashboard (single HTML file)
├── server.js                   ← Express server + /api/indexer + logo resolver
├── .env.example                ← RPC config template (copy to .env)
├── package.json
├── nginx.conf                  ← VPS Nginx snippet
├── assets/
│   ├── images/
│   │   ├── logo.png
│   │   └── flags/
│   │       ├── en.png
│   │       └── es.png
│   └── favicon.png
└── indexer/
    ├── indexer.cjs             ← continuous 4-chain indexer
    ├── parser.cjs              ← receipt parser (FeeCalculated + Swap)
    ├── db.cjs                  ← SQLite schema + helpers
    └── package.json
```

> `bvcc_indexer.db` and `token_logos.json` are generated at runtime and excluded from the repository.

---

## Roadmap

- [x] M1 — Design system + shell (BVCC dark/gold theme, Chart.js)
- [x] M2 — Live RPC: pool discovery + swap counting
- [x] M3 — Historical analytics: deploy-block scan, USD pricing, hook events
- [x] M4 — 4-chain expansion (ARB + BNB + Base + ETH)
- [x] M5 — Mobile responsive, bilingual EN/ES
- [x] M6 — Continuous SQLite indexer replacing batch scanner
- [x] M7 — Pool deep-dive modal: Fee Revenue chart, APR, Swap/Add Liq buttons
- [x] M8 — Token logo pipeline (CoinGecko + multi-CDN fallback + persistence)
- [x] M9 — Mobile chart tab switcher · Pools table full-column horizontal scroll
- [x] M10 — APR 7-day window · Bonus Fees label · .env RPC configuration

---

## About BVCC

[BlockVenture Chain Capital](https://blockventurechaincapital.com) is a DeFi infrastructure firm focused on:

- **BVCC Dynamic Fee Hook v4.3** — Uniswap v4 hook protecting liquidity pools from MEV and bot attacks with dynamic fee management
- **Investment Portfolio** — Strategic capital fund investing in blockchain infrastructure projects

**Contact:** contact@blockventurechaincapital.com
**Twitter/X:** [@BLOCVENCHAINCAP](https://x.com/BLOCVENCHAINCAP)
**Telegram:** [t.me/BVCC_Hook](https://t.me/BVCC_Hook)
**GitHub:** [blockventurechaincapital-crypto](https://github.com/blockventurechaincapital-crypto)
**LinkedIn:** [BlockVenture Chain Capital](https://www.linkedin.com/company/blockventure-chain-capital)

---

## License

MIT — see [LICENSE](LICENSE)

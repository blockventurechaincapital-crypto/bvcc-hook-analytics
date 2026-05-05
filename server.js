'use strict';
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { ethers } = require('./indexer/node_modules/ethers');

// PoolManager: read storage slots directly via extsload (Uniswap v4 standard)
const PM_ABI = ['function extsload(bytes32 slot) external view returns (bytes32)'];

const CHAIN_RPC = {
  arbitrum: { rpc: process.env.ARB_RPC  || 'https://arbitrum-one.public.blastapi.io', poolManager: '0x360e68faccca8ca495c1b759fd9eee466db9fb32' },
  bsc:      { rpc: process.env.BSC_RPC  || 'https://bsc.publicnode.com',              poolManager: '0x28e2ea090877bf75740558f6bfb36a5ffee9e9df' },
  base:     { rpc: process.env.BASE_RPC || 'https://base-rpc.publicnode.com',         poolManager: '0x498581ff718922c3f8e6a244956af099b2652b2b' },
  ethereum: { rpc: process.env.ETH_RPC  || 'https://ethereum-rpc.publicnode.com',     poolManager: '0x000000000004444c5dc75cb358380d2e3de08a90' },
};

// Pool state cache (1 min TTL)
const poolStateCache = {};
const POOL_STATE_TTL = 60_000;

// Current block cache per chain (30s TTL) — used for accurate timestamp estimation
const currentBlockCache = {};
const CURRENT_BLOCK_TTL = 30_000;

async function fetchCurrentBlock(chain) {
  const cached = currentBlockCache[chain];
  if (cached && Date.now() - cached.ts < CURRENT_BLOCK_TTL) return cached.block;
  try {
    const cfg = CHAIN_RPC[chain];
    const provider = new ethers.providers.JsonRpcProvider(cfg.rpc);
    const block = await provider.getBlockNumber();
    currentBlockCache[chain] = { block, ts: Date.now() };
    return block;
  } catch {
    // Fall back to cached value or last indexed block
    return currentBlockCache[chain]?.block || 0;
  }
}

// Discovered POOLS_SLOT per chain (varies between PoolManager deployments)
const chainPoolsSlot = {};
const SLOTS_TO_TRY = [5n, 6n, 7n, 8n, 4n];

function sqrtPriceX96ToPrice(sqrtPriceX96, d0, d1) {
  try {
    const Q96 = 2n ** 96n;
    const sq = BigInt(sqrtPriceX96.toString());
    const numerator = sq * sq * BigInt(10 ** d0);
    const denominator = Q96 * Q96 * BigInt(10 ** d1);
    if (denominator === 0n) return null;
    return Number(numerator * 1_000_000n / denominator) / 1_000_000;
  } catch { return null; }
}

async function fetchPoolState(chain, poolId) {
  const key = `${chain}:${poolId}`;
  const cached = poolStateCache[key];
  if (cached && Date.now() - cached.ts < POOL_STATE_TTL) return cached.data;

  const cfg = CHAIN_RPC[chain];
  if (!cfg) return null;
  try {
    const provider = new ethers.providers.JsonRpcProvider(cfg.rpc);
    const pm = new ethers.Contract(cfg.poolManager, PM_ABI, provider);

    // POOLS_SLOT varies by PoolManager deployment — discover once per chain, then cache
    const slots = chainPoolsSlot[chain] != null ? [chainPoolsSlot[chain]] : SLOTS_TO_TRY;

    for (const poolsSlot of slots) {
      const encoded = ethers.utils.defaultAbiCoder.encode(['bytes32', 'uint256'], [poolId, poolsSlot]);
      const baseSlot = ethers.utils.keccak256(encoded);
      const slot0Raw = await pm.extsload(baseSlot);
      const sqrtPriceX96 = ethers.BigNumber.from(slot0Raw).mask(160);

      if (!sqrtPriceX96.isZero()) {
        if (chainPoolsSlot[chain] == null) {
          chainPoolsSlot[chain] = poolsSlot;
          console.log(`[server] ${chain} POOLS_SLOT=${poolsSlot}`);
        }
        const liqSlot = ethers.utils.hexZeroPad(
          ethers.BigNumber.from(baseSlot).add(3).toHexString(), 32
        );
        const liqRaw = await pm.extsload(liqSlot);
        const liquidity = ethers.BigNumber.from(liqRaw).mask(128).toString();
        const data = { sqrtPriceX96, liquidity };
        poolStateCache[key] = { data, ts: Date.now() };
        return data;
      }
    }

    return null; // pool not initialized or slot not found
  } catch (e) {
    console.warn(`[server] poolState ${chain}:${poolId.slice(0, 10)}: ${e.message.slice(0, 80)}`);
    return null;
  }
}

const app = express();
const PORT = process.env.PORT || 3000;
const HTML_FILE = path.join(__dirname, 'BVCC Hook Analytics.html');
const DB_PATH = path.join(__dirname, 'indexer', 'bvcc_indexer.db');

// Approximate blocks per day per chain (for 24h window)
const BLOCKS_PER_DAY = { arbitrum: 345600, bsc: 28800, base: 43200, ethereum: 7200 };

// Seconds per block per chain — used to estimate real timestamps from block numbers
const BLOCK_SEC = { arbitrum: 0.26, bsc: 3, base: 2, ethereum: 12 };

// Stablecoins — treated as $1
const STABLES = new Set(['USDC', 'USDT', 'BUSD', 'DAI', 'FRAX', 'LUSD', 'FDUSD']);

// Native wrapped tokens → CoinGecko IDs
const NATIVE_SYMBOLS = { WBNB: 'bnb', BNB: 'bnb', WETH: 'eth', ETH: 'eth', WMATIC: 'matic' };

// Price cache (5 min TTL)
let priceCache = { data: null, ts: 0 };
async function fetchPrices() {
  if (priceCache.data && Date.now() - priceCache.ts < 5 * 60_000) return priceCache.data;
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=binancecoin,ethereum,matic-network&vs_currencies=usd');
    const j = await r.json();
    priceCache.data = {
      bnb:   j['binancecoin']?.usd  || 0,
      eth:   j['ethereum']?.usd     || 0,
      matic: j['matic-network']?.usd || 0,
    };
    priceCache.ts = Date.now();
    console.log(`[server] prices: BNB=$${priceCache.data.bnb} ETH=$${priceCache.data.eth}`);
  } catch (e) {
    console.warn('[server] Price fetch failed:', e.message);
    priceCache.data = priceCache.data || { bnb: 0, eth: 0, matic: 0 };
  }
  return priceCache.data;
}

/**
 * Estimate USD value of a single swap row.
 * Uses stablecoin detection first, then native token price.
 */
function swapUsdValue(swap, pool, prices) {
  if (!swap.amountIn || !swap.amountOut) return null;

  const inAmt  = parseFloat(swap.amountIn);
  const outAmt = parseFloat(swap.amountOut);
  if (isNaN(inAmt) || isNaN(outAmt)) return null;

  const inSym  = (swap.tokenIn  === pool.token0_address ? pool.token0_symbol : pool.token1_symbol)?.toUpperCase();
  const outSym = (swap.tokenOut === pool.token0_address ? pool.token0_symbol : pool.token1_symbol)?.toUpperCase();

  // Stablecoin: use amount directly as USD
  if (STABLES.has(outSym)) return outAmt;
  if (STABLES.has(inSym))  return inAmt;

  // Native token: multiply by price
  const inNative  = NATIVE_SYMBOLS[inSym];
  const outNative = NATIVE_SYMBOLS[outSym];
  if (inNative  && prices[inNative])  return inAmt  * prices[inNative];
  if (outNative && prices[outNative]) return outAmt * prices[outNative];

  return null;
}

/**
 * USD price of a token amount given its symbol.
 */
function tokenUsdPrice(symbol, amount, prices) {
  if (symbol == null || amount == null || !isFinite(amount)) return null;
  const sym = symbol.toUpperCase();
  if (STABLES.has(sym)) return amount;
  const nativeKey = NATIVE_SYMBOLS[sym];
  if (nativeKey && prices[nativeKey]) return amount * prices[nativeKey];
  return null;
}

/**
 * Compute approximate pool TVL from Uniswap v4 active liquidity math.
 * Uses: L (uint128 liquidity), price (token1/token0 human units), decimals.
 * Formula: amount0 = L / (√rawPrice × 10^d0)
 *          amount1 = L × √rawPrice / 10^d1
 * where rawPrice = priceHuman × 10^d1 / 10^d0
 */
function computePoolTVL(pool, latestSwap, prices) {
  if (!latestSwap?.liquidity || !latestSwap?.price) return null;

  const L = parseFloat(latestSwap.liquidity);
  const priceHuman = latestSwap.price;
  const d0 = pool.token0_decimals || 18;
  const d1 = pool.token1_decimals || 18;

  const rawPrice = priceHuman * Math.pow(10, d1) / Math.pow(10, d0);
  const sqrtRawPrice = Math.sqrt(rawPrice);
  if (!sqrtRawPrice || !isFinite(sqrtRawPrice)) return null;

  const amount0 = L / (sqrtRawPrice * Math.pow(10, d0));
  const amount1 = L * sqrtRawPrice / Math.pow(10, d1);
  if (!isFinite(amount0) || !isFinite(amount1)) return null;

  let usd0 = tokenUsdPrice(pool.token0_symbol, amount0, prices);
  let usd1 = tokenUsdPrice(pool.token1_symbol, amount1, prices);

  // Derive unknown token price from pool ratio + known token price
  if (usd0 == null && usd1 != null && amount1 > 0) {
    const p1PerUnit = usd1 / amount1;               // USD per 1 token1
    const p0PerUnit = p1PerUnit * priceHuman;        // USD per 1 token0 (price = t1/t0)
    usd0 = amount0 * p0PerUnit;
  } else if (usd1 == null && usd0 != null && amount0 > 0) {
    const p0PerUnit = usd0 / amount0;               // USD per 1 token0
    const p1PerUnit = p0PerUnit / priceHuman;        // USD per 1 token1
    usd1 = amount1 * p1PerUnit;
  }

  let tvlUsd = null;
  if (usd0 != null && usd1 != null) tvlUsd = usd0 + usd1;

  return { amount0, amount1, sym0: pool.token0_symbol, sym1: pool.token1_symbol, tvlUsd };
}

// Token logo cache — resolved once via CoinGecko, persisted to disk (survives restarts)
const LOGOS_FILE = path.join(__dirname, 'token_logos.json');
const tokenLogoCache = fs.existsSync(LOGOS_FILE)
  ? JSON.parse(fs.readFileSync(LOGOS_FILE, 'utf8'))
  : {};
const CG_PLATFORM = { arbitrum: 'arbitrum-one', bsc: 'binance-smart-chain', base: 'base', ethereum: 'ethereum' };

function saveLogoCache() {
  fs.writeFileSync(LOGOS_FILE + '.tmp', JSON.stringify(tokenLogoCache, null, 2));
  fs.renameSync(LOGOS_FILE + '.tmp', LOGOS_FILE);
}

async function resolveTokenLogo(address, chain, symbol) {
  if (!address) return null;
  const key = `${chain}:${address.toLowerCase()}`;
  if (key in tokenLogoCache) return tokenLogoCache[key];

  const platform = CG_PLATFORM[chain] || chain;

  // 1. Try by contract address
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/coins/${platform}/contract/${address.toLowerCase()}`);
    if (r.ok) {
      const j = await r.json();
      const logo = j.image?.small || null;
      if (logo) {
        tokenLogoCache[key] = logo;
        saveLogoCache();
        console.log(`[server] logo (contract): ${symbol} → ${logo}`);
        return logo;
      }
    }
  } catch {}

  // Small delay before second attempt to respect CoinGecko rate limits
  await new Promise(r => setTimeout(r, 300));

  // 2. Fallback: search by symbol — catches tokens not indexed by contract on CoinGecko
  if (symbol) {
    try {
      const r = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(symbol)}`);
      if (r.ok) {
        const j = await r.json();
        const match = (j.coins || []).find(c => c.symbol?.toUpperCase() === symbol.toUpperCase());
        const logo = match?.large || match?.thumb || null;
        if (logo) {
          tokenLogoCache[key] = logo;
          saveLogoCache();
          console.log(`[server] logo (search): ${symbol} → ${logo}`);
          return logo;
        }
      }
    } catch {}
  }

  // Do NOT cache null — retry next buildPayload cycle (avoids permanent failure from rate limiting)
  return null;
}

let db = null;
function getDb() {
  if (!db) {
    try {
      const Database = require('./indexer/node_modules/better-sqlite3');
      db = new Database(DB_PATH, { readonly: true });
    } catch (e) {
      console.warn('[server] SQLite unavailable:', e.message);
    }
  }
  return db;
}

/* ══════════════════════════════════════════
   ROUTES
══════════════════════════════════════════ */

app.get('/', (req, res) => {
  res.sendFile(HTML_FILE);
});

/* ══════════════════════════════════════════
   BACKGROUND CACHE — built once, refreshed every 60s
   The API endpoint returns instantly from cache instead of
   blocking on RPC calls (tipBlocks, TVL, prices) per request.
══════════════════════════════════════════ */
let indexerCache = null;

async function buildPayload() {
  const db = getDb();
  if (!db || !fs.existsSync(DB_PATH)) return null;
  try {
    const prices = await fetchPrices();

    // Last indexed block per chain (from indexer progress)
    const lastBlocks = {};
    for (const chain of Object.keys(BLOCKS_PER_DAY)) {
      const row = db.prepare('SELECT value FROM indexer_state WHERE key = ?').get(`last_block_${chain}`);
      lastBlocks[chain] = row ? parseInt(row.value) : 0;
    }

    // Current tip block per chain — needed for accurate timestamp estimation.
    // lastBlocks[chain] may be hours behind the real tip (indexer catching up),
    // so we use the actual current block from the RPC as the time reference.
    const tipBlocks = {};
    await Promise.all(Object.keys(BLOCKS_PER_DAY).map(async chain => {
      const tip = await fetchCurrentBlock(chain);
      tipBlocks[chain] = tip || lastBlocks[chain] || 0;
    }));

    const rawPools = db.prepare('SELECT * FROM pools').all();
    // Sort by real timestamp when available, otherwise estimate from block distance to tip.
    const nowSec = Math.round(Date.now() / 1000);
    function estimateTs(s) {
      if (s.timestamp) return s.timestamp;
      const tip = tipBlocks[s.chain];
      if (!tip) return 0;
      return nowSec - (tip - s.block) * (BLOCK_SEC[s.chain] || 12);
    }
    const rawSwaps = db.prepare('SELECT * FROM swaps LIMIT 20000').all();
    rawSwaps.sort((a, b) => estimateTs(b) - estimateTs(a)); // most recent first

    const pools = await Promise.all(rawPools.map(async p => {
      const ps = rawSwaps.filter(s => s.poolId === p.poolId && s.chain === p.chain);

      // 24h cutoff — use real timestamp when available, block estimate as fallback
      const cutoffTs = nowSec - 86400;
      const swaps24h = ps.filter(s => estimateTs(s) >= cutoffTs);

      // 7d cutoff for APR calculation
      const cutoffTs7d = nowSec - 7 * 86400;
      const swaps7d = ps.filter(s => estimateTs(s) >= cutoffTs7d);

      // Volume 24h in USD + fees collected by LPs (using finalFee = includes bot penalty)
      let volume24h = null;
      let fees7d = null;
      for (const s of swaps24h) {
        const usd = swapUsdValue(s, p, prices);
        if (usd != null) {
          volume24h = (volume24h || 0) + usd;
        }
      }
      for (const s of swaps7d) {
        const usd = swapUsdValue(s, p, prices);
        if (usd != null) {
          fees7d = (fees7d || 0) + usd * ((s.finalFee || s.baseFee || 0) / 1_000_000);
        }
      }

      // TVL from live on-chain PoolManager state (current sqrtPrice + liquidity)
      const onChain = await fetchPoolState(p.chain, p.poolId);
      const liveSnap = onChain ? {
        liquidity: onChain.liquidity,
        price: sqrtPriceX96ToPrice(onChain.sqrtPriceX96, p.token0_decimals || 18, p.token1_decimals || 18),
      } : null;
      const tvl = computePoolTVL(p, liveSnap, prices);

      // Token logos — resolved sequentially to avoid CoinGecko rate limiting on startup
      const logoUri0 = await resolveTokenLogo(p.token0_address, p.chain, p.token0_symbol);
      const logoUri1 = await resolveTokenLogo(p.token1_address, p.chain, p.token1_symbol);

      // APR = annualised LP fees / TVL (7d window → × 52.14 weeks/year)
      // Uses finalFee (includes bot penalty) → real yield for LPs
      const apr7d = (fees7d != null && tvl?.tvlUsd > 0)
        ? (fees7d / tvl.tvlUsd) * (365 / 7) * 100
        : null;

      return {
        id: p.poolId,
        chain: p.chain,
        swapsTotal: ps.length,
        botSwaps: ps.filter(s => s.penaltyApplied).length,
        symbol0: p.token0_symbol,
        symbol1: p.token1_symbol,
        currency0: p.token0_address,
        currency1: p.token1_address,
        decimals0: p.token0_decimals,
        decimals1: p.token1_decimals,
        fee: ps.length ? ps[0].baseFee : null,
        blockNumber: p.discovered_at,
        volume24h,
        volume24hSwaps: swaps24h.length,
        fees7d,
        apr7d,
        tvlUsd:   tvl?.tvlUsd   ?? null,
        tvlToken0: tvl ? `${tvl.amount0.toPrecision(4)} ${tvl.sym0}` : null,
        tvlToken1: tvl ? `${tvl.amount1.toPrecision(4)} ${tvl.sym1}` : null,
        logoUri0,
        logoUri1,
      };
    }));

    // Build pool lookup for symbol resolution
    const poolLookup = {};
    for (const p of rawPools) {
      poolLookup[p.chain + ':' + p.poolId] = p;
    }

    const swaps = rawSwaps.map(s => {
      const pool = poolLookup[s.chain + ':' + s.poolId];
      let symIn = null, symOut = null;
      if (pool && s.tokenIn) {
        symIn  = s.tokenIn  === pool.token0_address ? pool.token0_symbol : pool.token1_symbol;
        symOut = s.tokenOut === pool.token0_address ? pool.token0_symbol : pool.token1_symbol;
      }
      return {
        poolId:         s.poolId,
        chain:          s.chain,
        blockNumber:    s.block,
        timestamp:      estimateTs(s),
        txHash:         s.txHash,
        baseFee:        s.baseFee,
        finalFee:       s.finalFee,
        gasLevel:       s.gasLevel,
        penaltyApplied: !!s.penaltyApplied,
        strategy:       s.strategy,
        amountIn:       s.amountIn  ?? null,
        amountOut:      s.amountOut ?? null,
        tokenInSym:     symIn,
        tokenOutSym:    symOut,
        amount0:        s.amountIn  ?? null,
        amount1:        s.amountOut ?? null,
        usdValue:       swapUsdValue(s, pool, prices) ?? null,
      };
    });

    const totalBots = swaps.filter(s => s.penaltyApplied).length;
    const hookEventCounts = {};
    for (const s of swaps) {
      hookEventCounts[s.chain] = (hookEventCounts[s.chain] || 0) + 1;
    }

    const totalVolume24h = pools.reduce((a, p) => a + (p.volume24h || 0), 0);

    return {
      pools,
      swaps,
      hookEventCounts,
      nativePrices: { arbitrum: prices.eth, base: prices.eth, ethereum: prices.eth, bsc: prices.bnb },
      timestamp:  Date.now(),
      isLiveData: true,
      stats: {
        totalSwaps: swaps.length,
        totalBots,
        botRate: swaps.length ? (totalBots / swaps.length * 100).toFixed(1) : '0',
        totalVolume24h,
      }
    };
  } catch (err) {
    console.error('[buildPayload] Error:', err.message);
    return null;
  }
}

// All-chain indexer data — served instantly from cache
app.get('/api/indexer', (req, res) => {
  if (!indexerCache) {
    return res.status(503).json({ error: 'Data not ready yet — server is warming up, try again in a few seconds' });
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json(indexerCache);
});

// Static assets
app.use('/assets', express.static(path.join(__dirname, 'assets')));

/* ══════════════════════════════════════════
   STARTUP
══════════════════════════════════════════ */
app.listen(PORT, () => {
  console.log(`[server] BVCC Hook Analytics → http://localhost:${PORT}`);
  console.log(`[server] DB: ${DB_PATH}`);

  // Warm cache immediately, then refresh every 60s in background
  async function refreshCache() {
    const payload = await buildPayload();
    if (payload) {
      indexerCache = payload;
      console.log(`[server] Cache refreshed — ${payload.swaps.length} swaps, ${payload.pools.length} pools`);
    }
  }

  refreshCache();
  setInterval(refreshCache, 60_000);
});

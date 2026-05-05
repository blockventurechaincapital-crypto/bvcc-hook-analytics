// indexer.cjs — Multi-chain BVCC Hook indexer (4 chains, 1 SQLite DB)
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { ethers } = require('ethers');
const { getState, setState, poolExists, insertPool, insertSwap } = require('./db.cjs');
const { FEE_TOPIC, parseReceipt, discoverTokens, sqrtToPrice, resolveSwapDirection } = require('./parser.cjs');

const splitRpcs = (env, defaults) => env ? env.split(',').map(s => s.trim()).filter(Boolean) : defaults;

// ─── Chain configs ───────────────────────────────────────────────────────────
const CHAINS = {
  arbitrum: {
    name:        'Arbitrum',
    rpcs: splitRpcs(process.env.ARB_RPCS, [
      'https://arb-one.api.pocket.network',
      'https://arbitrum.meowrpc.com',
      'https://public-arb-mainnet.fastnode.io',
      'https://arbitrum-one.public.blastapi.io',
    ]),
    hook:        '0x2097d7329389264a1542Ad50802bB0DE84a650c4',
    poolManager: '0x360e68faccca8ca495c1b759fd9eee466db9fb32',
    deployBlock: 414666196,
    chunkSize:   2000,
    chunkDelay:  200,
  },
  bsc: {
    name:        'BSC',
    rpcs: splitRpcs(process.env.BSC_RPCS, [
      'https://bsc.api.pocket.network',
      'https://bsc.meowrpc.com',
      'https://bsc.publicnode.com',
      'https://bsc-dataseed1.ninicoin.io',
    ]),
    hook:        '0x8a36d8408F5285c3F81509947bc187b3c0eFD0C4',
    poolManager: '0x28e2ea090877bf75740558f6bfb36a5ffee9e9df',
    deployBlock: 72781693,
    chunkSize:   2000,
    chunkDelay:  200,
  },
  base: {
    name:        'Base',
    rpcs: splitRpcs(process.env.BASE_RPCS, [
      'https://rpc.ankr.com/base',
      'https://mainnet.base.org',
      'https://base.drpc.org',
      'https://base-rpc.publicnode.com',
    ]),
    hook:        '0x2c56c1302B6224B2bB1906c46F554622e12F10C4',
    poolManager: '0x498581ff718922c3f8e6a244956af099b2652b2b',
    deployBlock: 39977919,
    chunkSize:   2000,
    chunkDelay:  200,
  },
  ethereum: {
    name:        'Ethereum',
    rpcs: splitRpcs(process.env.ETH_RPCS, [
      'https://ethereum-rpc.publicnode.com',
      'https://eth.llamarpc.com',
      'https://ethereum-public.nodies.app',
      'https://eth-mainnet.public.blastapi.io',
    ]),
    hook:        '0xF9CED7D0F5292aF02385410Eda5B7570b10b50c4',
    poolManager: '0x000000000004444c5dc75cb358380d2e3de08a90',
    deployBlock: 24096297,
    chunkSize:   500,
    chunkDelay:  300,
  },
};

const POLL_INTERVAL_MS = 60_000; // 1 minute between polls per chain
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Try each RPC in order, return the first one that responds to getBlockNumber().
 * Returns { provider, rpcUrl } or null if all fail.
 */
async function getWorkingProvider(chainKey) {
  const { rpcs, name } = CHAINS[chainKey];
  for (const url of rpcs) {
    try {
      const provider = new ethers.providers.JsonRpcProvider(url);
      await Promise.race([
        provider.getBlockNumber(),
        new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 6000))
      ]);
      return { provider, rpcUrl: url };
    } catch (e) {
      console.warn(`[${chainKey}] RPC failed (${url}): ${e.message.slice(0, 60)}`);
    }
  }
  console.error(`[${chainKey}] All RPCs unavailable — skipping this poll cycle`);
  return null;
}

/**
 * Fetch FeeCalculated logs in chunked ranges for one chain.
 */
async function fetchFeeEvents(chainKey, cfg, provider, fromBlock, toBlock) {
  const events = [];
  const { chunkSize, chunkDelay } = cfg;
  const stateKey = `last_block_${chainKey}`;
  let failed = 0;
  // Cache block timestamps within this call to avoid redundant getBlock() calls
  const blockTsCache = new Map();
  async function getBlockTimestamp(blockNumber) {
    if (blockTsCache.has(blockNumber)) return blockTsCache.get(blockNumber);
    try {
      const blk = await provider.getBlock(blockNumber);
      const ts = blk?.timestamp ?? null;
      blockTsCache.set(blockNumber, ts);
      return ts;
    } catch { return null; }
  }

  for (let from = fromBlock; from <= toBlock; from += chunkSize) {
    const to = Math.min(from + chunkSize - 1, toBlock);
    try {
      const logs = await provider.getLogs({
        address: cfg.hook,
        topics:  [FEE_TOPIC],
        fromBlock: from,
        toBlock:   to,
      });

      if (logs.length > 0) {
        console.log(`  [${chainKey}] chunk ${from}-${to}: ${logs.length} events`);
        for (const log of logs) {
          try {
            const receipt = await provider.getTransactionReceipt(log.transactionHash);
            if (!receipt) continue;

            const { feeData, swapData } = parseReceipt(receipt, cfg.hook, cfg.poolManager, log);
            if (!feeData) continue;

            // Discover pool tokens if not yet known
            if (!poolExists(chainKey, feeData.poolId)) {
              const tokens = await discoverTokens(provider, receipt, cfg.hook, cfg.poolManager);
              if (tokens) {
                insertPool({
                  chain:            chainKey,
                  poolId:           feeData.poolId,
                  token0_address:   tokens.token0.address,
                  token0_symbol:    tokens.token0.symbol,
                  token0_decimals:  tokens.token0.decimals,
                  token1_address:   tokens.token1.address,
                  token1_symbol:    tokens.token1.symbol,
                  token1_decimals:  tokens.token1.decimals,
                  discovered_at:    log.blockNumber,
                });
                console.log(`  [${chainKey}] new pool: ${tokens.token0.symbol}/${tokens.token1.symbol} poolId=${feeData.poolId.slice(0, 14)}...`);
              }
            }

            // Resolve swap direction if Swap event present
            let tokenIn = null, tokenOut = null, amountIn = null, amountOut = null, price = null;
            if (swapData) {
              const pool = require('./db.cjs').db.prepare(
                'SELECT * FROM pools WHERE chain = ? AND poolId = ?'
              ).get(chainKey, feeData.poolId);
              if (pool) {
                const token0 = { address: pool.token0_address, decimals: pool.token0_decimals };
                const token1 = { address: pool.token1_address, decimals: pool.token1_decimals };
                const dir = resolveSwapDirection(swapData, token0, token1);
                tokenIn = dir.tokenIn; tokenOut = dir.tokenOut;
                amountIn = dir.amountIn; amountOut = dir.amountOut;
                price = sqrtToPrice(swapData.sqrtPriceX96, pool.token0_decimals, pool.token1_decimals);
              }
            }

            const blockTs = await getBlockTimestamp(log.blockNumber);
            insertSwap({
              chain:          chainKey,
              txHash:         log.transactionHash,
              block:          log.blockNumber,
              timestamp:      blockTs,
              poolId:         feeData.poolId,
              fromAddress:    feeData.user,
              tokenIn,  tokenOut,
              amountIn, amountOut,
              price,
              liquidity:      swapData?.liquidity ?? null,
              tick:           swapData?.tick ?? null,
              feeApplied:     feeData.finalFee,
              baseFee:        feeData.baseFee,
              finalFee:       feeData.finalFee,
              gasLevel:       feeData.gasLevel,
              penaltyApplied: feeData.penaltyApplied ? 1 : 0,
              strategy:       feeData.strategy,
            });

            events.push(feeData);
          } catch (e) {
            console.error(`  [${chainKey}] tx ${log.transactionHash.slice(0, 12)}... error: ${e.message}`);
          }
        }
      }
    } catch (e) {
      failed++;
      if (failed <= 3) {
        console.error(`  [${chainKey}] getLogs chunk ${from}-${to} failed: ${e.message.slice(0, 120)}`);
      }
    }

    // Save progress after every chunk — safe to Ctrl+C anytime
    setState(stateKey, String(to));

    await sleep(chunkDelay);
  }

  return events;
}

/**
 * Main polling loop for one chain. Runs forever.
 * On each cycle, resolves a working RPC — falls back through the list automatically.
 */
async function runChain(chainKey) {
  const cfg = CHAINS[chainKey];
  console.log(`[${chainKey}] Starting — hook ${cfg.hook}`);

  while (true) {
    try {
      // Resolve a working provider each cycle — handles RPC outages transparently
      const conn = await getWorkingProvider(chainKey);
      if (!conn) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      const { provider, rpcUrl } = conn;

      const currentBlock = await provider.getBlockNumber();
      const stateKey = `last_block_${chainKey}`;
      const lastBlock = parseInt(getState(stateKey) || String(cfg.deployBlock - 1));
      const fromBlock = lastBlock + 1;

      if (fromBlock > currentBlock) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      const isBackfill = (currentBlock - fromBlock) > cfg.chunkSize;
      if (isBackfill) {
        console.log(`[${chainKey}] BACKFILL: ${fromBlock.toLocaleString()} → ${currentBlock.toLocaleString()} (${(currentBlock - fromBlock).toLocaleString()} blocks) via ${rpcUrl}`);
      } else {
        console.log(`[${chainKey}] Scanning ${fromBlock.toLocaleString()} → ${currentBlock.toLocaleString()} via ${rpcUrl}`);
      }

      const events = await fetchFeeEvents(chainKey, cfg, provider, fromBlock, currentBlock);

      if (isBackfill) {
        console.log(`[${chainKey}] Backfill complete up to block ${currentBlock.toLocaleString()} — ${events.length} events`);
      } else if (events.length === 0) {
        console.log(`[${chainKey}] No events in range.`);
      }

    } catch (e) {
      console.error(`[${chainKey}] Poll error: ${e.message}`);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * One-time backfill: update timestamp for all existing rows that have NULL.
 * Groups by (chain, blockNumber) so each unique block is fetched only once.
 */
async function backfillTimestamps() {
  const { db } = require('./db.cjs');
  const nullRows = db.prepare('SELECT id, chain, block FROM swaps WHERE timestamp IS NULL').all();
  if (!nullRows.length) { console.log('[backfill] All timestamps already set.'); return; }
  console.log(`[backfill] Updating timestamps for ${nullRows.length} swaps…`);

  // Group by chain → Set of block numbers
  const byChain = {};
  for (const r of nullRows) {
    if (!byChain[r.chain]) byChain[r.chain] = new Set();
    byChain[r.chain].add(r.block);
  }

  const updateStmt = db.prepare('UPDATE swaps SET timestamp = ? WHERE id = ?');

  for (const [chainKey, blocks] of Object.entries(byChain)) {
    const cfg = CHAINS[chainKey];
    if (!cfg) continue;
    const conn = await getWorkingProvider(chainKey);
    if (!conn) { console.warn(`[backfill] No RPC for ${chainKey}, skipping`); continue; }
    const { provider } = conn;

    const blockTs = new Map();
    const blockArr = [...blocks];
    console.log(`[backfill] ${chainKey}: fetching ${blockArr.length} block timestamps…`);
    // Fetch in small parallel batches to avoid RPC overload
    const BATCH = 10;
    for (let i = 0; i < blockArr.length; i += BATCH) {
      const batch = blockArr.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(async bn => {
        try { const b = await provider.getBlock(bn); return [bn, b?.timestamp ?? null]; }
        catch { return [bn, null]; }
      }));
      for (const [bn, ts] of results) blockTs.set(bn, ts);
      await sleep(100);
    }

    // Apply updates in a transaction
    const rows = nullRows.filter(r => r.chain === chainKey);
    db.transaction(() => {
      for (const r of rows) {
        const ts = blockTs.get(r.block);
        if (ts != null) updateStmt.run(ts, r.id);
      }
    })();
    console.log(`[backfill] ${chainKey}: done (${rows.length} rows updated)`);
  }
  console.log('[backfill] Complete.');
}

// ─── Main ────────────────────────────────────────────────────────────────────
console.log('╔══════════════════════════════════════════════════════╗');
console.log('║   BVCC Hook Indexer — 4 Chains                      ║');
console.log('║   ARB · BSC · BASE · ETH                            ║');
console.log('╚══════════════════════════════════════════════════════╝');

const chainKeys = Object.keys(CHAINS);

// Run timestamp backfill first, then start chain loops
backfillTimestamps()
  .catch(e => console.error('[backfill] Error:', e.message))
  .finally(() => {
    // Stagger startup by 3s per chain to avoid burst RPC load
    Promise.all(
      chainKeys.map((key, i) =>
        sleep(i * 3000).then(() => runChain(key))
      )
    ).catch(console.error);
  });

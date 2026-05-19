// reindex-ml-pool.cjs — Re-fetches all ModifyLiquidity events for a single pool.
// Usage: node reindex-ml-pool.cjs <chain> <poolId>
// Example: node reindex-ml-pool.cjs bsc 0x085182518e82062e732fcb912becdf7140b42f8da31c7afd850db3c6d4309c8a
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { ethers } = require('ethers');
const { db, applyLiquidityDelta } = require('./db.cjs');

const [,, chainKey, poolId] = process.argv;
if (!chainKey || !poolId) {
  console.error('Usage: node reindex-ml-pool.cjs <chain> <poolId>');
  process.exit(1);
}

const splitRpcs = (env, defaults) => env ? env.split(',').map(s => s.trim()).filter(Boolean) : defaults;

const CHAIN_CONFIGS = {
  bsc: {
    rpcs:        splitRpcs(process.env.BSC_RPCS, ['https://bsc.publicnode.com']),
    poolManager: '0x28e2ea090877bf75740558f6bfb36a5ffee9e9df',
    deployBlock: 72781693,
    chunkSize:   2000,
    chunkDelay:  200,
  },
  arbitrum: {
    rpcs:        splitRpcs(process.env.ARB_RPCS, ['https://arb-one.api.pocket.network']),
    poolManager: '0x360e68faccca8ca495c1b759fd9eee466db9fb32',
    deployBlock: 414666196,
    chunkSize:   2000,
    chunkDelay:  200,
  },
  base: {
    rpcs:        splitRpcs(process.env.BASE_RPCS, ['https://rpc.ankr.com/base']),
    poolManager: '0x498581ff718922c3f8e6a244956af099b2652b2b',
    deployBlock: 39977919,
    chunkSize:   2000,
    chunkDelay:  200,
  },
  ethereum: {
    rpcs:        splitRpcs(process.env.ETH_RPCS, ['https://ethereum-rpc.publicnode.com']),
    poolManager: '0x000000000004444c5dc75cb358380d2e3de08a90',
    deployBlock: 24096297,
    chunkSize:    500,
    chunkDelay:   300,
  },
};

const cfg = CHAIN_CONFIGS[chainKey];
if (!cfg) {
  console.error(`Unknown chain: ${chainKey}. Valid: ${Object.keys(CHAIN_CONFIGS).join(', ')}`);
  process.exit(1);
}

const ML_TOPIC = ethers.utils.id('ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)');
const ML_IFACE = new ethers.utils.Interface([
  'event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)',
]);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getProvider() {
  for (const rpc of cfg.rpcs) {
    try {
      const p = new ethers.providers.JsonRpcProvider(rpc);
      await p.getBlockNumber();
      console.log(`[rpc] Using: ${rpc}`);
      return p;
    } catch {
      console.warn(`[rpc] Failed: ${rpc}`);
    }
  }
  throw new Error('No working RPC found');
}

async function main() {
  const normalizedPoolId = poolId.toLowerCase();
  console.log(`\nRe-indexing ML events for ${chainKey} pool ${normalizedPoolId}`);
  console.log(`Deploy block: ${cfg.deployBlock.toLocaleString()}\n`);

  const provider = await getProvider();
  const currentBlock = await provider.getBlockNumber();
  console.log(`Current block: ${currentBlock.toLocaleString()}`);

  // Show existing positions before wiping
  const existing = db.prepare('SELECT * FROM positions WHERE chain=? AND poolId=?').all(chainKey, normalizedPoolId);
  console.log(`\nExisting positions in DB: ${existing.length}`);
  for (const p of existing) {
    console.log(`  owner=${p.owner} ticks=[${p.tickLower},${p.tickUpper}] liquidity=${p.liquidity}`);
  }

  // Wipe existing positions for this pool only
  const deleted = db.prepare('DELETE FROM positions WHERE chain=? AND poolId=?').run(chainKey, normalizedPoolId);
  console.log(`\nDeleted ${deleted.changes} position row(s) — re-fetching from block ${cfg.deployBlock.toLocaleString()}...\n`);

  const totalChunks = Math.ceil((currentBlock - cfg.deployBlock) / cfg.chunkSize);
  let chunk = 0;
  let totalLogs = 0;

  for (let from = cfg.deployBlock; from <= currentBlock; from += cfg.chunkSize) {
    const to = Math.min(from + cfg.chunkSize - 1, currentBlock);
    chunk++;

    if (chunk % 50 === 1) {
      const pct = ((from - cfg.deployBlock) / (currentBlock - cfg.deployBlock) * 100).toFixed(1);
      console.log(`  chunk ${chunk}/${totalChunks} — block ${from.toLocaleString()} (${pct}%)`);
    }

    let logs = null;
    let attempt = 0;
    while (logs === null) {
      attempt++;
      try {
        logs = await provider.getLogs({
          address: cfg.poolManager,
          topics:  [ML_TOPIC, normalizedPoolId],
          fromBlock: from,
          toBlock:   to,
        });
      } catch (e) {
        const wait = Math.min(2000 * attempt, 30000);
        console.error(`  getLogs error [${from}-${to}] attempt ${attempt} — retrying in ${wait/1000}s: ${e.message.slice(0, 80)}`);
        await sleep(wait);
      }
    }

    for (const log of logs) {
      try {
        const { args } = ML_IFACE.parseLog(log);
        applyLiquidityDelta(
          chainKey,
          args.id.toLowerCase(),
          args.sender.toLowerCase(),
          args.tickLower,
          args.tickUpper,
          args.salt,
          args.liquidityDelta.toString(),
        );
        totalLogs++;
      } catch (e) {
        console.error(`  Parse error at block ${log.blockNumber}: ${e.message.slice(0, 80)}`);
      }
    }

    if (cfg.chunkDelay > 0) await sleep(cfg.chunkDelay);
  }

  // Show final positions
  const final = db.prepare('SELECT * FROM positions WHERE chain=? AND poolId=?').all(chainKey, normalizedPoolId);
  console.log(`\nDone. ${totalLogs} ML events processed.`);
  console.log(`Final positions in DB: ${final.length}`);
  for (const p of final) {
    console.log(`  owner=${p.owner} ticks=[${p.tickLower},${p.tickUpper}] liquidity=${p.liquidity}`);
  }

  const totalL = final.reduce((s, p) => s + BigInt(p.liquidity), 0n);
  console.log(`\nTotal liquidity: ${totalL.toString()}`);
  console.log(`Expected (from last swap): 94124985428445247`);
}

main().catch(e => { console.error(e); process.exit(1); });

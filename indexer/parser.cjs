// parser.cjs — Receipt parsing: token discovery, swap direction, price calculation
'use strict';

const { ethers } = require('ethers');

// Minimal ERC20 ABI
const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)'
];

// Transfer topic (ERC20 standard)
const TRANSFER_TOPIC = ethers.utils.id('Transfer(address,address,uint256)');
// WBNB/WETH Withdrawal topic
const WITHDRAWAL_TOPIC = ethers.utils.id('Withdrawal(address,uint256)');
// WBNB/WETH Deposit topic
const DEPOSIT_TOPIC = ethers.utils.id('Deposit(address,uint256)');

const FEE_CALCULATED_ABI = [
  'event FeeCalculated(bytes32 indexed poolId, address indexed user, uint24 baseFee, uint24 finalFee, uint256 gasPrice, string gasLevel, bool penaltyApplied, string strategy)'
];

const SWAP_ABI = [
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)'
];

const FEE_IFACE = new ethers.utils.Interface(FEE_CALCULATED_ABI);
const SWAP_IFACE = new ethers.utils.Interface(SWAP_ABI);

const FEE_TOPIC = FEE_IFACE.getEventTopic('FeeCalculated');
const SWAP_TOPIC = SWAP_IFACE.getEventTopic('Swap');

/**
 * Try to call symbol() and decimals() on an address.
 * Returns null if the contract doesn't respond (not ERC20).
 */
async function tryGetTokenInfo(provider, address) {
  const contract = new ethers.Contract(address, ERC20_ABI, provider);
  try {
    const [symbol, decimals] = await Promise.all([
      contract.symbol(),
      contract.decimals()
    ]);
    return { address: address.toLowerCase(), symbol, decimals: Number(decimals) };
  } catch {
    return null;
  }
}

/**
 * From a transaction receipt, discover the two pool tokens.
 * poolManager: chain-specific PoolManager address.
 */
async function discoverTokens(provider, receipt, hookAddress, poolManager) {
  const hookLower = hookAddress.toLowerCase();
  const pmLower = poolManager.toLowerCase();

  // Step 1: unique contract addresses (excluding PM and hook itself)
  const addresses = new Set();
  for (const log of receipt.logs) {
    const addr = log.address.toLowerCase();
    if (addr !== pmLower && addr !== hookLower) {
      addresses.add(addr);
    }
  }

  if (addresses.size === 0) return null;

  // Step 2: parallel ERC20 probe
  const results = await Promise.all(
    [...addresses].map(addr => tryGetTokenInfo(provider, addr))
  );
  const erc20s = results.filter(Boolean);

  if (erc20s.length === 0) return null;

  // Step 3: find tokens with Transfer/Withdrawal involving PoolManager
  const pmPaddedLower = '0x' + pmLower.replace('0x', '').padStart(64, '0');
  const pmRelated = new Set();

  for (const log of receipt.logs) {
    const topic0 = log.topics[0];
    if (!topic0) continue;

    if (topic0 === TRANSFER_TOPIC && log.topics.length >= 3) {
      const from = log.topics[1].toLowerCase();
      const to = log.topics[2].toLowerCase();
      if (from === pmPaddedLower || to === pmPaddedLower) {
        pmRelated.add(log.address.toLowerCase());
      }
    } else if (topic0 === WITHDRAWAL_TOPIC || topic0 === DEPOSIT_TOPIC) {
      const addr = log.address.toLowerCase();
      if (erc20s.some(t => t.address === addr)) {
        pmRelated.add(addr);
      }
    }
  }

  let candidates = erc20s.filter(t => pmRelated.has(t.address));

  // Step 4: fallback — use all ERC20s sorted by address (Uniswap v4 ordering: token0 < token1)
  if (candidates.length < 2) {
    candidates = erc20s.slice().sort((a, b) => a.address.localeCompare(b.address));
  }

  if (candidates.length < 2) return null;

  candidates.sort((a, b) => a.address.localeCompare(b.address));
  return { token0: candidates[0], token1: candidates[1] };
}

/**
 * Compute price from sqrtPriceX96.
 */
function sqrtToPrice(sqrtPriceX96, decimals0, decimals1) {
  try {
    const Q96 = 2n ** 96n;
    const sq = BigInt(sqrtPriceX96.toString());
    const d0 = BigInt(10 ** decimals0);
    const d1 = BigInt(10 ** decimals1);
    const numerator = sq * sq * d0;
    const denominator = Q96 * Q96 * d1;
    if (denominator === 0n) return null;
    return Number(numerator * 1000000n / denominator) / 1000000;
  } catch {
    return null;
  }
}

/**
 * Parse a receipt that contains a FeeCalculated event.
 * feeLog: the specific FeeCalculated log that triggered this call (from getLogs).
 *         Passing it avoids the bug where multiple FeeCalculated events in the same
 *         tx cause the parser to use the wrong one (last-wins overwrite).
 */
function parseReceipt(receipt, hookAddress, poolManager, feeLog = null) {
  const hookLower = hookAddress.toLowerCase();
  const pmLower = poolManager.toLowerCase();
  let feeData = null;
  const swapCandidates = [];

  // Parse the specific FeeCalculated event we were called for.
  // Matching by logIndex is reliable — each log in a receipt has a unique index.
  const targetLogIndex = feeLog?.logIndex ?? null;

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() === hookLower && log.topics[0] === FEE_TOPIC) {
      // If we have a specific log, only parse that one; skip all others.
      if (targetLogIndex !== null && log.logIndex !== targetLogIndex) continue;
      try {
        const parsed = FEE_IFACE.parseLog(log);
        feeData = {
          poolId: parsed.args.poolId,
          user: parsed.args.user,
          baseFee: parsed.args.baseFee,
          finalFee: parsed.args.finalFee,
          gasPrice: parsed.args.gasPrice.toString(),
          gasLevel: parsed.args.gasLevel,
          penaltyApplied: parsed.args.penaltyApplied,
          strategy: parsed.args.strategy
        };
      } catch (e) {
        console.error('[parser] Failed to parse FeeCalculated:', e.message);
      }
    }

    if (log.address.toLowerCase() === pmLower && log.topics[0] === SWAP_TOPIC) {
      try {
        const parsed = SWAP_IFACE.parseLog(log);
        swapCandidates.push({
          poolId: parsed.args.id,
          sender: parsed.args.sender,
          amount0: parsed.args.amount0.toString(),
          amount1: parsed.args.amount1.toString(),
          sqrtPriceX96: parsed.args.sqrtPriceX96,
          liquidity: parsed.args.liquidity.toString(),
          tick: parsed.args.tick,
          fee: parsed.args.fee
        });
      } catch (e) {
        console.error('[parser] Failed to parse Swap:', e.message);
      }
    }
  }

  // Match the Swap event whose poolId == feeData.poolId — prevents multi-hop
  // tx contamination where another pool's Swap event is picked up.
  let swapData = null;
  if (feeData && swapCandidates.length > 0) {
    swapData = swapCandidates.find(
      s => s.poolId.toLowerCase() === feeData.poolId.toLowerCase()
    ) || null;
  }

  return { feeData, swapData };
}

/**
 * Determine swap direction and amounts.
 */
function resolveSwapDirection(swapData, token0, token1) {
  const amount0 = BigInt(swapData.amount0);
  const amount1 = BigInt(swapData.amount1);

  let tokenIn, tokenOut, amountIn, amountOut;

  if (amount0 > 0n) {
    tokenIn = token0.address;
    tokenOut = token1.address;
    amountIn = ethers.utils.formatUnits(amount0.toString(), token0.decimals);
    amountOut = ethers.utils.formatUnits((amount1 < 0n ? -amount1 : amount1).toString(), token1.decimals);
  } else {
    tokenIn = token1.address;
    tokenOut = token0.address;
    amountIn = ethers.utils.formatUnits(amount1.toString(), token1.decimals);
    amountOut = ethers.utils.formatUnits((amount0 < 0n ? -amount0 : amount0).toString(), token0.decimals);
  }

  return { tokenIn, tokenOut, amountIn, amountOut };
}

module.exports = {
  FEE_TOPIC,
  SWAP_TOPIC,
  parseReceipt,
  discoverTokens,
  sqrtToPrice,
  resolveSwapDirection
};

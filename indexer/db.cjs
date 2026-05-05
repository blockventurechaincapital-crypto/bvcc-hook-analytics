// db.cjs — SQLite initialization and helpers (better-sqlite3, synchronous)
'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'bvcc_indexer.db');
const db = new Database(DB_PATH);

// Enable WAL for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables — chain column added for multi-chain support
db.exec(`
  CREATE TABLE IF NOT EXISTS pools (
    chain TEXT NOT NULL,
    poolId TEXT NOT NULL,
    token0_address TEXT,
    token0_symbol TEXT,
    token0_decimals INTEGER,
    token1_address TEXT,
    token1_symbol TEXT,
    token1_decimals INTEGER,
    discovered_at INTEGER,
    PRIMARY KEY (chain, poolId)
  );

  CREATE TABLE IF NOT EXISTS swaps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chain TEXT NOT NULL,
    txHash TEXT NOT NULL,
    block INTEGER,
    timestamp INTEGER,
    poolId TEXT,
    fromAddress TEXT,
    tokenIn TEXT,
    tokenOut TEXT,
    amountIn TEXT,
    amountOut TEXT,
    price REAL,
    liquidity TEXT,
    tick INTEGER,
    feeApplied INTEGER,
    baseFee INTEGER,
    finalFee INTEGER,
    gasLevel TEXT,
    penaltyApplied INTEGER,
    strategy TEXT,
    UNIQUE (chain, txHash, poolId)
  );

  CREATE TABLE IF NOT EXISTS indexer_state (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Migration: if swaps table was created with old UNIQUE(chain, txHash),
// recreate it with UNIQUE(chain, txHash, poolId) so multi-pool transactions
// (same txHash, different poolId) can each have their own row.
{
  const schemaSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='swaps'").get()?.sql || '';
  const hasOldConstraint = /UNIQUE\s*\(\s*chain\s*,\s*txHash\s*\)/.test(schemaSql);
  if (hasOldConstraint) {
    console.log('[db] Migrating swaps table: UNIQUE(chain,txHash) → UNIQUE(chain,txHash,poolId)');
    db.exec(`
      CREATE TABLE swaps_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chain TEXT NOT NULL,
        txHash TEXT NOT NULL,
        block INTEGER,
        timestamp INTEGER,
        poolId TEXT,
        fromAddress TEXT,
        tokenIn TEXT,
        tokenOut TEXT,
        amountIn TEXT,
        amountOut TEXT,
        price REAL,
        liquidity TEXT,
        tick INTEGER,
        feeApplied INTEGER,
        baseFee INTEGER,
        finalFee INTEGER,
        gasLevel TEXT,
        penaltyApplied INTEGER,
        strategy TEXT,
        UNIQUE (chain, txHash, poolId)
      );
      INSERT OR IGNORE INTO swaps_v2
        SELECT id,chain,txHash,block,timestamp,poolId,fromAddress,tokenIn,tokenOut,
               amountIn,amountOut,price,liquidity,tick,feeApplied,
               baseFee,finalFee,gasLevel,penaltyApplied,strategy
        FROM swaps;
      DROP TABLE swaps;
      ALTER TABLE swaps_v2 RENAME TO swaps;
    `);
    console.log('[db] Migration complete.');
  }
}

// Prepared statements
const stmts = {
  getState:   db.prepare('SELECT value FROM indexer_state WHERE key = ?'),
  setState:   db.prepare('INSERT OR REPLACE INTO indexer_state (key, value) VALUES (?, ?)'),
  getPool:    db.prepare('SELECT * FROM pools WHERE chain = ? AND poolId = ?'),
  insertPool: db.prepare(`
    INSERT OR IGNORE INTO pools
      (chain, poolId, token0_address, token0_symbol, token0_decimals,
       token1_address, token1_symbol, token1_decimals, discovered_at)
    VALUES
      (@chain, @poolId, @token0_address, @token0_symbol, @token0_decimals,
       @token1_address, @token1_symbol, @token1_decimals, @discovered_at)
  `),
  insertSwap: db.prepare(`
    INSERT OR IGNORE INTO swaps
      (chain, txHash, block, timestamp, poolId, fromAddress, tokenIn, tokenOut,
       amountIn, amountOut, price, liquidity, tick, feeApplied,
       baseFee, finalFee, gasLevel, penaltyApplied, strategy)
    VALUES
      (@chain, @txHash, @block, @timestamp, @poolId, @fromAddress, @tokenIn, @tokenOut,
       @amountIn, @amountOut, @price, @liquidity, @tick, @feeApplied,
       @baseFee, @finalFee, @gasLevel, @penaltyApplied, @strategy)
  `)
};

function getState(key)         { const r = stmts.getState.get(key); return r ? r.value : null; }
function setState(key, value)  { stmts.setState.run(key, String(value)); }
function poolExists(chain, poolId) { return !!stmts.getPool.get(chain, poolId); }
function insertPool(pool)      { stmts.insertPool.run(pool); }
function insertSwap(swap)      { stmts.insertSwap.run(swap); }

module.exports = { db, getState, setState, poolExists, insertPool, insertSwap };

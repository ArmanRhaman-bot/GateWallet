import express from "express";
import {
  HDNodeWallet,
  Mnemonic,
  JsonRpcProvider,
  Contract,
  formatUnits,
  id,
  isAddress
} from "ethers";
import pg from "pg";
import * as bip39 from "bip39";
import BIP32Factory from "bip32";
import * as ecc from "tiny-secp256k1";
import * as bitcoin from "bitcoinjs-lib";
import { TronWeb } from "tronweb";
import { Keypair, PublicKey } from "@solana/web3.js";
import { derivePath } from "ed25519-hd-key";
import {
  mnemonicToHDSeed,
  deriveEd25519Path,
  keyPairFromSeed
} from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";
import bs58 from "bs58";

const { Pool } = pg;
const bip32 = BIP32Factory(ecc);

const app = express();
app.use(express.json({ limit: "64kb" }));

/* =========================================================
   CONFIG
========================================================= */

const PORT = Number(process.env.PORT || 3000);
const API_KEY = String(process.env.BOT_API_KEY || "").trim();
const MASTER_MNEMONIC = String(process.env.MASTER_MNEMONIC || "").trim();
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();

const CONFIRMATIONS = Math.max(1, Number(process.env.CONFIRMATIONS || 3));
const SCAN_INTERVAL_MS = Math.max(20000, Number(process.env.SCAN_INTERVAL_MS || 30000));
const EVM_SCAN_BLOCKS = Math.max(1, Number(process.env.EVM_SCAN_BLOCKS || 20));
const EVM_LOG_CHUNK = Math.max(1, Number(process.env.EVM_LOG_CHUNK || 5));
const EXTERNAL_PAGE_LIMIT = Math.min(200, Math.max(10, Number(process.env.EXTERNAL_PAGE_LIMIT || 50)));
const MAX_SCAN_USERS = Math.min(5000, Math.max(1, Number(process.env.MAX_SCAN_USERS || 500)));
const EXPORT_PRIVATE_KEYS = String(process.env.EXPORT_PRIVATE_KEYS || "false").toLowerCase() === "true";

if (!API_KEY || !MASTER_MNEMONIC || !DATABASE_URL) {
  console.error("❌ Missing BOT_API_KEY, MASTER_MNEMONIC or DATABASE_URL");
  process.exit(1);
}

/* =========================================================
   DATABASE
========================================================= */

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("localhost") || DATABASE_URL.includes("127.0.0.1")
    ? false
    : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on("error", e => console.error("❌ PostgreSQL pool error:", e.message));

/* =========================================================
   EVM CHAINS
========================================================= */

const chains = {
  bsc: {
    name: "BSC",
    chainId: 56,
    native: "BNB",
    explorer: "https://bscscan.com/tx/",
    rpcs: (
      process.env.BSC_RPC_URLS ||
      "https://bsc-rpc.publicnode.com,https://bnb.rpc.subquery.network/public"
    ).split(",").map(x => x.trim()).filter(Boolean)
  },

  eth: {
    name: "Ethereum",
    chainId: 1,
    native: "ETH",
    explorer: "https://etherscan.io/tx/",
    rpcs: (
      process.env.ETH_RPC_URLS ||
      "https://ethereum-rpc.publicnode.com,https://cloudflare-eth.com"
    ).split(",").map(x => x.trim()).filter(Boolean)
  },

  polygon: {
    name: "Polygon",
    chainId: 137,
    native: "POL",
    explorer: "https://polygonscan.com/tx/",
    rpcs: (
      process.env.POLYGON_RPC_URLS ||
      "https://polygon-bor-rpc.publicnode.com"
    ).split(",").map(x => x.trim()).filter(Boolean)
  }
};

/* =========================================================
   EVM TOKENS
   USDT: BSC / Ethereum / Polygon
   USDC: BSC (BEP20) only
========================================================= */

const tokens = {
  bsc: {
    USDT: {
      address: "0x55d398326f99059f775485246999027b3197955",
      decimals: 18
    },
    USDC: {
      address: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
      decimals: 18
    }
  },

  eth: {
    USDT: {
      address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
      decimals: 6
    }
  },

  polygon: {
    USDT: {
      address: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
      decimals: 6
    }
  }
};

const ERC20_ABI = [
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "function balanceOf(address) view returns (uint256)"
];

const TRANSFER_TOPIC = id("Transfer(address,address,uint256)");

/* =========================================================
   NON-EVM NETWORK CONFIG
========================================================= */

const BTC_API = String(process.env.BTC_API_URL || "https://blockstream.info/api").replace(/\/+$/, "");
const TRON_API = String(process.env.TRON_API_URL || "https://api.trongrid.io").replace(/\/+$/, "");
const TRON_API_KEY = String(process.env.TRON_API_KEY || "").trim();

const TON_RPC = String(
  process.env.TON_RPC_URL || "https://toncenter.com/api/v2/jsonRPC"
).trim();
const TON_API_KEY = String(process.env.TON_API_KEY || "").trim();

const SOL_RPC = String(
  process.env.SOL_RPC_URL || "https://api.mainnet-beta.solana.com"
).trim();

const TRON_USDT_CONTRACT =
  "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

/* =========================================================
   MASTER DERIVATION
========================================================= */

const mnemonic = Mnemonic.fromPhrase(MASTER_MNEMONIC);

const evmMaster = HDNodeWallet.fromMnemonic(
  mnemonic,
  "m/44'/60'/0'/0"
);

const seed = bip39.mnemonicToSeedSync(MASTER_MNEMONIC);

function assertIndex(index) {
  const n = Number(index);
  if (!Number.isInteger(n) || n < 0 || n > 0x7fffffff) {
    throw new Error(`Invalid wallet index: ${index}`);
  }
  return n;
}

function deriveEvm(index) {
  return evmMaster.deriveChild(assertIndex(index));
}

function deriveBtc(index) {
  const root = bip32.fromSeed(seed, bitcoin.networks.bitcoin);
  return root.derivePath(`m/84'/0'/0'/0/${assertIndex(index)}`);
}

function deriveTron(index) {
  const root = bip32.fromSeed(seed);
  return root.derivePath(`m/44'/195'/0'/0/${assertIndex(index)}`);
}

function deriveSolana(index) {
  const path = `m/44'/501'/${assertIndex(index)}'/0'`;
  const derived = derivePath(path, seed.toString("hex")).key;
  return Keypair.fromSeed(derived);
}

async function deriveTon(index) {
  const hdSeed = await mnemonicToHDSeed(MASTER_MNEMONIC);
  const derived = await deriveEd25519Path(
    hdSeed,
    [44, 607, 0, 0, assertIndex(index)]
  );
  const kp = keyPairFromSeed(derived);
  return WalletContractV4.create({
    workchain: 0,
    publicKey: kp.publicKey
  });
}

/* =========================================================
   WALLET SNAPSHOT
========================================================= */

async function deriveAllWallets(index) {
  const n = assertIndex(index);

  const evm = deriveEvm(n);
  const btc = deriveBtc(n);
  const tron = deriveTron(n);
  const sol = deriveSolana(n);
  const tonWallet = await deriveTon(n);

  const btcPayment = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(btc.publicKey),
    network: bitcoin.networks.bitcoin
  });

  if (!btcPayment.address) {
    throw new Error("Failed to derive BTC address");
  }

  return {
    walletIndex: n,

    evmAddress: evm.address,

    btcAddress: btcPayment.address,

    tronAddress: TronWeb.address.fromPrivateKey(
      Buffer.from(tron.privateKey).toString("hex")
    ),

    solAddress: sol.publicKey.toBase58(),

    tonAddress: tonWallet.address.toString({
      bounceable: false,
      urlSafe: true
    })
  };
}

/* =========================================================
   PRIVATE KEY SNAPSHOT
   Only for an address that already belongs to wallet_users.
========================================================= */

async function privateKeyForNetwork(index, network) {
  const n = assertIndex(index);

  if (["bsc", "eth", "polygon", "evm"].includes(network)) {
    return {
      network,
      path: `m/44'/60'/0'/0/${n}`,
      privateKey: deriveEvm(n).privateKey
    };
  }

  if (network === "btc") {
    const node = deriveBtc(n);
    return {
      network,
      path: `m/84'/0'/0'/0/${n}`,
      privateKey: node.toWIF()
    };
  }

  if (network === "tron") {
    const node = deriveTron(n);
    return {
      network,
      path: `m/44'/195'/0'/0/${n}`,
      privateKey: Buffer.from(node.privateKey).toString("hex")
    };
  }

  if (network === "sol") {
    const kp = deriveSolana(n);
    return {
      network,
      path: `m/44'/501'/${n}'/0'`,
      privateKey: bs58.encode(kp.secretKey)
    };
  }

  if (network === "ton" || network === "gram") {
    const hdSeed = await mnemonicToHDSeed(MASTER_MNEMONIC);
    const derived = await deriveEd25519Path(
      hdSeed,
      [44, 607, 0, 0, n]
    );
    const kp = keyPairFromSeed(derived);
    return {
      network: "ton",
      path: `m/44'/607'/0'/0/${n}`,
      privateKey: Buffer.from(kp.secretKey).toString("hex")
    };
  }

  throw new Error("Unsupported network");
}

/* =========================================================
   AUTH
========================================================= */

function auth(req, res, next) {
  const key = req.get("x-api-key");
  if (!key || key !== API_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

function validTelegramId(v) {
  return /^\d+$/.test(String(v || ""));
}

function errorText(e) {
  return String(e?.shortMessage || e?.reason || e?.message || e || "Unknown error");
}

/* =========================================================
   DATABASE
========================================================= */

async function initDb() {
  await pool.query(`
    CREATE SEQUENCE IF NOT EXISTS wallet_index_seq
      START 0 MINVALUE 0;

    CREATE TABLE IF NOT EXISTS wallet_users (
      id BIGSERIAL PRIMARY KEY,
      telegram_id TEXT UNIQUE NOT NULL,
      wallet_index BIGINT UNIQUE NOT NULL,
      address TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE wallet_users
      ADD COLUMN IF NOT EXISTS evm_address TEXT;

    ALTER TABLE wallet_users
      ADD COLUMN IF NOT EXISTS btc_address TEXT;

    ALTER TABLE wallet_users
      ADD COLUMN IF NOT EXISTS tron_address TEXT;

    ALTER TABLE wallet_users
      ADD COLUMN IF NOT EXISTS sol_address TEXT;

    ALTER TABLE wallet_users
      ADD COLUMN IF NOT EXISTS ton_address TEXT;

    UPDATE wallet_users
      SET evm_address = COALESCE(evm_address, address)
      WHERE evm_address IS NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS wallet_users_evm_address_idx
      ON wallet_users(LOWER(evm_address));

    CREATE UNIQUE INDEX IF NOT EXISTS wallet_users_btc_address_idx
      ON wallet_users(LOWER(btc_address))
      WHERE btc_address IS NOT NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS wallet_users_tron_address_idx
      ON wallet_users(LOWER(tron_address))
      WHERE tron_address IS NOT NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS wallet_users_sol_address_idx
      ON wallet_users(sol_address)
      WHERE sol_address IS NOT NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS wallet_users_ton_address_idx
      ON wallet_users(LOWER(ton_address))
      WHERE ton_address IS NOT NULL;

    CREATE TABLE IF NOT EXISTS deposits (
      id BIGSERIAL PRIMARY KEY,
      telegram_id TEXT NOT NULL,
      chain TEXT NOT NULL,
      symbol TEXT NOT NULL,
      amount NUMERIC(78,30) NOT NULL,
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL DEFAULT 0,
      block_number BIGINT NOT NULL DEFAULT 0,
      confirmations INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      deposit_address TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(chain, tx_hash, log_index, symbol)
    );

    CREATE INDEX IF NOT EXISTS deposits_status_idx
      ON deposits(status, id);

    CREATE INDEX IF NOT EXISTS deposits_address_idx
      ON deposits(deposit_address);

    CREATE TABLE IF NOT EXISTS scanner_cursors (
      scanner TEXT PRIMARY KEY,
      cursor TEXT NOT NULL DEFAULT '0',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  console.log("✅ Database initialized");
}

/* =========================================================
   WALLET CREATE / GET
========================================================= */

async function getOrCreateWallet(telegramId) {
  const old = await pool.query(`
    SELECT telegram_id, wallet_index, address,
           evm_address, btc_address, tron_address,
           sol_address, ton_address, created_at
    FROM wallet_users
    WHERE telegram_id=$1
  `, [telegramId]);

  if (old.rows.length) {
    const row = old.rows[0];

    const all = await deriveAllWallets(Number(row.wallet_index));

    await pool.query(`
      UPDATE wallet_users
      SET address=$2,
          evm_address=$2,
          btc_address=$3,
          tron_address=$4,
          sol_address=$5,
          ton_address=$6
      WHERE telegram_id=$1
    `, [
      telegramId,
      all.evmAddress,
      all.btcAddress,
      all.tronAddress,
      all.solAddress,
      all.tonAddress
    ]);

    return {
      ...row,
      wallet_index: Number(row.wallet_index),
      address: all.evmAddress,
      ...all,
      existing: true
    };
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const seq = await client.query(`
      SELECT nextval('wallet_index_seq') AS n
    `);

    const index = Number(seq.rows[0].n);
    const all = await deriveAllWallets(index);

    const inserted = await client.query(`
      INSERT INTO wallet_users
      (
        telegram_id,
        wallet_index,
        address,
        evm_address,
        btc_address,
        tron_address,
        sol_address,
        ton_address
      )
      VALUES ($1,$2,$3,$3,$4,$5,$6,$7)
      RETURNING *
    `, [
      telegramId,
      index,
      all.evmAddress,
      all.btcAddress,
      all.tronAddress,
      all.solAddress,
      all.tonAddress
    ]);

    await client.query("COMMIT");

    return {
      ...inserted.rows[0],
      wallet_index: index,
      ...all,
      existing: false
    };
  } catch (e) {
    await client.query("ROLLBACK");

    if (e.code === "23505") {
      return getOrCreateWallet(telegramId);
    }

    throw e;
  } finally {
    client.release();
  }
}

async function getUsers() {
  const q = await pool.query(`
    SELECT telegram_id, wallet_index, address,
           evm_address, btc_address, tron_address,
           sol_address, ton_address
    FROM wallet_users
    ORDER BY wallet_index ASC
    LIMIT $1
  `, [MAX_SCAN_USERS]);

  return q.rows;
}

/* =========================================================
   INSERT DEPOSIT
========================================================= */

async function insertDeposit({
  telegramId,
  chain,
  symbol,
  amount,
  txHash,
  logIndex = 0,
  blockNumber = 0,
  confirmations = 0,
  status = "pending",
  depositAddress
}) {
  if (!amount || Number(amount) <= 0) return false;

  const q = await pool.query(`
    INSERT INTO deposits
    (
      telegram_id,
      chain,
      symbol,
      amount,
      tx_hash,
      log_index,
      block_number,
      confirmations,
      status,
      deposit_address
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (chain, tx_hash, log_index, symbol)
    DO NOTHING
    RETURNING id
  `, [
    telegramId,
    chain,
    symbol,
    String(amount),
    txHash,
    Number(logIndex) || 0,
    Number(blockNumber) || 0,
    Number(confirmations) || 0,
    status,
    depositAddress || null
  ]);

  if (q.rows.length) {
    console.log(
      `💰 Deposit ${chain}/${symbol}: ${amount} -> ${telegramId} (${txHash})`
    );
    return true;
  }

  return false;
}

/* =========================================================
   EVM PROVIDERS
========================================================= */

function createProvider(chainKey, rpc) {
  const chain = chains[chainKey];

  return new JsonRpcProvider(
    rpc,
    { name: chain.name.toLowerCase(), chainId: chain.chainId },
    { staticNetwork: true }
  );
}

async function testProvider(chainKey, rpc) {
  const p = createProvider(chainKey, rpc);
  const network = await p.getNetwork();

  if (Number(network.chainId) !== chains[chainKey].chainId) {
    throw new Error(
      `Wrong network from RPC. Expected ${chains[chainKey].chainId}, got ${network.chainId}`
    );
  }

  await p.getBlockNumber();
  return p;
}

async function withProvider(chainKey, fn) {
  let last = null;

  for (const rpc of chains[chainKey].rpcs) {
    try {
      const p = await testProvider(chainKey, rpc);
      return await fn(p);
    } catch (e) {
      last = e;
      console.error(`[RPC RETRY] ${chainKey} ${rpc}: ${errorText(e)}`);
    }
  }

  throw last || new Error(`RPC failed for ${chainKey}`);
}

/* =========================================================
   EVM TOKEN LOG SCANNER
   IMPORTANT:
   - Does NOT use ENS resolution.
   - Uses exact lowercase token addresses.
   - Reads raw topics/data instead of log.args.
========================================================= */

async function getLogsAdaptive(provider, address, topics, fromBlock, toBlock) {
  const logs = [];
  let start = Number(fromBlock);
  const end = Number(toBlock);
  let chunk = EVM_LOG_CHUNK;

  while (start <= end) {
    const currentEnd = Math.min(end, start + chunk - 1);

    try {
      const result = await provider.getLogs({
        address: String(address).toLowerCase(),
        topics,
        fromBlock: start,
        toBlock: currentEnd
      });

      logs.push(...result);
      start = currentEnd + 1;

      if (chunk < EVM_LOG_CHUNK) {
        chunk = Math.min(EVM_LOG_CHUNK, chunk * 2);
      }
    } catch (e) {
      const msg = errorText(e).toLowerCase();

      const limited =
        msg.includes("limit") ||
        msg.includes("too many") ||
        msg.includes("timeout") ||
        msg.includes("413") ||
        msg.includes("429") ||
        msg.includes("request entity") ||
        msg.includes("cannot slice") ||
        msg.includes("buffer overrun");

      if (limited && chunk > 1) {
        chunk = Math.max(1, Math.floor(chunk / 2));
        console.warn(`[LOGS] reducing chunk -> ${chunk}: ${errorText(e)}`);
        continue;
      }

      throw e;
    }
  }

  return logs;
}

function topicAddress(topic) {
  if (!topic || topic.length < 42) return "";
  return "0x" + topic.slice(-40).toLowerCase();
}

function rawUint256(data) {
  if (!data || data === "0x") return 0n;
  return BigInt(data);
}

async function scanEvmToken(chainKey, symbol, info, users, latestBlock) {
  if (!users.length) return;

  const map = new Map();

  for (const u of users) {
    if (u.evm_address) {
      map.set(u.evm_address.toLowerCase(), u);
    }
  }

  const fromBlock = Math.max(
    0,
    Number(latestBlock) - EVM_SCAN_BLOCKS + 1
  );

  const logs = await withProvider(chainKey, p =>
    getLogsAdaptive(
      p,
      info.address,
      [TRANSFER_TOPIC, null, null],
      fromBlock,
      Number(latestBlock)
    )
  );

  for (const log of logs) {
    try {
      const to = topicAddress(log.topics?.[2]);
      const user = map.get(to);

      if (!user) continue;

      const value = rawUint256(log.data);
      if (value <= 0n) continue;

      const amount = formatUnits(value, info.decimals);

      await insertDeposit({
        telegramId: user.telegram_id,
        chain: chainKey,
        symbol,
        amount,
        txHash: log.transactionHash,
        logIndex: Number(log.index ?? 0),
        blockNumber: Number(log.blockNumber),
        depositAddress: user.evm_address
      });
    } catch (e) {
      console.error(
        `[EVM TOKEN ERROR] ${chainKey}/${symbol}: ${errorText(e)}`
      );
    }
  }
}


/* =========================================================
   EVM NATIVE SCANNER
   Direct transfers only.
========================================================= */

async function scanEvmNative(chainKey, symbol, users, latestBlock) {
  if (!users.length) return;

  const map = new Map();
  for (const u of users) {
    if (u.evm_address) map.set(u.evm_address.toLowerCase(), u);
  }

  const fromBlock = Math.max(
    0,
    Number(latestBlock) - EVM_SCAN_BLOCKS + 1
  );

  await withProvider(chainKey, async p => {
    for (let b = fromBlock; b <= Number(latestBlock); b++) {
      try {
        const block = await p.getBlock(b, true);
        if (!block?.transactions) continue;

        for (const tx of block.transactions) {
          if (typeof tx === "string" || !tx?.to) continue;

          const user = map.get(String(tx.to).toLowerCase());
          if (!user) continue;

          const value = tx.value;
          if (!value || value <= 0n) continue;

          await insertDeposit({
            telegramId: user.telegram_id,
            chain: chainKey,
            symbol,
            amount: formatUnits(value, 18),
            txHash: tx.hash,
            logIndex: 0,
            blockNumber: b,
            depositAddress: user.evm_address
          });
        }
      } catch (e) {
        console.error(`[EVM NATIVE] ${chainKey} block ${b}: ${errorText(e)}`);
      }
    }
  });
}

/* =========================================================
   BTC SCANNER
   Blockstream-compatible API.
========================================================= */

async function httpJson(url, options = {}) {
  const r = await fetch(url, {
    ...options,
    headers: {
      "accept": "application/json",
      ...(options.headers || {})
    }
  });

  const text = await r.text();

  if (!r.ok) {
    throw new Error(`HTTP ${r.status}: ${text.slice(0, 300)}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from ${url}`);
  }
}

async function scanBitcoin(users) {
  for (const user of users) {
    if (!user.btc_address) continue;

    try {
      const txs = await httpJson(
        `${BTC_API}/address/${encodeURIComponent(user.btc_address)}/txs`
      );

      if (!Array.isArray(txs)) continue;

      for (const tx of txs) {
        if (!tx?.txid) continue;

        let totalSats = 0;

        for (let i = 0; i < (tx.vout || []).length; i++) {
          const out = tx.vout[i];

          if (
            out?.scriptpubkey_address?.toLowerCase() ===
            user.btc_address.toLowerCase()
          ) {
            totalSats += Number(out.value || 0);

            if (out.value > 0) {
              await insertDeposit({
                telegramId: user.telegram_id,
                chain: "btc",
                symbol: "BTC",
                amount: Number(out.value) / 1e8,
                txHash: tx.txid,
                logIndex: i,
                blockNumber: Number(tx.status?.block_height || 0),
                confirmations: tx.status?.confirmed ? 1 : 0,
                status: tx.status?.confirmed ? "confirmed" : "pending",
                depositAddress: user.btc_address
              });
            }
          }
        }

        void totalSats;
      }
    } catch (e) {
      console.error(`[BTC SCAN] ${user.btc_address}: ${errorText(e)}`);
    }
  }
}

/* =========================================================
   TRON SCANNER
   TRX + USDT TRC20
========================================================= */

function tronHeaders() {
  return TRON_API_KEY
    ? { "TRON-PRO-API-KEY": TRON_API_KEY }
    : {};
}

async function scanTron(users) {
  for (const user of users) {
    if (!user.tron_address) continue;

    try {
      const nativeUrl =
        `${TRON_API}/v1/accounts/${encodeURIComponent(user.tron_address)}/transactions` +
        `?only_confirmed=true&only_to=true&limit=${EXTERNAL_PAGE_LIMIT}`;

      const native = await httpJson(nativeUrl, {
        headers: tronHeaders()
      });

      for (const tx of native?.data || []) {
        const contract = tx?.raw_data?.contract?.[0];
        if (contract?.type !== "TransferContract") continue;

        const value = contract?.parameter?.value;
        if (!value?.to_address || !value?.amount) continue;

        let to;
        try {
          to = TronWeb.address.fromHex(value.to_address);
        } catch {
          continue;
        }

        if (to !== user.tron_address) continue;

        await insertDeposit({
          telegramId: user.telegram_id,
          chain: "tron",
          symbol: "TRX",
          amount: Number(value.amount) / 1e6,
          txHash: tx.txID,
          logIndex: 0,
          blockNumber: Number(tx.blockNumber || 0),
          status: "confirmed",
          confirmations: 1,
          depositAddress: user.tron_address
        });
      }

      const trc20Url =
        `${TRON_API}/v1/accounts/${encodeURIComponent(user.tron_address)}/transactions/trc20` +
        `?only_confirmed=true&only_to=true&limit=${EXTERNAL_PAGE_LIMIT}` +
        `&contract_address=${TRON_USDT_CONTRACT}`;

      const trc20 = await httpJson(trc20Url, {
        headers: tronHeaders()
      });

      for (const item of trc20?.data || []) {
        if (
          String(item.to || "").toLowerCase() !==
          user.tron_address.toLowerCase()
        ) {
          continue;
        }

        if (
          String(item.token_info?.address || "").toLowerCase() !==
          TRON_USDT_CONTRACT.toLowerCase()
        ) {
          continue;
        }

        const decimals = Number(item.token_info?.decimals ?? 6);
        const raw = BigInt(String(item.value || "0"));

        await insertDeposit({
          telegramId: user.telegram_id,
          chain: "tron",
          symbol: "USDT",
          amount: formatUnits(raw, decimals),
          txHash: item.transaction_id,
          logIndex: 0,
          blockNumber: Number(item.block_number || 0),
          status: "confirmed",
          confirmations: 1,
          depositAddress: user.tron_address
        });
      }
    } catch (e) {
      console.error(`[TRON SCAN] ${user.tron_address}: ${errorText(e)}`);
    }
  }
}

/* =========================================================
   SOLANA SCANNER
   Native SOL only. USDC is configured as BSC/BEP20 below.
========================================================= */

async function solRpc(method, params) {
  const data = await httpJson(SOL_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params
    })
  });

  if (data.error) {
    throw new Error(data.error.message || "Solana RPC error");
  }

  return data.result;
}

async function scanSolana(users) {
  for (const user of users) {
    if (!user.sol_address) continue;

    try {
      const sigs = await solRpc("getSignaturesForAddress", [
        user.sol_address,
        { limit: 20, commitment: "finalized" }
      ]);

      for (const s of sigs || []) {
        if (!s?.signature || s.err) continue;

        const tx = await solRpc("getTransaction", [
          s.signature,
          {
            encoding: "jsonParsed",
            commitment: "finalized",
            maxSupportedTransactionVersion: 0
          }
        ]);

        if (!tx?.meta || !tx?.transaction) continue;

        const keys = tx.transaction.message.accountKeys || [];
        let accountIndex = -1;

        for (let i = 0; i < keys.length; i++) {
          const key = typeof keys[i] === "string" ? keys[i] : keys[i]?.pubkey;
          if (key === user.sol_address) {
            accountIndex = i;
            break;
          }
        }

        if (accountIndex < 0) continue;

        const before = Number(tx.meta.preBalances?.[accountIndex] || 0);
        const after = Number(tx.meta.postBalances?.[accountIndex] || 0);
        const delta = after - before;

        if (delta > 0) {
          await insertDeposit({
            telegramId: user.telegram_id,
            chain: "sol",
            symbol: "SOL",
            amount: delta / 1e9,
            txHash: s.signature,
            logIndex: 0,
            blockNumber: Number(s.slot || 0),
            status: "confirmed",
            confirmations: 1,
            depositAddress: user.sol_address
          });
        }
      }
    } catch (e) {
      console.error(`[SOL SCAN] ${user.sol_address}: ${errorText(e)}`);
    }
  }
}

/* =========================================================
   TON SCANNER
   Native TON / GRAM
========================================================= */

async function tonRpc(method, params) {
  const headers = {
    "content-type": "application/json"
  };

  if (TON_API_KEY) {
    headers["X-API-Key"] = TON_API_KEY;
  }

  const data = await httpJson(TON_RPC, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params
    })
  });

  if (data.error) {
    throw new Error(data.error.message || "TON RPC error");
  }

  return data.result;
}

async function scanTon(users) {
  for (const user of users) {
    if (!user.ton_address) continue;

    try {
      const result = await tonRpc("getTransactions", {
        address: user.ton_address,
        limit: 20,
        archival: true
      });

      for (const tx of result?.result || result || []) {
        const txHash =
          tx?.transaction_id?.hash ||
          tx?.transaction_id?.lt ||
          tx?.hash;

        if (!txHash) continue;

        const inMsg = tx?.in_msg;

        const value =
          BigInt(String(inMsg?.value || "0"));

        if (value <= 0n) continue;

        const destination =
          String(inMsg?.destination || "");

        if (
          destination &&
          !destination.includes(user.ton_address)
        ) {
          continue;
        }

        await insertDeposit({
          telegramId: user.telegram_id,
          chain: "ton",
          symbol: "TON",
          amount: Number(value) / 1e9,
          txHash: String(txHash),
          logIndex: 0,
          blockNumber: Number(tx?.block_id?.seqno || 0),
          status: "confirmed",
          confirmations: 1,
          depositAddress: user.ton_address
        });
      }
    } catch (e) {
      console.error(`[TON SCAN] ${user.ton_address}: ${errorText(e)}`);
    }
  }
}

/* =========================================================
   SCAN ALL
========================================================= */

let scannerRunning = false;

async function scanAll() {
  const users = await getUsers();

  if (!users.length) {
    console.log("ℹ️ No wallets yet. Scanner idle.");
    return;
  }

  /* EVM: ETH / BNB + USDT / USDC */
  for (const chainKey of ["eth", "bsc", "polygon"]) {
    try {
      const latest = await withProvider(
        chainKey,
        p => p.getBlockNumber()
      );

      console.log(`🔎 EVM ${chainKey} block ${latest}`);

      if (chainKey === "eth") {
        await scanEvmNative(chainKey, "ETH", users, latest);
      }

      if (chainKey === "bsc") {
        await scanEvmNative(chainKey, "BNB", users, latest);
      }

      for (const [symbol, info] of Object.entries(tokens[chainKey] || {})) {
        await scanEvmToken(
          chainKey,
          symbol,
          info,
          users,
          latest
        );
      }
    } catch (e) {
      console.error(`[EVM CHAIN SCAN] ${chainKey}: ${errorText(e)}`);
    }
  }

  await scanBitcoin(users);
  await scanTron(users);
  await scanSolana(users);
  await scanTon(users);
}

/* =========================================================
   CONFIRMATIONS
========================================================= */

async function updateEvmConfirmations() {
  for (const chainKey of ["eth", "bsc", "polygon"]) {
    try {
      const latest = await withProvider(
        chainKey,
        p => p.getBlockNumber()
      );

      const rows = await pool.query(`
        SELECT id, block_number
        FROM deposits
        WHERE chain=$1
          AND status='pending'
        ORDER BY id ASC
        LIMIT 500
      `, [chainKey]);

      for (const row of rows.rows) {
        const confirmations = Math.max(
          0,
          latest - Number(row.block_number) + 1
        );

        const status =
          confirmations >= CONFIRMATIONS
            ? "confirmed"
            : "pending";

        await pool.query(`
          UPDATE deposits
          SET confirmations=$2, status=$3
          WHERE id=$1
        `, [
          row.id,
          confirmations,
          status
        ]);
      }
    } catch (e) {
      console.error(
        `[CONFIRM] ${chainKey}: ${errorText(e)}`
      );
    }
  }
}

/* =========================================================
   ROOT / HEALTH
========================================================= */

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "iCoinGate Multi-Chain Deposit Wallet API",
    version: "3.0.1",
    features: [
      "wallet generation",
      "EVM deposit scanner",
      "BTC deposit scanner",
      "TRON/TRC20 deposit scanner",
      "TON deposit scanner",
      "USDC-BEP20 deposit scanner"
    ]
  });
});

app.get("/health", async (req, res) => {
  const rpc = {};

  try {
    await pool.query("SELECT 1");
  } catch (e) {
    return res.status(503).json({
      ok: false,
      database: "ERROR",
      error: errorText(e)
    });
  }

  for (const key of ["eth", "bsc", "polygon"]) {
    try {
      rpc[key] = await withProvider(
        key,
        p => p.getBlockNumber()
      );
    } catch (e) {
      rpc[key] = `ERROR: ${errorText(e)}`;
    }
  }

  res.json({
    ok: true,
    database: "OK",
    rpc,
    scanner: scannerRunning ? "running" : "idle"
  });
});

/* =========================================================
   CREATE / GET WALLET
========================================================= */

app.post("/wallet", auth, async (req, res) => {
  try {
    const telegramId = String(req.body.telegramId || "");

    if (!validTelegramId(telegramId)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid Telegram ID"
      });
    }

    const row = await getOrCreateWallet(telegramId);

    res.json({
      ok: true,
      existing: row.existing,
      walletIndex: Number(row.wallet_index),
      addresses: {
        EVM: row.evmAddress,
        BTC: row.btcAddress,
        TRON: row.tronAddress,
        SOL: row.solAddress,
        TON: row.tonAddress
      },
      supportedDeposits: [
        "BTC",
        "ETH",
        "BNB",
        "USDT-ERC20",
        "USDT-BEP20",
        "USDT-TRC20",
        "USDT-POLYGON",
        "USDC-BEP20",
        "TON/GRAM",
        "TRX",
        "SOL"
      ]
    });
  } catch (e) {
    console.error("wallet error:", errorText(e));

    res.status(500).json({
      ok: false,
      error: "Wallet generation failed"
    });
  }
});

app.get("/wallet/:telegramId", auth, async (req, res) => {
  try {
    const telegramId = String(req.params.telegramId || "");

    if (!validTelegramId(telegramId)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid Telegram ID"
      });
    }

    const q = await pool.query(`
      SELECT telegram_id, wallet_index, address,
             evm_address, btc_address, tron_address,
             sol_address, ton_address, created_at
      FROM wallet_users
      WHERE telegram_id=$1
    `, [telegramId]);

    if (!q.rows.length) {
      return res.status(404).json({
        ok: false,
        error: "Wallet not found"
      });
    }

    const row = q.rows[0];

    res.json({
      ok: true,
      telegramId: row.telegram_id,
      walletIndex: Number(row.wallet_index),
      addresses: {
        EVM: row.evm_address,
        BTC: row.btc_address,
        TRON: row.tron_address,
        SOL: row.sol_address,
        TON: row.ton_address
      },
      createdAt: row.created_at
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: errorText(e)
    });
  }
});

/* =========================================================
   ADDRESS -> INDEX
   Only searches addresses belonging to this service.
========================================================= */

app.post("/wallet/index", auth, async (req, res) => {
  try {
    const network = String(req.body.network || "").toLowerCase();
    const address = String(req.body.address || "").trim();

    const columnMap = {
      evm: "evm_address",
      eth: "evm_address",
      bsc: "evm_address",
      polygon: "evm_address",
      btc: "btc_address",
      tron: "tron_address",
      sol: "sol_address",
      solana: "sol_address",
      ton: "ton_address",
      gram: "ton_address"
    };

    const column = columnMap[network];

    if (!column || !address) {
      return res.status(400).json({
        ok: false,
        error: "Invalid network/address"
      });
    }

    const q = await pool.query(`
      SELECT telegram_id, wallet_index, ${column} AS address
      FROM wallet_users
      WHERE LOWER(${column})=LOWER($1)
      LIMIT 1
    `, [address]);

    if (!q.rows.length) {
      return res.status(404).json({
        ok: false,
        error: "Address does not belong to this wallet system"
      });
    }

    res.json({
      ok: true,
      network,
      address: q.rows[0].address,
      walletIndex: Number(q.rows[0].wallet_index),
      telegramId: q.rows[0].telegram_id
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: errorText(e)
    });
  }
});

/* =========================================================
   ADDRESS -> PRIVATE KEY
   SECURITY:
   - API key required
   - address must already exist in wallet_users
   - EXPORT_PRIVATE_KEYS=true must be set
========================================================= */

app.post("/wallet/private-key", auth, async (req, res) => {
  try {
    if (!EXPORT_PRIVATE_KEYS) {
      return res.status(403).json({
        ok: false,
        error: "Private-key export is disabled"
      });
    }

    const network = String(req.body.network || "").toLowerCase();
    const address = String(req.body.address || "").trim();

    const columnMap = {
      evm: "evm_address",
      eth: "evm_address",
      bsc: "evm_address",
      polygon: "evm_address",
      btc: "btc_address",
      tron: "tron_address",
      sol: "sol_address",
      solana: "sol_address",
      ton: "ton_address",
      gram: "ton_address"
    };

    const column = columnMap[network];

    if (!column || !address) {
      return res.status(400).json({
        ok: false,
        error: "Invalid network/address"
      });
    }

    const q = await pool.query(`
      SELECT telegram_id, wallet_index, ${column} AS address
      FROM wallet_users
      WHERE LOWER(${column})=LOWER($1)
      LIMIT 1
    `, [address]);

    if (!q.rows.length) {
      return res.status(404).json({
        ok: false,
        error: "Address does not belong to this wallet system"
      });
    }

    const row = q.rows[0];

    const result = await privateKeyForNetwork(
      Number(row.wallet_index),
      network
    );

    res.json({
      ok: true,
      warning: "PRIVATE KEY — NEVER SEND THIS TO USERS OR LOG IT",
      telegramId: row.telegram_id,
      walletIndex: Number(row.wallet_index),
      address: row.address,
      ...result
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: errorText(e)
    });
  }
});


/* =========================================================
   DEPOSITS
========================================================= */

app.get("/deposits", auth, async (req, res) => {
  try {
    const allowed = ["pending", "confirmed"];
    const status = String(
      req.query.status || "confirmed"
    ).toLowerCase();

    if (!allowed.includes(status)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid status"
      });
    }

    const rawLimit = Number(req.query.limit || 50);
    const limit = Math.min(
      100,
      Math.max(
        1,
        Number.isFinite(rawLimit)
          ? Math.floor(rawLimit)
          : 50
      )
    );

    const q = await pool.query(`
      SELECT id, telegram_id, chain, symbol,
             amount, tx_hash, block_number,
             confirmations, status,
             deposit_address, created_at
      FROM deposits
      WHERE status=$1
      ORDER BY id DESC
      LIMIT $2
    `, [status, limit]);

    res.json({
      ok: true,
      deposits: q.rows
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: errorText(e)
    });
  }
});

/* =========================================================
   MANUAL SCAN TRIGGER
========================================================= */

app.post("/scanner/run", auth, async (req, res) => {
  if (scannerRunning) {
    return res.status(409).json({
      ok: false,
      error: "Scanner already running"
    });
  }

  runScanner().catch(e =>
    console.error("manual scanner error:", errorText(e))
  );

  res.json({
    ok: true,
    message: "Scanner started"
  });
});

/* =========================================================
   START SCANNER
========================================================= */

async function runScanner() {
  if (scannerRunning) {
    console.log("⏳ Previous scanner still running; skipped.");
    return;
  }

  scannerRunning = true;

  try {
    console.log("🔄 Scanner started...");
    await scanAll();
    await updateEvmConfirmations();
    console.log("✅ Scanner finished.");
  } catch (e) {
    console.error("❌ Scanner error:", errorText(e));
  } finally {
    scannerRunning = false;
  }
}

/* =========================================================
   SERVER
========================================================= */

async function startServer() {
  try {
    await initDb();

    app.listen(PORT, "0.0.0.0", () => {
      console.log("======================================");
      console.log(`🚀 iCoinGate Wallet API running on ${PORT}`);
      console.log("💰 Deposit scanner: ENABLED");
      console.log("💵 USDC-BEP20 scanner: ENABLED");
      console.log("======================================");
    });

    setTimeout(() => {
      runScanner().catch(e =>
        console.error("initial scanner:", errorText(e))
      );
    }, 5000);

    setInterval(() => {
      runScanner().catch(e =>
        console.error("interval scanner:", errorText(e))
      );
    }, SCAN_INTERVAL_MS);
  } catch (e) {
    console.error("❌ FATAL STARTUP ERROR:", errorText(e));
    process.exit(1);
  }
}

process.on("unhandledRejection", e =>
  console.error("⚠️ Unhandled rejection:", errorText(e))
);

process.on("uncaughtException", e =>
  console.error("⚠️ Uncaught exception:", errorText(e))
);

startServer();
import express from "express";
import {
  HDNodeWallet,
  Mnemonic,
  JsonRpcProvider,
  Contract,
  parseUnits,
  formatUnits,
  isAddress,
  id
} from "ethers";
import pg from "pg";

const { Pool } = pg;

const app = express();

app.use(express.json({ limit: "64kb" }));

/* =========================================================
   CONFIG
========================================================= */

const PORT = Number(process.env.PORT || 3000);

const API_KEY =
  String(process.env.BOT_API_KEY || "").trim();

const MASTER_MNEMONIC =
  String(process.env.MASTER_MNEMONIC || "").trim();

const DATABASE_URL =
  String(process.env.DATABASE_URL || "").trim();

const CENTRAL_WALLET_INDEX =
  Number(process.env.CENTRAL_WALLET_INDEX || 999999);

const CONFIRMATIONS =
  Math.max(
    1,
    Number(process.env.CONFIRMATIONS || 3)
  );

const SCAN_INTERVAL_MS =
  Math.max(
    15000,
    Number(process.env.SCAN_INTERVAL_MS || 30000)
  );

/*
 * কত block পিছনে scan করবে।
 * ছোট রাখা হয়েছে যাতে public RPC-তে limit না আসে।
 */
const SCAN_BLOCKS =
  Math.max(
    1,
    Number(process.env.SCAN_BLOCKS || 30)
  );

/*
 * প্রথমে এই chunk দিয়ে চেষ্টা করবে।
 * limit error হলে নিজে নিজে অর্ধেক করবে।
 */
const LOG_CHUNK =
  Math.max(
    1,
    Number(process.env.LOG_CHUNK || 10)
  );

const MIN_LOG_CHUNK = 1;

const SWEEP_MIN_USDT =
  String(
    process.env.SWEEP_MIN_USDT || "0.000001"
  );

const SWEEP_GAS_MULTIPLIER =
  Math.max(
    1,
    Number(
      process.env.SWEEP_GAS_MULTIPLIER || 1.5
    )
  );

/* =========================================================
   ENV CHECK
========================================================= */

if (
  !API_KEY ||
  !MASTER_MNEMONIC ||
  !DATABASE_URL
) {
  console.error(
    "❌ Missing BOT_API_KEY, MASTER_MNEMONIC or DATABASE_URL"
  );

  process.exit(1);
}

/* =========================================================
   DATABASE
========================================================= */

const pool = new Pool({
  connectionString: DATABASE_URL,

  ssl:
    DATABASE_URL.includes("localhost") ||
    DATABASE_URL.includes("127.0.0.1")
      ? false
      : {
          rejectUnauthorized: false
        },

  max: 5,

  idleTimeoutMillis: 30000,

  connectionTimeoutMillis: 10000
});

pool.on(
  "error",
  err => {
    console.error(
      "❌ PostgreSQL pool error:",
      err.message
    );
  }
);

/* =========================================================
   CHAINS
========================================================= */

const chains = {

  bsc: {

    name: "BSC",

    chainId: 56,

    native: "BNB",

    explorer:
      "https://bscscan.com/tx/",

    /*
     * IMPORTANT:
     * bsc-dataseed public RPC-কে logs-এর জন্য
     * primary করা হয়নি।
     *
     * চাইলে Render Environment Variables-এ
     * BSC_RPC_URLS দিয়ে নিজের provider দিতে পারবি।
     */

    rpcs: (
      process.env.BSC_RPC_URLS ||
      process.env.BSC_RPC_URL ||
      [
        "https://bsc-rpc.publicnode.com",
        "https://bnb.rpc.subquery.network/public"
      ].join(",")
    )
      .split(",")
      .map(
        x => x.trim()
      )
      .filter(Boolean),

    centralAddress:
      String(
        process.env.CENTRAL_BSC_ADDRESS || ""
      ).trim()

  },

  eth: {

    name: "Ethereum",

    chainId: 1,

    native: "ETH",

    explorer:
      "https://etherscan.io/tx/",

    rpcs: (
      process.env.ETH_RPC_URLS ||
      process.env.ETH_RPC_URL ||
      [
        "https://ethereum-rpc.publicnode.com",
        "https://cloudflare-eth.com"
      ].join(",")
    )
      .split(",")
      .map(
        x => x.trim()
      )
      .filter(Boolean),

    centralAddress:
      String(
        process.env.CENTRAL_ETH_ADDRESS || ""
      ).trim()

  }

};

/* =========================================================
   TOKEN CONFIG
========================================================= */

const tokens = {

  bsc: {

    USDT: {
      /*
       * lowercase রাখা হয়েছে যাতে checksum error না হয়
       */
      address:
        "0x55d398326f99059f775485246999027b3197955",

      decimals: 18
    },

    USDC: {
      address:
        "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",

      decimals: 18
    },

    BUSD: {
      address:
        "0xe9e7cea3dedca5984780bafc599bd69add087d56",

      decimals: 18
    }

  },

  eth: {

    USDT: {
      address:
        "0xdac17f958d2ee523a2206206994597c13d831ec7",

      decimals: 6
    },

    USDC: {
      /*
       * FIXED:
       * আগের mixed-case checksum ভুল ছিল।
       * পুরো address lowercase।
       */
      address:
        "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",

      decimals: 6
    },

    BUSD: {
      address:
        "0x4fabb145d64652a948d72533023f6e7a623c7c53",

      decimals: 18
    }

  }

};

/* =========================================================
   ERC20 ABI
========================================================= */

const ERC20_ABI = [

  "event Transfer(address indexed from,address indexed to,uint256 value)",

  "function balanceOf(address) view returns (uint256)",

  "function transfer(address to,uint256 amount) returns (bool)"

];

/* =========================================================
   TRANSFER TOPIC
========================================================= */

const TRANSFER_TOPIC =
  id(
    "Transfer(address,address,uint256)"
  );

/* =========================================================
   HD WALLET
========================================================= */

const mnemonic =
  Mnemonic.fromPhrase(
    MASTER_MNEMONIC
  );

const master =
  HDNodeWallet.fromMnemonic(
    mnemonic,
    "m/44'/60'/0'/0"
  );

/*
 * IMPORTANT:
 * deriveChild ব্যবহার করছি।
 * এতে wallet index derive করার ক্ষেত্রে
 * path-related সমস্যা হবে না।
 */

function derive(index) {

  const n =
    Number(index);

  if (
    !Number.isInteger(n) ||
    n < 0
  ) {

    throw new Error(
      `Invalid wallet index: ${index}`
    );

  }

  return master.deriveChild(n);

}

/* =========================================================
   AUTH
========================================================= */

function auth(
  req,
  res,
  next
) {

  const key =
    req.get(
      "x-api-key"
    );

  if (
    !key ||
    key !== API_KEY
  ) {

    return res.status(401).json({

      ok: false,

      error:
        "Unauthorized"

    });

  }

  next();

}

/* =========================================================
   VALIDATORS
========================================================= */

function validTelegramId(v) {

  return /^\d+$/.test(
    String(v || "")
  );

}

function validPositiveNumber(v) {

  const n =
    Number(v);

  return (
    Number.isFinite(n) &&
    n > 0
  );

}

/* =========================================================
   RPC
========================================================= */

function rpcList(
  chainKey
) {

  const chain =
    chains[chainKey];

  if (!chain) {

    throw new Error(
      `Unsupported chain: ${chainKey}`
    );

  }

  return chain.rpcs;

}

function createProvider(
  chainKey,
  rpc
) {

  const chain =
    chains[chainKey];

  return new JsonRpcProvider(

    rpc,

    {
      name:
        chain.name.toLowerCase(),

      chainId:
        chain.chainId
    },

    {
      staticNetwork:
        true
    }

  );

}

/* =========================================================
   PROVIDER TEST
========================================================= */

async function testProvider(
  chainKey,
  rpc
) {

  const p =
    createProvider(
      chainKey,
      rpc
    );

  const network =
    await p.getNetwork();

  if (
    Number(
      network.chainId
    ) !==
    chains[chainKey].chainId
  ) {

    throw new Error(
      `Wrong network from RPC. Expected ${chains[chainKey].chainId}, got ${network.chainId}`
    );

  }

  await p.getBlockNumber();

  return p;

}

/* =========================================================
   GET WORKING PROVIDER
========================================================= */

async function getProvider(
  chainKey
) {

  let lastError =
    null;

  for (
    const rpc
    of rpcList(chainKey)
  ) {

    try {

      return await testProvider(
        chainKey,
        rpc
      );

    } catch (e) {

      lastError =
        e;

      console.error(
        `[RPC FAILED] ${chainKey} ${rpc}: ${e.message}`
      );

    }

  }

  throw new Error(
    `No working RPC for ${chainKey}: ${
      lastError?.message ||
      "unknown RPC error"
    }`
  );

}

/* =========================================================
   PROVIDER FAILOVER
========================================================= */

async function withProvider(
  chainKey,
  fn
) {

  let lastError =
    null;

  for (
    const rpc
    of rpcList(chainKey)
  ) {

    try {

      const p =
        await testProvider(
          chainKey,
          rpc
        );

      return await fn(p);

    } catch (e) {

      lastError =
        e;

      console.error(
        `[RPC RETRY] ${chainKey} ${rpc}: ${e.message}`
      );

    }

  }

  throw (
    lastError ||
    new Error(
      `RPC failed for ${chainKey}`
    )
  );

}

/* =========================================================
   SAFE ERROR TEXT
========================================================= */

function errorText(e) {

  if (!e) {
    return "Unknown error";
  }

  return String(
    e.shortMessage ||
    e.reason ||
    e.message ||
    e
  );

}

/* =========================================================
   DATABASE INIT
========================================================= */

async function initDb() {

  await pool.query(`

    CREATE SEQUENCE IF NOT EXISTS
    wallet_index_seq
    START 0
    MINVALUE 0;

    CREATE TABLE IF NOT EXISTS wallet_users (

      id BIGSERIAL PRIMARY KEY,

      telegram_id
      TEXT UNIQUE NOT NULL,

      wallet_index
      BIGINT UNIQUE NOT NULL,

      address
      TEXT UNIQUE NOT NULL,

      created_at
      TIMESTAMPTZ
      NOT NULL
      DEFAULT NOW()

    );

    CREATE TABLE IF NOT EXISTS deposits (

      id BIGSERIAL PRIMARY KEY,

      telegram_id
      TEXT NOT NULL,

      chain
      TEXT NOT NULL,

      symbol
      TEXT NOT NULL,

      amount
      NUMERIC(78,30)
      NOT NULL,

      tx_hash
      TEXT NOT NULL,

      log_index
      INTEGER
      NOT NULL
      DEFAULT 0,

      block_number
      BIGINT
      NOT NULL,

      confirmations
      INTEGER
      NOT NULL
      DEFAULT 0,

      status
      TEXT
      NOT NULL
      DEFAULT 'pending',

      created_at
      TIMESTAMPTZ
      NOT NULL
      DEFAULT NOW(),

      UNIQUE(
        chain,
        tx_hash,
        log_index
      )

    );

    CREATE INDEX IF NOT EXISTS
    deposits_status_idx
    ON deposits(status,id);

    CREATE INDEX IF NOT EXISTS
    deposits_address_lookup_idx
    ON wallet_users(address);

  `);

  console.log(
    "✅ Database initialized"
  );

}

/* =========================================================
   WALLET CREATE / GET
========================================================= */

async function getOrCreateWallet(
  telegramId
) {

  const old =
    await pool.query(
      `
      SELECT
        telegram_id,
        wallet_index,
        address,
        created_at

      FROM wallet_users

      WHERE telegram_id=$1
      `,
      [
        telegramId
      ]
    );

  if (
    old.rows.length
  ) {

    return {

      ...old.rows[0],

      existing:
        true

    };

  }

  const client =
    await pool.connect();

  try {

    await client.query(
      "BEGIN"
    );

    let index;

    /*
     * Sequence থেকে index নেব।
     * CENTRAL index skip করব।
     */

    while (true) {

      const seq =
        await client.query(
          `
          SELECT
            nextval(
              'wallet_index_seq'
            ) AS n
          `
        );

      index =
        Number(
          seq.rows[0].n
        );

      if (
        index !==
        CENTRAL_WALLET_INDEX
      ) {

        break;

      }

    }

    const wallet =
      derive(index);

    const inserted =
      await client.query(
        `
        INSERT INTO wallet_users
        (
          telegram_id,
          wallet_index,
          address
        )

        VALUES
        ($1,$2,$3)

        RETURNING
          telegram_id,
          wallet_index,
          address,
          created_at
        `,
        [
          telegramId,
          index,
          wallet.address
        ]
      );

    await client.query(
      "COMMIT"
    );

    return {

      ...inserted.rows[0],

      existing:
        false

    };

  } catch (e) {

    await client.query(
      "ROLLBACK"
    );

    /*
     * Race condition হলে existing wallet ফেরত নেবে।
     */

    if (
      e.code === "23505"
    ) {

      const retry =
        await pool.query(
          `
          SELECT
            telegram_id,
            wallet_index,
            address,
            created_at

          FROM wallet_users

          WHERE telegram_id=$1
          `,
          [
            telegramId
          ]
        );

      if (
        retry.rows.length
      ) {

        return {

          ...retry.rows[0],

          existing:
            true

        };

      }

    }

    throw e;

  } finally {

    client.release();

  }

}

/* =========================================================
   GET ALL USERS
========================================================= */

async function getUsers() {

  const q =
    await pool.query(
      `
      SELECT
        telegram_id,
        wallet_index,
        address

      FROM wallet_users

      ORDER BY wallet_index ASC
      `
    );

  return q.rows;

}

/* =========================================================
   USER ADDRESS MAP
========================================================= */

function buildUserMap(
  users
) {

  const map =
    new Map();

  for (
    const user
    of users
  ) {

    map.set(
      user.address.toLowerCase(),
      user
    );

  }

  return map;

}

/* =========================================================
   SAFE GET LOGS
========================================================= */

async function getLogsAdaptive(
  provider,
  filter,
  fromBlock,
  toBlock,
  chunkSize = LOG_CHUNK
) {

  let start =
    Number(fromBlock);

  const end =
    Number(toBlock);

  const logs =
    [];

  let chunk =
    Math.max(
      MIN_LOG_CHUNK,
      Number(chunkSize)
    );

  while (
    start <= end
  ) {

    const currentEnd =
      Math.min(
        end,
        start + chunk - 1
      );

    try {

      const result =
        await provider.getLogs({

          address:
            filter.address,

          topics:
            filter.topics,

          fromBlock:
            start,

          toBlock:
            currentEnd

        });

      if (
        Array.isArray(result)
      ) {

        logs.push(
          ...result
        );

      }

      start =
        currentEnd + 1;

      /*
       * সফল হলে ধীরে ধীরে chunk বাড়াতে পারি।
       * কিন্তু public RPC-তে বেশি বাড়াব না।
       */

      if (
        chunk < LOG_CHUNK
      ) {

        chunk =
          Math.min(
            LOG_CHUNK,
            chunk * 2
          );

      }

    } catch (e) {

      const msg =
        errorText(e)
          .toLowerCase();

      const looksLikeLimit =
        msg.includes(
          "limit exceeded"
        ) ||
        msg.includes(
          "too many"
        ) ||
        msg.includes(
          "timeout"
        ) ||
        msg.includes(
          "request entity"
        ) ||
        msg.includes(
          "cannot slice"
        ) ||
        msg.includes(
          "buffer overrun"
        ) ||
        msg.includes(
          "archive"
        ) ||
        msg.includes(
          "403"
        );

      /*
       * Chunk 1 block পর্যন্ত নামিয়ে ফেলেছি,
       * তারপরও error হলে caller অন্য RPC-তে যাবে।
       */

      if (
        looksLikeLimit &&
        chunk > MIN_LOG_CHUNK
      ) {

        chunk =
          Math.max(
            MIN_LOG_CHUNK,
            Math.floor(
              chunk / 2
            )
          );

        console.warn(
          `[LOGS] reducing chunk to ${chunk} because: ${errorText(e)}`
        );

        continue;

      }

      throw e;

    }

  }

  return logs;

}

/* =========================================================
   INSERT TOKEN DEPOSIT
========================================================= */

async function insertTokenDeposit(
  chainKey,
  symbol,
  info,
  log,
  user
) {

  const value =
    log.args?.[2] ??
    BigInt(
      "0x" +
      log.data.slice(2)
    );

  if (
    value <= 0n
  ) {

    return false;

  }

  const txHash =
    log.transactionHash;

  const logIndex =
    Number(
      log.index ?? 0
    );

  const blockNumber =
    Number(
      log.blockNumber
    );

  const amount =
    formatUnits(
      value,
      info.decimals
    );

  const q =
    await pool.query(
      `
      INSERT INTO deposits
      (
        telegram_id,
        chain,
        symbol,
        amount,
        tx_hash,
        log_index,
        block_number,
        status
      )

      VALUES
      (
        $1,$2,$3,$4,$5,$6,$7,'pending'
      )

      ON CONFLICT
      (
        chain,
        tx_hash,
        log_index
      )

      DO NOTHING

      RETURNING id
      `,
      [
        user.telegram_id,
        chainKey,
        symbol,
        amount,
        txHash,
        logIndex,
        blockNumber
      ]
    );

  return (
    q.rows.length > 0
  );

}

/* =========================================================
   SCAN ONE TOKEN
========================================================= */

async function scanToken(
  chainKey,
  symbol,
  info,
  users,
  latestBlock
) {

  if (
    !users.length
  ) {

    return {
      logs: 0,
      deposits: 0
    };

  }

  const userMap =
    buildUserMap(
      users
    );

  /*
   * শুধুমাত্র Transfer event-এর
   * প্রথম topic filter করা হচ্ছে।
   *
   * ফলে প্রত্যেক user-এর জন্য আলাদা
   * getLogs call লাগবে না।
   */

  const filter = {

    address:
      info.address,

    topics: [
      TRANSFER_TOPIC,
      null,
      null
    ]

  };

  const start =
    Math.max(
      0,
      Number(latestBlock) -
      SCAN_BLOCKS +
      1
    );

  const logs =
    await getLogsAdaptive(
      await getProvider(
        chainKey
      ),
      filter,
      start,
      Number(latestBlock)
    );

  let deposits =
    0;

  for (
    const log
    of logs
  ) {

    try {

      /*
       * Transfer event:
       *
       * topics[0] = event
       * topics[1] = from
       * topics[2] = to
       */

      if (
        !log.topics ||
        log.topics.length < 3
      ) {

        continue;

      }

      const to =
        "0x" +
        log.topics[2]
          .slice(-40);

      const user =
        userMap.get(
          to.toLowerCase()
        );

      if (
        !user
      ) {

        continue;

      }

      const inserted =
        await insertTokenDeposit(
          chainKey,
          symbol,
          info,
          log,
          user
        );

      if (
        inserted
      ) {

        deposits++;

        console.log(
          `💰 Deposit: ${chainKey} ${symbol} ${formatUnits(log.args?.[2] ?? 0n, info.decimals)} -> ${user.telegram_id}`
        );

      }

    } catch (e) {

      console.error(
        `[DEPOSIT LOG ERROR] ${chainKey} ${symbol}: ${errorText(e)}`
      );

    }

  }

  return {

    logs:
      logs.length,

    deposits

  };

}

/* =========================================================
   SCAN TOKENS
========================================================= */

async function scanTokensForChain(
  chainKey,
  users,
  latestBlock
) {

  const result = {};

  for (
    const [
      symbol,
      info
    ]
    of Object.entries(
      tokens[chainKey]
    )
  ) {

    try {

      result[symbol] =
        await scanToken(
          chainKey,
          symbol,
          info,
          users,
          latestBlock
        );

    } catch (e) {

      /*
       * একটি token error হলে
       * অন্য token বন্ধ হবে না।
       */

      console.error(
        `[TOKEN SCAN ERROR] ${chainKey} ${symbol}: ${errorText(e)}`
      );

      result[symbol] = {

        logs: 0,

        deposits: 0,

        error:
          errorText(e)

      };

    }

  }

  return result;

}

/* =========================================================
   SCAN ALL TOKEN DEPOSITS
========================================================= */

async function scanAll() {

  const users =
    await getUsers();

  if (
    !users.length
  ) {

    return;

  }

  for (
    const chainKey
    of Object.keys(chains)
  ) {

    try {

      const latest =
        await withProvider(
          chainKey,
          p =>
            p.getBlockNumber()
        );

      console.log(
        `🔎 Scanning ${chainKey} at block ${latest}`
      );

      await scanTokensForChain(
        chainKey,
        users,
        latest
      );

    } catch (e) {

      console.error(
        `[CHAIN SCAN ERROR] ${chainKey}: ${errorText(e)}`
      );

    }

  }

}

/* =========================================================
   CONFIRMATIONS
========================================================= */

async function updateConfirmations() {

  for (
    const chainKey
    of Object.keys(chains)
  ) {

    try {

      const latest =
        await withProvider(
          chainKey,
          p =>
            p.getBlockNumber()
        );

      const rows =
        await pool.query(
          `
          SELECT
            id,
            block_number

          FROM deposits

          WHERE
            chain=$1
            AND status='pending'

          ORDER BY id ASC

          LIMIT 500
          `,
          [
            chainKey
          ]
        );

      for (
        const row
        of rows.rows
      ) {

        const confirmations =
          Math.max(
            0,
            latest -
            Number(
              row.block_number
            ) +
            1
          );

        const status =
          confirmations >=
          CONFIRMATIONS
            ? "confirmed"
            : "pending";

        await pool.query(
          `
          UPDATE deposits

          SET
            confirmations=$2,
            status=$3

          WHERE id=$1
          `,
          [
            row.id,
            confirmations,
            status
          ]
        );

      }

    } catch (e) {

      console.error(
        `[CONFIRM ERROR] ${chainKey}: ${errorText(e)}`
      );

    }

  }

}

/* =========================================================
   TOKEN BALANCE
========================================================= */

async function getTokenBalance(
  chainKey,
  info,
  address
) {

  if (
    !isAddress(address)
  ) {

    throw new Error(
      "Invalid wallet address"
    );

  }

  return withProvider(
    chainKey,
    async p => {

      const token =
        new Contract(
          info.address,
          ERC20_ABI,
          p
        );

      return await token.balanceOf(
        address
      );

    }
  );

}

/* =========================================================
   CENTRAL WALLET
========================================================= */

async function centralWallet(
  chainKey
) {

  const p =
    await getProvider(
      chainKey
    );

  const wallet =
    derive(
      CENTRAL_WALLET_INDEX
    ).connect(p);

  const configured =
    chains[
      chainKey
    ].centralAddress;

  if (
    !configured
  ) {

    throw new Error(
      `CENTRAL_${chainKey.toUpperCase()}_ADDRESS is missing`
    );

  }

  if (
    !isAddress(
      configured
    )
  ) {

    throw new Error(
      `Invalid CENTRAL_${chainKey.toUpperCase()}_ADDRESS`
    );

  }

  if (
    configured.toLowerCase() !==
    wallet.address.toLowerCase()
  ) {

    throw new Error(
      `CENTRAL_${chainKey.toUpperCase()}_ADDRESS does not match CENTRAL_WALLET_INDEX`
    );

  }

  return {

    p,

    wallet

  };

}

/* =========================================================
   ENSURE GAS FOR TOKEN SWEEP
========================================================= */

async function ensureGas(
  chainKey,
  userWallet,
  tokenContract
) {

  const chain =
    chains[chainKey];

  const [
    feeData,
    nativeBalance
  ] =
    await Promise.all([

      userWallet.provider.getFeeData(),

      userWallet.provider.getBalance(
        userWallet.address
      )

    ]);

  let gasPrice =
    feeData.gasPrice;

  if (
    !gasPrice
  ) {

    gasPrice =
      feeData.maxFeePerGas;

  }

  if (
    !gasPrice
  ) {

    throw new Error(
      `Cannot determine ${chain.native} gas price`
    );

  }

  let gasLimit =
    70000n;

  try {

    gasLimit =
      await tokenContract.transfer.estimateGas(
        chain.centralAddress,
        1n
      );

  } catch (e) {

    console.warn(
      `[GAS ESTIMATE] ${chainKey}: ${errorText(e)}`
    );

  }

  const multiplier =
    BigInt(
      Math.max(
        1,
        Math.ceil(
          SWEEP_GAS_MULTIPLIER
        )
      )
    );

  const required =
    gasLimit *
    gasPrice *
    multiplier;

  if (
    nativeBalance >=
    required
  ) {

    return {

      funded:
        false,

      amount:
        0n

    };

  }

  const missing =
    required -
    nativeBalance;

  const central =
    await centralWallet(
      chainKey
    );

  const centralBalance =
    await central.provider.getBalance(
      central.wallet.address
    );

  /*
   * কিছু reserve রাখছি।
   */

  if (
    centralBalance <=
    missing
  ) {

    throw new Error(
      `Central ${chain.native} balance is insufficient for gas`
    );

  }

  const fundTx =
    await central.wallet.sendTransaction({

      to:
        userWallet.address,

      value:
        missing

    });

  console.log(
    `⛽ Gas funding ${chainKey}: ${fundTx.hash}`
  );

  await fundTx.wait(
    1
  );

  return {

    funded:
      true,

    amount:
      missing,

    txHash:
      fundTx.hash

  };

}

/* =========================================================
   SWEEP USDT
========================================================= */

async function sweepUSDT(
  chainKey
) {

  const info =
    tokens[
      chainKey
    ]?.USDT;

  if (
    !info
  ) {

    throw new Error(
      "USDT is not configured"
    );

  }

  const destination =
    chains[
      chainKey
    ].centralAddress;

  if (
    !destination ||
    !isAddress(
      destination
    )
  ) {

    throw new Error(
      `Set CENTRAL_${chainKey.toUpperCase()}_ADDRESS correctly`
    );

  }

  /*
   * Central wallet check
   */

  const central =
    await centralWallet(
      chainKey
    );

  if (
    central.wallet.address.toLowerCase() !==
    destination.toLowerCase()
  ) {

    throw new Error(
      "Central address does not match derived central wallet"
    );

  }

  const users =
    await pool.query(
      `
      SELECT
        telegram_id,
        wallet_index,
        address

      FROM wallet_users

      WHERE
        wallet_index <> $1

      ORDER BY
        wallet_index ASC
      `,
      [
        CENTRAL_WALLET_INDEX
      ]
    );

  const results =
    [];

  let total =
    0n;

  const min =
    parseUnits(
      SWEEP_MIN_USDT,
      info.decimals
    );

  for (
    const user
    of users.rows
  ) {

    try {

      /*
       * প্রতিটি user-এর জন্য provider
       * failover হবে।
       */

      const p =
        await getProvider(
          chainKey
        );

      const userWallet =
        derive(
          Number(
            user.wallet_index
          )
        ).connect(p);

      const balance =
        await getTokenBalance(
          chainKey,
          info,
          userWallet.address
        );

      if (
        balance < min
      ) {

        results.push({

          telegramId:
            user.telegram_id,

          address:
            user.address,

          balance:
            formatUnits(
              balance,
              info.decimals
            ),

          action:
            "skipped"

        });

        continue;

      }

      const token =
        new Contract(
          info.address,
          ERC20_ABI,
          userWallet
        );

      /*
       * Token আছে কিন্তু gas নেই?
       * Central wallet থেকে gas দেবে।
       */

      const gas =
        await ensureGas(
          chainKey,
          userWallet,
          token
        );

      /*
       * আবার balance check:
       * gas funding-এর পরে token balance বদলাবে না,
       * তাই পুরো token balance sweep করা যাবে।
       */

      const finalBalance =
        await token.balanceOf(
          userWallet.address
        );

      if (
        finalBalance < min
      ) {

        results.push({

          telegramId:
            user.telegram_id,

          address:
            user.address,

          balance:
            formatUnits(
              finalBalance,
              info.decimals
            ),

          action:
            "skipped"

        });

        continue;

      }

      const tx =
        await token.transfer(
          destination,
          finalBalance
        );

      console.log(
        `🚚 Sweep ${chainKey} ${user.address}: ${tx.hash}`
      );

      const receipt =
        await tx.wait(
          1
        );

      if (
        !receipt ||
        receipt.status !== 1
      ) {

        throw new Error(
          "Sweep transaction failed"
        );

      }

      total +=
        finalBalance;

      results.push({

        telegramId:
          user.telegram_id,

        address:
          user.address,

        balance:
          formatUnits(
            finalBalance,
            info.decimals
          ),

        gasFunded:
          gas.funded,

        gasTxHash:
          gas.txHash ||
          null,

        txHash:
          tx.hash,

        explorer:
          chains[
            chainKey
          ].explorer +
          tx.hash,

        action:
          "swept"

      });

    } catch (e) {

      console.error(
        `[SWEEP ERROR] ${chainKey} ${user.address}: ${errorText(e)}`
      );

      results.push({

        telegramId:
          user.telegram_id,

        address:
          user.address,

        action:
          "failed",

        error:
          errorText(e)

      });

    }

  }

  return {

    chain:
      chainKey,

    symbol:
      "USDT",

    destination:
      destination,

    totalSwept:
      formatUnits(
        total,
        info.decimals
      ),

    results

  };

}

/* =========================================================
   ROOT
========================================================= */

app.get(
  "/",
  (req, res) => {

    res.json({

      ok:
        true,

      service:
        "iCoinGate EVM Wallet API",

      version:
        "2.0.0"

    });

  }
);

/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/health",
  async (req, res) => {

    const rpc = {};

    try {

      await pool.query(
        "SELECT 1"
      );

    } catch (e) {

      return res.status(503).json({

        ok:
          false,

        database:
          "ERROR",

        error:
          errorText(e)

      });

    }

    for (
      const key
      of Object.keys(chains)
    ) {

      try {

        rpc[key] =
          await withProvider(
            key,
            p =>
              p.getBlockNumber()
          );

      } catch (e) {

        rpc[key] =
          `ERROR: ${errorText(e)}`;

      }

    }

    res.json({

      ok:
        true,

      database:
        "OK",

      rpc

    });

  }
);

/* =========================================================
   CREATE / GET WALLET
========================================================= */

app.post(
  "/wallet",
  auth,
  async (req, res) => {

    try {

      const telegramId =
        String(
          req.body.telegramId ||
          ""
        );

      if (
        !validTelegramId(
          telegramId
        )
      ) {

        return res.status(400).json({

          ok:
            false,

          error:
            "Invalid Telegram ID"

        });

      }

      const row =
        await getOrCreateWallet(
          telegramId
        );

      res.json({

        ok:
          true,

        existing:
          row.existing,

        network:
          "EVM",

        address:
          row.address,

        walletIndex:
          Number(
            row.wallet_index
          ),

        networks: [

          "Ethereum ERC20",

          "BNB BEP20"

        ]

      });

    } catch (e) {

      console.error(
        "wallet error:",
        errorText(e)
      );

      res.status(500).json({

        ok:
          false,

        error:
          "Wallet generation failed"

      });

    }

  }
);

/* =========================================================
   GET WALLET
========================================================= */

app.get(
  "/wallet/:telegramId",
  auth,
  async (req, res) => {

    try {

      const telegramId =
        String(
          req.params.telegramId ||
          ""
        );

      if (
        !validTelegramId(
          telegramId
        )
      ) {

        return res.status(400).json({

          ok:
            false,

          error:
            "Invalid Telegram ID"

        });

      }

      const q =
        await pool.query(
          `
          SELECT
            telegram_id,
            wallet_index,
            address,
            created_at

          FROM wallet_users

          WHERE telegram_id=$1
          `,
          [
            telegramId
          ]
        );

      if (
        !q.rows.length
      ) {

        return res.status(404).json({

          ok:
            false,

          error:
            "Wallet not found"

        });

      }

      const row =
        q.rows[0];

      res.json({

        ok:
          true,

        network:
          "EVM",

        telegramId:
          row.telegram_id,

        walletIndex:
          Number(
            row.wallet_index
          ),

        address:
          row.address,

        createdAt:
          row.created_at

      });

    } catch (e) {

      res.status(500).json({

        ok:
          false,

        error:
          "Database error"

      });

    }

  }
);

/* =========================================================
   DEPOSITS
========================================================= */

app.get(
  "/deposits",
  auth,
  async (req, res) => {

    try {

      const allowedStatus = [

        "pending",

        "confirmed"

      ];

      const status =
        String(
          req.query.status ||
          "confirmed"
        ).toLowerCase();

      if (
        !allowedStatus.includes(
          status
        )
      ) {

        return res.status(400).json({

          ok:
            false,

          error:
            "Invalid status"

        });

      }

      const rawLimit =
        Number(
          req.query.limit ||
          50
        );

      const limit =
        Math.min(
          100,
          Math.max(
            1,
            Number.isFinite(
              rawLimit
            )
              ? Math.floor(
                  rawLimit
                )
              : 50
          )
        );

      const q =
        await pool.query(
          `
          SELECT
            id,
            telegram_id,
            chain,
            symbol,
            amount,
            tx_hash,
            block_number,
            confirmations,
            status,
            created_at

          FROM deposits

          WHERE status=$1

          ORDER BY id DESC

          LIMIT $2
          `,
          [
            status,
            limit
          ]
        );

      res.json({

        ok:
          true,

        deposits:
          q.rows

      });

    } catch (e) {

      res.status(500).json({

        ok:
          false,

        error:
          errorText(e)

      });

    }

  }
);

/* =========================================================
   WITHDRAW
========================================================= */

app.post(
  "/withdraw",
  auth,
  async (req, res) => {

    try {

      const telegramId =
        String(
          req.body.telegramId ||
          ""
        );

      const chainKey =
        String(
          req.body.chain ||
          ""
        ).toLowerCase();

      const symbol =
        String(
          req.body.symbol ||
          ""
        ).toUpperCase();

      const destination =
        String(
          req.body.to ||
          ""
        ).trim();

      const amountText =
        String(
          req.body.amount ||
          ""
        ).trim();

      if (
        !validTelegramId(
          telegramId
        )
      ) {

        throw new Error(
          "Invalid Telegram ID"
        );

      }

      if (
        !chains[chainKey]
      ) {

        throw new Error(
          "Unsupported network"
        );

      }

      if (
        !isAddress(
          destination
        )
      ) {

        throw new Error(
          "Invalid EVM destination"
        );

      }

      if (
        !validPositiveNumber(
          amountText
        )
      ) {

        throw new Error(
          "Invalid amount"
        );

      }

      const user =
        await getOrCreateWallet(
          telegramId
        );

      const p =
        await getProvider(
          chainKey
        );

      const wallet =
        derive(
          Number(
            user.wallet_index
          )
        ).connect(p);

      let tx;

      /*
       * Native withdrawal
       */

      if (
        symbol ===
        chains[
          chainKey
        ].native
      ) {

        const value =
          parseUnits(
            amountText,
            18
          );

        const balance =
          await p.getBalance(
            wallet.address
          );

        const fee =
          await p.getFeeData();

        const gasPrice =
          fee.gasPrice ||
          fee.maxFeePerGas ||
          0n;

        const gasLimit =
          21000n;

        const gasCost =
          gasLimit *
          gasPrice;

        if (
          balance <=
          value + gasCost
        ) {

          throw new Error(
            `Insufficient ${chains[chainKey].native} balance`
          );

        }

        tx =
          await wallet.sendTransaction({

            to:
              destination,

            value:
              value,

            gasLimit:
              gasLimit

          });

      } else {

        const info =
          tokens[
            chainKey
          ]?.[symbol];

        if (
          !info
        ) {

          throw new Error(
            "Unsupported token"
          );

        }

        const token =
          new Contract(
            info.address,
            ERC20_ABI,
            wallet
          );

        const amount =
          parseUnits(
            amountText,
            info.decimals
          );

        const balance =
          await token.balanceOf(
            wallet.address
          );

        if (
          balance <
          amount
        ) {

          throw new Error(
            `Insufficient ${symbol} balance`
          );

        }

        tx =
          await token.transfer(
            destination,
            amount
          );

      }

      res.json({

        ok:
          true,

        network:
          chainKey,

        symbol:
          symbol,

        txHash:
          tx.hash,

        explorer:
          chains[
            chainKey
          ].explorer +
          tx.hash

      });

    } catch (e) {

      console.error(
        "withdraw error:",
        errorText(e)
      );

      res.status(400).json({

        ok:
          false,

        error:
          errorText(e) ||
          "Withdraw failed"

      });

    }

  }
);

/* =========================================================
   SWEEP USDT
========================================================= */

app.post(
  "/sweep-usdt",
  auth,
  async (req, res) => {

    try {

      const chainKey =
        String(
          req.body.chain ||
          "bsc"
        ).toLowerCase();

      if (
        !chains[chainKey]
      ) {

        return res.status(400).json({

          ok:
            false,

          error:
            "Unsupported network"

        });

      }

      if (
        !tokens[
          chainKey
        ]?.USDT
      ) {

        return res.status(400).json({

          ok:
            false,

          error:
            "USDT is not configured for this chain"

        });

      }

      const result =
        await sweepUSDT(
          chainKey
        );

      const swept =
        result.results.filter(
          x =>
            x.action ===
            "swept"
        ).length;

      const failed =
        result.results.filter(
          x =>
            x.action ===
            "failed"
        ).length;

      const skipped =
        result.results.filter(
          x =>
            x.action ===
            "skipped"
        ).length;

      res.json({

        ok:
          true,

        ...result,

        swept:
          swept,

        failed:
          failed,

        skipped:
          skipped

      });

    } catch (e) {

      console.error(
        "sweep-usdt error:",
        errorText(e)
      );

      res.status(500).json({

        ok:
          false,

        error:
          errorText(e) ||
          "Sweep operation failed"

      });

    }

  }
);

/* =========================================================
   START SERVER
========================================================= */

async function startServer() {

  try {

    /*
     * DB আগে initialize হবে।
     */

    await initDb();

    app.listen(
      PORT,
      "0.0.0.0",
      () => {

        console.log(
          "======================================"
        );

        console.log(
          `🚀 iCoinGate Wallet API running on ${PORT}`
        );

        console.log(
          `🔐 Central wallet index: ${CENTRAL_WALLET_INDEX}`
        );

        console.log(
          `⏱ Scanner interval: ${SCAN_INTERVAL_MS}ms`
        );

        console.log(
          `🔎 Scanner blocks: ${SCAN_BLOCKS}`
        );

        console.log(
          "======================================"
        );

      }
    );

    /*
     * প্রথম scan server start-এর পরে একটু delay দিয়ে।
     * এতে Render startup-এর সময় RPC চাপ পড়ে না।
     */

    setTimeout(
      () => {

        runScanner();

      },
      5000
    );

    /*
     * Main scanner interval
     */

    setInterval(
      () => {

        runScanner();

      },
      SCAN_INTERVAL_MS
    );

  } catch (e) {

    console.error(
      "❌ FATAL STARTUP ERROR:",
      errorText(e)
    );

    process.exit(1);

  }

}

/* =========================================================
   SCANNER LOCK
========================================================= */

let scannerRunning =
  false;

/* =========================================================
   RUN SCANNER
========================================================= */

async function runScanner() {

  if (
    scannerRunning
  ) {

    console.log(
      "⏳ Previous scanner still running, skipping this cycle."
    );

    return;

  }

  scannerRunning =
    true;

  try {

    console.log(
      "🔄 Scanner started..."
    );

    await scanAll();

    await updateConfirmations();

    console.log(
      "✅ Scanner finished."
    );

  } catch (e) {

    /*
     * Scanner error হলেও server বন্ধ হবে না।
     */

    console.error(
      "❌ Scanner error:",
      errorText(e)
    );

  } finally {

    scannerRunning =
      false;

  }

}

/* =========================================================
   GLOBAL ERROR HANDLERS
========================================================= */

process.on(
  "unhandledRejection",
  error => {

    console.error(
      "⚠️ Unhandled rejection:",
      errorText(error)
    );

  }
);

process.on(
  "uncaughtException",
  error => {

    console.error(
      "⚠️ Uncaught exception:",
      errorText(error)
    );

  }
);

/* =========================================================
   START
========================================================= */

startServer();
import express from "express";

import {
  HDNodeWallet,
  Mnemonic,
  JsonRpcProvider,
  Contract,
  Interface,
  parseUnits,
  formatUnits
} from "ethers";

import pg from "pg";

const { Pool } = pg;

const app = express();

app.use(
  express.json({
    limit: "32kb"
  })
);


/* =========================================================
   SERVER CONFIG
========================================================= */

const PORT =
  process.env.PORT || 3000;

const API_KEY =
  process.env.BOT_API_KEY;

const MASTER_MNEMONIC =
  process.env.MASTER_MNEMONIC;

const DATABASE_URL =
  process.env.DATABASE_URL;


/* =========================================================
   REQUIRED ENV CHECK
========================================================= */

if (
  !API_KEY ||
  !MASTER_MNEMONIC ||
  !DATABASE_URL
) {
  console.error(
    "Missing BOT_API_KEY, MASTER_MNEMONIC or DATABASE_URL"
  );

  process.exit(1);
}


/* =========================================================
   DATABASE
========================================================= */

const pool = new Pool({
  connectionString: DATABASE_URL,

  ssl:
    DATABASE_URL.includes("localhost")
      ? false
      : {
          rejectUnauthorized: false
        }
});


/* =========================================================
   BLOCKCHAIN NETWORKS
========================================================= */

const chains = {

  bsc: {

    name: "BSC",

    rpc:
      process.env.BSC_RPC_URL ||
      "https://bsc-dataseed.binance.org",

    chainId: 56,

    native: "BNB",

    explorer:
      "https://bscscan.com/tx/"

  },


  eth: {

    name: "Ethereum",

    rpc:
      process.env.ETH_RPC_URL ||
      "https://cloudflare-eth.com",

    chainId: 1,

    native: "ETH",

    explorer:
      "https://etherscan.io/tx/"

  }

};


/* =========================================================
   ERC20 TOKENS
========================================================= */

const tokens = {

  bsc: {

    USDT: {

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
        "0xdAC17F958D2ee523a2206206994597C13D831ec7",

      decimals: 6

    },


    USDC: {

      address:
        "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",

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
   INTERFACE
========================================================= */

const ERC20_INTERFACE =
  new Interface(ERC20_ABI);


/* =========================================================
   MASTER HD WALLET
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


/* =========================================================
   AUTHENTICATION
========================================================= */

function auth(
  req,
  res,
  next
) {

  const key =
    req.get("x-api-key");

  if (key !== API_KEY) {

    return res.status(401).json({

      ok: false,

      error:
        "Unauthorized"

    });

  }

  next();

}


/* =========================================================
   TELEGRAM ID VALIDATION
========================================================= */

function validTelegramId(v) {

  return /^\d+$/.test(
    String(v || "")
  );

}


/* =========================================================
   DERIVE WALLET
========================================================= */

function derive(index) {

  return master.derivePath(
    String(index)
  );

}


/* =========================================================
   PROVIDER
========================================================= */

function provider(chain) {

  const c =
    chains[chain];

  if (!c) {

    throw new Error(
      "Unsupported chain"
    );

  }

  return new JsonRpcProvider(
    c.rpc,
    c.chainId
  );

}


/* =========================================================
   DATABASE INITIALIZATION
========================================================= */

async function initDb() {

  await pool.query(`

    CREATE SEQUENCE IF NOT EXISTS
      wallet_index_seq
      START 0
      MINVALUE 0;

    CREATE TABLE IF NOT EXISTS
      wallet_users (

      id BIGSERIAL PRIMARY KEY,

      telegram_id
        TEXT UNIQUE NOT NULL,

      wallet_index
        BIGINT UNIQUE NOT NULL,

      address
        TEXT UNIQUE NOT NULL,

      created_at
        TIMESTAMPTZ NOT NULL
        DEFAULT NOW()

    );


    CREATE TABLE IF NOT EXISTS
      deposits (

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
        INTEGER NOT NULL
        DEFAULT 0,

      block_number
        BIGINT NOT NULL,

      confirmations
        INTEGER NOT NULL
        DEFAULT 0,

      status
        TEXT NOT NULL
        DEFAULT 'pending',

      created_at
        TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

      UNIQUE(
        chain,
        tx_hash,
        log_index
      )

    );


    CREATE TABLE IF NOT EXISTS
      native_snapshots (

      snapshot_key
        TEXT PRIMARY KEY,

      amount
        NUMERIC(78,0)
        NOT NULL

    );


    CREATE INDEX IF NOT EXISTS
      deposits_status_idx
      ON deposits(status,id);


    CREATE INDEX IF NOT EXISTS
      deposits_telegram_idx
      ON deposits(telegram_id,id);


    CREATE INDEX IF NOT EXISTS
      deposits_tx_idx
      ON deposits(tx_hash);

  `);

}


/* =========================================================
   CREATE OR GET USER WALLET
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

      [telegramId]

    );


  if (old.rows[0]) {

    return {

      ...old.rows[0],

      existing: true

    };

  }


  const client =
    await pool.connect();


  try {

    await client.query(
      "BEGIN"
    );


    const again =
      await client.query(

        `
        SELECT
          telegram_id,
          wallet_index,
          address,
          created_at

        FROM wallet_users

        WHERE telegram_id=$1

        FOR UPDATE
        `,

        [telegramId]

      );


    if (again.rows[0]) {

      await client.query(
        "COMMIT"
      );


      return {

        ...again.rows[0],

        existing: true

      };

    }


    const seq =
      await client.query(

        `
        SELECT
          nextval(
            'wallet_index_seq'
          ) AS n
        `

      );


    const index =
      Number(
        seq.rows[0].n
      );


    const wallet =
      derive(index);


    const inserted =
      await client.query(

        `
        INSERT INTO
          wallet_users(
            telegram_id,
            wallet_index,
            address
          )

        VALUES(
          $1,
          $2,
          $3
        )

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

      existing: false

    };


  } catch (e) {

    await client.query(
      "ROLLBACK"
    );


    if (
      e.code === "23505"
    ) {

      return getOrCreateWallet(
        telegramId
      );

    }


    throw e;


  } finally {

    client.release();

  }

}


/* =========================================================
   TOKEN NORMALIZATION
========================================================= */

function normalizeAddress(
  address
) {

  return String(
    address || ""
  ).toLowerCase();

}


/* =========================================================
   EXPLORER LINK
========================================================= */

function getExplorerUrl(
  chain,
  txHash
) {

  return (
    chains[chain]?.explorer ||
    ""
  ) + txHash;

}


/* =========================================================
   SCAN RANGE
========================================================= */

function getScanDepth() {

  const value =
    Number(
      process.env.SCAN_BLOCKS || 100
    );

  if (
    !Number.isFinite(value) ||
    value <= 0
  ) {

    return 100;

  }

  return Math.min(
    value,
    5000
  );

}
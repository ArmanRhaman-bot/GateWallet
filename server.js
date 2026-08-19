import express from "express";
import {
  HDNodeWallet,
  Mnemonic,
  JsonRpcProvider,
  Contract,
  parseUnits,
  formatUnits,
  Wallet,
  Interface
} from "ethers";
import pg from "pg";

const { Pool } = pg;
const app = express();

app.use(express.json({ limit: "32kb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.BOT_API_KEY;
const MASTER_MNEMONIC = process.env.MASTER_MNEMONIC;
const DATABASE_URL = process.env.DATABASE_URL;
const CENTRAL_WALLET_PRIVATE_KEY =
  process.env.CENTRAL_WALLET_PRIVATE_KEY;

if (
  !API_KEY ||
  !MASTER_MNEMONIC ||
  !DATABASE_URL ||
  !CENTRAL_WALLET_PRIVATE_KEY
) {
  console.error(
    "Missing required environment variables"
  );
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false }
});

const chains = {
  bsc: {
    name: "BSC",
    rpc:
      process.env.BSC_RPC_URL ||
      "https://bsc-dataseed.binance.org",
    chainId: 56,
    native: "BNB",
    explorer: "https://bscscan.com/tx/"
  },

  eth: {
    name: "Ethereum",
    rpc:
      process.env.ETH_RPC_URL ||
      "https://cloudflare-eth.com",
    chainId: 1,
    native: "ETH",
    explorer: "https://etherscan.io/tx/"
  }
};

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

const ERC20_ABI = [
  "event Transfer(address indexed from,address indexed to,uint256 value)",

  "function balanceOf(address) view returns (uint256)",

  "function transfer(address to,uint256 amount) returns (bool)"
];

const ERC20_INTERFACE =
  new Interface(ERC20_ABI);

const mnemonic =
  Mnemonic.fromPhrase(
    MASTER_MNEMONIC
  );

const master =
  HDNodeWallet.fromMnemonic(
    mnemonic,
    "m/44'/60'/0'/0"
  );

function auth(req, res, next) {

  if (
    req.get("x-api-key") !==
    API_KEY
  ) {

    return res.status(401).json({
      ok: false,
      error: "Unauthorized"
    });

  }

  next();
}

function validTelegramId(v) {

  return /^\d+$/.test(
    String(v || "")
  );

}

function derive(index) {

  return master.derivePath(
    String(index)
  );

}

function provider(chainKey) {

  const c =
    chains[chainKey];

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

function centralWallet(chainKey) {

  return new Wallet(
    CENTRAL_WALLET_PRIVATE_KEY,
    provider(chainKey)
  );

}

function normalizeAddress(address) {

  return String(
    address || ""
  ).toLowerCase();

}

function getExplorerUrl(
  chain,
  txHash
) {

  return (
    chains[chain]?.explorer ||
    ""
  ) + txHash;

}

function getScanDepth() {

  const n =
    Number(
      process.env.SCAN_BLOCKS || 100
    );

  if (
    !Number.isFinite(n) ||
    n <= 0
  ) {

    return 100;

  }

  return Math.min(
    n,
    5000
  );

}


/* =========================================================
   DATABASE
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

      telegram_id TEXT
        UNIQUE NOT NULL,

      wallet_index BIGINT
        UNIQUE NOT NULL,

      address TEXT
        UNIQUE NOT NULL,

      created_at
        TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS
      deposits (

      id BIGSERIAL PRIMARY KEY,

      telegram_id TEXT NOT NULL,

      chain TEXT NOT NULL,

      symbol TEXT NOT NULL,

      amount
        NUMERIC(78,30)
        NOT NULL,

      tx_hash TEXT NOT NULL,

      log_index INTEGER
        NOT NULL DEFAULT 0,

      block_number BIGINT
        NOT NULL,

      confirmations INTEGER
        NOT NULL DEFAULT 0,

      status TEXT
        NOT NULL DEFAULT 'pending',

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

    CREATE TABLE IF NOT EXISTS
      native_snapshots (

      snapshot_key TEXT PRIMARY KEY,

      amount
        NUMERIC(78,0)
        NOT NULL
    );

    CREATE INDEX IF NOT EXISTS
      deposits_status_idx
      ON deposits(status,id);

  `);

}


/* =========================================================
   WALLET
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
        SELECT nextval(
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
        INSERT INTO wallet_users(
          telegram_id,
          wallet_index,
          address
        )

        VALUES(
          $1,$2,$3
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
   ERC20 SCANNER
========================================================= */

async function scanToken(
  chainKey,
  symbol,
  info,
  userAddress,
  latestBlock
) {

  const p =
    provider(chainKey);

  const depth =
    getScanDepth();

  const fromBlock =
    Math.max(
      0,
      latestBlock - depth
    );

  const normalizedUser =
    normalizeAddress(
      userAddress
    );

  const transferTopic =
    ERC20_INTERFACE
      .getEvent(
        "Transfer"
      )
      .topicHash;

  const paddedAddress =
    "0x" +
    normalizedUser
      .replace(/^0x/, "")
      .padStart(64, "0");

  let logs;

  try {

    logs =
      await p.getLogs({

        address:
          info.address,

        fromBlock,

        toBlock:
          latestBlock,

        topics: [

          transferTopic,

          null,

          paddedAddress

        ]

      });

  } catch (e) {

    console.error(
      "ERC20 getLogs failed:",
      chainKey,
      symbol,
      e.message
    );

    return;

  }

  for (
    const log of logs
  ) {

    try {

      const parsed =
        ERC20_INTERFACE.parseLog({

          topics:
            log.topics,

          data:
            log.data

        });

      if (!parsed) {
        continue;
      }

      const value =
        parsed.args.value;

      const amount =
        formatUnits(
          value,
          info.decimals
        );

      if (
        Number(amount) <= 0
      ) {
        continue;
      }

      const destination =
        normalizeAddress(
          parsed.args.to
        );

      if (
        destination !==
        normalizedUser
      ) {
        continue;
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

      await pool.query(

        `
        INSERT INTO deposits(
          telegram_id,
          chain,
          symbol,
          amount,
          tx_hash,
          log_index,
          block_number,
          confirmations,
          status
        )

        SELECT
          telegram_id,
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          0,
          'pending'

        FROM wallet_users

        WHERE LOWER(address)
          = LOWER($7)

        ON CONFLICT(
          chain,
          tx_hash,
          log_index
        )

        DO NOTHING
        `,

        [
          chainKey,
          symbol,
          amount,
          txHash,
          logIndex,
          blockNumber,
          userAddress
        ]

      );

    } catch (e) {

      console.error(
        "Token processing:",
        e.message
      );

    }

  }

}

/* =========================================================
   NATIVE SCANNER
========================================================= */

async function scanNative(
  chainKey,
  user,
  latestBlock
) {

  const p =
    provider(chainKey);

  let current;

  try {

    current =
      (
        await p.getBalance(
          user.address
        )
      ).toString();

  } catch (e) {

    return;

  }

  const key =
    `native:${chainKey}:${user.address.toLowerCase()}`;

  const old =
    await pool.query(

      `
      SELECT amount
      FROM native_snapshots
      WHERE snapshot_key=$1
      `,

      [key]

    );

  if (!old.rows[0]) {

    await pool.query(

      `
      INSERT INTO native_snapshots(
        snapshot_key,
        amount
      )

      VALUES($1,$2)

      ON CONFLICT(snapshot_key)

      DO UPDATE SET
        amount=EXCLUDED.amount
      `,

      [
        key,
        current
      ]

    );

    return;

  }

  const delta =
    BigInt(current) -
    BigInt(
      old.rows[0].amount
    );

  if (delta > 0n) {

    const amount =
      formatUnits(
        delta,
        18
      );

    const synthetic =
      `native:${chainKey}:${user.address}:${current}`;

    await pool.query(

      `
      INSERT INTO deposits(
        telegram_id,
        chain,
        symbol,
        amount,
        tx_hash,
        log_index,
        block_number,
        confirmations,
        status
      )

      VALUES(
        $1,$2,$3,$4,$5,-1,$6,0,'pending'
      )

      ON CONFLICT(
        chain,
        tx_hash,
        log_index
      )

      DO NOTHING
      `,

      [
        user.telegram_id,
        chainKey,
        chains[chainKey].native,
        amount,
        synthetic,
        latestBlock
      ]

    );

  }

  await pool.query(

    `
    UPDATE native_snapshots

    SET amount=$2

    WHERE snapshot_key=$1
    `,

    [
      key,
      current
    ]

  );

}


/* =========================================================
   SCAN ALL
========================================================= */

async function scanAll() {

  const users =
    await pool.query(

      `
      SELECT
        telegram_id,
        wallet_index,
        address

      FROM wallet_users

      ORDER BY id ASC
      `

    );

  for (
    const [chainKey]
      of Object.entries(chains)
  ) {

    try {

      const p =
        provider(chainKey);

      const latest =
        await p.getBlockNumber();

      for (
        const user
          of users.rows
      ) {

        await scanNative(
          chainKey,
          user,
          latest
        );

        const chainTokens =
          tokens[chainKey] || {};

        for (
          const [
            symbol,
            info
          ]
            of Object.entries(
              chainTokens
            )
        ) {

          await scanToken(
            chainKey,
            symbol,
            info,
            user.address,
            latest
          );

        }

      }

    } catch (e) {

      console.error(
        "scan chain error:",
        chainKey,
        e.message
      );

    }

  }

}


/* =========================================================
   CONFIRMATIONS
========================================================= */

async function updateConfirmations() {

  const required =
    Number(
      process.env.CONFIRMATIONS || 3
    );

  for (
    const chainKey
      of Object.keys(chains)
  ) {

    try {

      const latest =
        await provider(
          chainKey
        ).getBlockNumber();

      const rows =
        await pool.query(

          `
          SELECT
            id,
            block_number

          FROM deposits

          WHERE chain=$1

          AND status='pending'

          ORDER BY id ASC

          LIMIT 1000
          `,

          [chainKey]

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
            confirmations >= required
              ? "confirmed"
              : "pending"
          ]

        );

      }

    } catch (e) {

      console.error(
        "confirmation error:",
        chainKey,
        e.message
      );

    }

  }

}


/* =========================================================
   USDT SWEEP
========================================================= */

async function sweepUSDT(
  chainKey,
  user
) {

  const info =
    tokens[chainKey]?.USDT;

  if (!info) {
    throw new Error(
      "USDT unavailable"
    );
  }

  const p =
    provider(chainKey);

  const depositWallet =
    derive(
      Number(
        user.wallet_index
      )
    ).connect(p);

  const central =
    centralWallet(
      chainKey
    );

  const token =
    new Contract(
      info.address,
      ERC20_ABI,
      depositWallet
    );

  const balance =
    await token.balanceOf(
      depositWallet.address
    );

  const minimum =
    parseUnits(
      String(
        process.env.SWEEP_MIN_USDT || "1"
      ),
      info.decimals
    );

  if (
    balance < minimum
  ) {

    return {
      ok: true,
      skipped: true
    };

  }

  const gasReserve =
    parseUnits(
      chainKey === "bsc"
        ? String(
            process.env.GAS_RESERVE_BNB ||
            "0.0001"
          )
        : String(
            process.env.GAS_RESERVE_ETH ||
            "0.001"
          ),
      18
    );

  const nativeBalance =
    await p.getBalance(
      depositWallet.address
    );

  if (
    nativeBalance < gasReserve
  ) {

    const gasTx =
      await central.sendTransaction({

        to:
          depositWallet.address,

        value:
          gasReserve -
          nativeBalance

      });

    await gasTx.wait();

  }

  const sweepToken =
    new Contract(
      info.address,
      ERC20_ABI,
      depositWallet
    );

  const tx =
    await sweepToken.transfer(
      central.address,
      balance
    );

  const receipt =
    await tx.wait();

  return {

    ok: true,

    amount:
      formatUnits(
        balance,
        info.decimals
      ),

    from:
      depositWallet.address,

    to:
      central.address,

    txHash:
      receipt.hash,

    explorer:
      getExplorerUrl(
        chainKey,
        receipt.hash
      )

  };

}


/* =========================================================
   SWEEP ALL USDT
========================================================= */

async function sweepAllUSDT() {

  const users =
    await pool.query(

      `
      SELECT
        telegram_id,
        wallet_index,
        address

      FROM wallet_users

      ORDER BY id ASC
      `

    );

  for (
    const chainKey
      of Object.keys(chains)
  ) {

    for (
      const user
        of users.rows
    ) {

      try {

        const result =
          await sweepUSDT(
            chainKey,
            user
          );

        if (
          result.ok &&
          !result.skipped
        ) {

          console.log(
            `[SWEEP] ${chainKey} ${user.address} ${result.amount} USDT ${result.txHash}`
          );

        }

      } catch (e) {

        console.error(
          `[SWEEP ERROR] ${chainKey} ${user.address}:`,
          e.message
        );

      }

    }

  }

}


/* =========================================================
   ROUTES
========================================================= */

app.get(
  "/",
  (req, res) => {

    res.json({

      ok: true,

      service:
        "iCoinGate EVM Wallet API",

      networks: [
        "BNB BEP20",
        "Ethereum ERC20"
      ],

      endpoints: {

        wallet:
          "POST /wallet",

        deposits:
          "GET /deposits",

        sweep:
          "POST /sweep-usdt",

        health:
          "GET /health"

      }

    });

  }
);


app.get(
  "/health",
  async (req, res) => {

    try {

      await pool.query(
        "SELECT 1"
      );

      res.json({
        ok: true
      });

    } catch (e) {

      res.status(503).json({
        ok: false
      });

    }

  }
);


app.post(
  "/wallet",
  auth,
  async (req, res) => {

    try {

      const telegramId =
        String(
          req.body.telegramId || ""
        );

      if (
        !validTelegramId(
          telegramId
        )
      ) {

        return res.status(400).json({
          ok: false,
          error:
            "Invalid Telegram ID"
        });

      }

      const row =
        await getOrCreateWallet(
          telegramId
        );

      res.json({

        ok: true,

        existing:
          row.existing,

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

      res.status(500).json({

        ok: false,

        error:
          "Wallet generation failed"

      });

    }

  }
);


app.get(
  "/wallet/:telegramId",
  auth,
  async (req, res) => {

    try {

      const telegramId =
        String(
          req.params.telegramId
        );

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

          [telegramId]

        );

      if (!q.rows[0]) {

        return res.status(404).json({
          ok: false,
          error:
            "Wallet not found"
        });

      }

      const row =
        q.rows[0];

      res.json({

        ok: true,

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
        ok: false,
        error:
          "Database error"
      });

    }

  }
);


app.get(
  "/deposits",
  auth,
  async (req, res) => {

    try {

      const status =
        String(
          req.query.status ||
          "confirmed"
        ).toLowerCase();

      if (
        ![
          "pending",
          "confirmed"
        ].includes(status)
      ) {

        return res.status(400).json({
          ok: false,
          error:
            "Invalid status"
        });

      }

      const limit =
        Math.min(
          100,
          Math.max(
            1,
            Number(
              req.query.limit || 50
            )
          )
        );

      const telegramId =
        req.query.telegramId
          ? String(
              req.query.telegramId
            )
          : null;

      let q;

      if (telegramId) {

        q =
          await pool.query(

            `
            SELECT *
            FROM deposits

            WHERE status=$1
            AND telegram_id=$2

            ORDER BY id DESC

            LIMIT $3
            `,

            [
              status,
              telegramId,
              limit
            ]

          );

      } else {

        q =
          await pool.query(

            `
            SELECT *
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

      }

      const deposits =
        q.rows.map(
          row => ({

            ...row,

            explorer:
              row.tx_hash.startsWith(
                "native:"
              )
                ? null
                : getExplorerUrl(
                    row.chain,
                    row.tx_hash
                  )

          })
        );

      res.json({

        ok: true,

        count:
          deposits.length,

        deposits

      });

    } catch (e) {

      res.status(500).json({

        ok: false,

        error:
          "Failed to fetch deposits"

      });

    }

  }
);


/* =========================================================
   SWEEP USDT - BSC
   Auto detects USDT and sends to CENTRAL WALLET
========================================================= */

app.post("/sweep-usdt", auth, async (req, res) => {
  try {

    /* ---------- CONFIG ---------- */

    const chainKey = "bsc";
    const symbol = "USDT";

    const destination =
      process.env.CENTRAL_WALLET_ADDRESS;

    const minBalance =
      Number(process.env.SWEEP_MIN_USDT || "0.01");

    if (!destination ||
        !/^0x[a-fA-F0-9]{40}$/.test(destination)) {

      return res.status(500).json({
        ok: false,
        error: "CENTRAL_WALLET_ADDRESS is not configured"
      });
    }

    /* ---------- USERS ---------- */

    const users = await pool.query(`
      SELECT
        telegram_id,
        wallet_index,
        address
      FROM wallet_users
      ORDER BY wallet_index ASC
    `);

    if (!users.rows.length) {
      return res.json({
        ok: true,
        swept: 0,
        message: "No users found",
        results: []
      });
    }

    /* ---------- TOKEN ---------- */

    const info =
      tokens[chainKey]?.[symbol];

    if (!info) {
      return res.status(400).json({
        ok: false,
        error: "BSC USDT token configuration not found"
      });
    }

    const p = provider(chainKey);

    const tokenContract =
      new Contract(
        info.address,
        ERC20_ABI,
        p
      );

    const results = [];

    let totalSwept = 0;

    /* ---------- SCAN ---------- */

    for (const user of users.rows) {

      try {

        const wallet =
          derive(
            Number(user.wallet_index)
          ).connect(p);

        const actualAddress =
          await wallet.getAddress();

        /* Check USDT */

        const balance =
          await tokenContract.balanceOf(
            actualAddress
          );

        const formattedBalance =
          Number(
            formatUnits(
              balance,
              info.decimals
            )
          );

        if (
          formattedBalance < minBalance
        ) {

          results.push({
            telegramId: user.telegram_id,
            address: actualAddress,
            usdt: formattedBalance,
            action: "skipped"
          });

          continue;
        }

        /* ---------- CHECK BNB ---------- */

        const bnbBalance =
          await p.getBalance(
            actualAddress
          );

        /*
         * Minimum BNB required for USDT transfer.
         * ~0.0002 BNB gives reasonable gas reserve.
         */

        const minGas =
          parseEther("0.0002");

        if (
          bnbBalance < minGas
        ) {

          results.push({
            telegramId: user.telegram_id,
            address: actualAddress,
            usdt: formattedBalance,
            bnb:
              formatEther(bnbBalance),
            action: "needs_gas"
          });

          continue;
        }

        /* ---------- SEND USDT ---------- */

        const tx =
          await tokenContract
            .connect(wallet)
            .transfer(
              destination,
              balance
            );

        results.push({
          telegramId: user.telegram_id,
          address: actualAddress,
          usdt: formattedBalance,
          txHash: tx.hash,
          action: "swept"
        });

        totalSwept +=
          formattedBalance;

        await new Promise(
          resolve =>
            setTimeout(resolve, 2000)
        );

      } catch (e) {

        console.error(
          "Sweep error:",
          user.telegram_id,
          e.message
        );

        results.push({
          telegramId: user.telegram_id,
          address: user.address,
          action: "failed",
          error: e.message
        });
      }
    }

    /* ---------- RESPONSE ---------- */

    return res.json({
      ok: true,
      chain: chainKey,
      symbol,
      destination,
      totalSwept,
      results
    });

  } catch (e) {

    console.error(
      "Sweep USDT error:",
      e
    );

    return res.status(500).json({
      ok: false,
      error: e.message
    });
  }
});


/* =========================================================
   START
========================================================= */

await initDb();

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `🚀 iCoinGate EVM Wallet API running on ${PORT}`
    );

  }
);

/* =========================================================
   AUTOMATIC SCANNER + SWEEPER
========================================================= */

const interval =
  Number(
    process.env.SCAN_INTERVAL_MS ||
    30000
  );

setInterval(
  async () => {

    try {

      await scanAll();

      await updateConfirmations();

      await sweepAllUSDT();

    } catch (e) {

      console.error(
        "Worker error:",
        e.message
      );

    }

  },
  interval
);
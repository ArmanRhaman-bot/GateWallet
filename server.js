import express from "express";
import {
  HDNodeWallet,
  Mnemonic,
  JsonRpcProvider,
  Contract,
  parseUnits,
  formatUnits,
  isAddress
} from "ethers";
import pg from "pg";

const { Pool } = pg;
const app = express();
app.use(express.json({ limit: "64kb" }));

const PORT = Number(process.env.PORT || 3000);
const API_KEY = String(process.env.BOT_API_KEY || "");
const MASTER_MNEMONIC = String(process.env.MASTER_MNEMONIC || "");
const DATABASE_URL = String(process.env.DATABASE_URL || "");

const CENTRAL_WALLET_INDEX =
  Number(process.env.CENTRAL_WALLET_INDEX || 999999);

const CONFIRMATIONS =
  Number(process.env.CONFIRMATIONS || 3);

const SCAN_INTERVAL_MS =
  Number(process.env.SCAN_INTERVAL_MS || 30000);

const SCAN_BLOCKS =
  Number(process.env.SCAN_BLOCKS || 100);

const LOG_CHUNK =
  Number(process.env.LOG_CHUNK || 500);

const SWEEP_MIN_USDT =
  String(process.env.SWEEP_MIN_USDT || "0.000001");

const SWEEP_GAS_MULTIPLIER =
  Number(process.env.SWEEP_GAS_MULTIPLIER || 2);

if (!API_KEY || !MASTER_MNEMONIC || !DATABASE_URL) {
  console.error(
    "Missing BOT_API_KEY, MASTER_MNEMONIC or DATABASE_URL"
  );
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
  max: 5
});

const chains = {

  bsc: {
    name: "BSC",
    chainId: 56,
    native: "BNB",
    explorer: "https://bscscan.com/tx/",

    rpcs: (
      process.env.BSC_RPC_URLS ||
      process.env.BSC_RPC_URL ||
      "https://bsc-dataseed.binance.org"
    )
      .split(",")
      .map(x => x.trim())
      .filter(Boolean),

    centralAddress:
      String(
        process.env.CENTRAL_BSC_ADDRESS || ""
      )
  },

  eth: {
    name: "Ethereum",
    chainId: 1,
    native: "ETH",
    explorer: "https://etherscan.io/tx/",

    rpcs: (
      process.env.ETH_RPC_URLS ||
      process.env.ETH_RPC_URL ||
      "https://cloudflare-eth.com"
    )
      .split(",")
      .map(x => x.trim())
      .filter(Boolean),

    centralAddress:
      String(
        process.env.CENTRAL_ETH_ADDRESS || ""
      )
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
    req.get("x-api-key") !== API_KEY
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

function rpcList(chainKey) {

  const c =
    chains[chainKey];

  if (!c) {
    throw new Error(
      "Unsupported chain"
    );
  }

  return c.rpcs;

}

function provider(
  chainKey,
  rpc
) {

  const c =
    chains[chainKey];

  return new JsonRpcProvider(
    rpc || c.rpcs[0],
    {
      name:
        c.name.toLowerCase(),
      chainId:
        c.chainId
    },
    {
      staticNetwork: true
    }
  );

}

async function getProvider(
  chainKey
) {

  let last;

  for (
    const rpc of rpcList(chainKey)
  ) {

    try {

      const p =
        provider(
          chainKey,
          rpc
        );

      const network =
        await p.getNetwork();

      if (
        Number(network.chainId) !==
        chains[chainKey].chainId
      ) {

        throw new Error(
          `Wrong chain returned by RPC: ${network.chainId}`
        );

      }

      await p.getBlockNumber();

      return p;

    } catch (e) {

      last = e;

      console.error(
        `[RPC ERROR] ${chainKey} ${rpc}: ${e.message}`
      );

    }

  }

  throw new Error(
    `No working RPC for ${chainKey}: ${
      last?.message || "unknown error"
    }`
  );

}

async function withProvider(
  chainKey,
  fn
) {

  let last;

  for (
    const rpc of rpcList(chainKey)
  ) {

    try {

      const p =
        provider(
          chainKey,
          rpc
        );

      const network =
        await p.getNetwork();

      if (
        Number(network.chainId) !==
        chains[chainKey].chainId
      ) {

        throw new Error(
          "RPC returned wrong network"
        );

      }

      return await fn(p);

    } catch (e) {

      last = e;

      console.error(
        `[RPC RETRY] ${chainKey} ${rpc}: ${e.message}`
      );

    }

  }

  throw (
    last ||
    new Error("RPC failed")
  );

}

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

  `);

}

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

  if (
    old.rows[0]
  ) {

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

    const seq =
      await client.query(
        `
        SELECT
          nextval(
            'wallet_index_seq'
          ) AS n
        `
      );

    let index =
      Number(
        seq.rows[0].n
      );

    if (
      index ===
      CENTRAL_WALLET_INDEX
    ) {

      index =
        Number(
          (
            await client.query(
              `
              SELECT
                nextval(
                  'wallet_index_seq'
                ) AS n
              `
            )
          )
          .rows[0]
          .n
        );

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

async function scanToken(
  chainKey,
  symbol,
  info,
  userAddress,
  latestBlock
) {

  await withProvider(
    chainKey,
    async p => {

      const contract =
        new Contract(
          info.address,
          ERC20_ABI,
          p
        );

      const filter =
        contract.filters.Transfer(
          null,
          userAddress
        );

      const start =
        Math.max(
          0,
          latestBlock - SCAN_BLOCKS
        );

      /*
       * IMPORTANT:
       * Small chunks prevent
       * "limit exceeded".
       */

      for (
        let from = start;
        from <= latestBlock;
        from += LOG_CHUNK + 1
      ) {

        const to =
          Math.min(
            latestBlock,
            from + LOG_CHUNK
          );

        let logs;

        try {

          logs =
            await contract.queryFilter(
              filter,
              from,
              to
            );

        } catch (e) {

          console.error(
            `[GETLOGS ERROR] ${chainKey} ${symbol} ${from}-${to}: ${e.message}`
          );

          continue;

        }

        for (
          const log of logs
        ) {

          const value =
            log.args?.[2];

          if (
            value === undefined
          ) {
            continue;
          }

          const txHash =
            log.transactionHash;

          const logIndex =
            Number(
              log.index ?? 0
            );

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

            SELECT
              telegram_id,
              $1,
              $2,
              $3,
              $4,
              $5,
              $6,
              'pending'

            FROM wallet_users

            WHERE
              LOWER(address)
              =
              LOWER($7)

            ON CONFLICT
            (
              chain,
              tx_hash,
              log_index
            )

            DO NOTHING
            `,
            [
              chainKey,
              symbol,
              formatUnits(
                value,
                info.decimals
              ),
              txHash,
              logIndex,
              Number(
                log.blockNumber
              ),
              userAddress
            ]
          );

        }

      }

    }
  );

}

async function scanNative(
  chainKey,
  user,
  latestBlock
) {

  await withProvider(
    chainKey,
    async p => {

      const current =
        (
          await p.getBalance(
            user.address
          )
        ).toString();

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

      if (
        !old.rows[0]
      ) {

        await pool.query(
          `
          INSERT INTO
          native_snapshots
          (
            snapshot_key,
            amount
          )

          VALUES
          ($1,$2)

          ON CONFLICT
          (snapshot_key)

          DO UPDATE SET
          amount =
          EXCLUDED.amount
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

      if (
        delta > 0n
      ) {

        const synthetic =
          `native:${chainKey}:${user.address}:${current}`;

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
            $1,$2,$3,$4,$5,
            -1,$6,'pending'
          )

          ON CONFLICT
          (
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
            formatUnits(
              delta,
              18
            ),
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
  );

}

async function scanAll() {

  const users =
    await pool.query(
      `
      SELECT
        telegram_id,
        address

      FROM wallet_users

      ORDER BY wallet_index ASC
      `
    );

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

      for (
        const user
        of users.rows
      ) {

        try {

          await scanNative(
            chainKey,
            user,
            latest
          );

          for (
            const [
              symbol,
              info
            ]
            of Object.entries(
              tokens[chainKey]
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

        } catch (e) {

          console.error(
            `[SCAN USER ERROR] ${chainKey} ${user.telegram_id}: ${e.message}`
          );

        }

      }

    } catch (e) {

      console.error(
        `[SCAN CHAIN ERROR] ${chainKey}: ${e.message}`
      );

    }

  }

}

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
            AND
            status='pending'
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
            confirmations >=
            CONFIRMATIONS
              ? "confirmed"
              : "pending"
          ]
        );

      }

    } catch (e) {

      console.error(
        `[CONFIRM ERROR] ${chainKey}: ${e.message}`
      );

    }

  }

}

async function getTokenBalance(
  chainKey,
  info,
  address
) {

  return withProvider(
    chainKey,
    async p => {

      const code =
        await p.getCode(
          info.address
        );

      if (
        !code ||
        code === "0x"
      ) {

        throw new Error(
          `Token contract not found on ${chainKey}`
        );

      }

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
    configured &&
    configured.toLowerCase() !==
    wallet.address.toLowerCase()
  ) {

    throw new Error(
      `CENTRAL_${chainKey.toUpperCase()}_ADDRESS does not match CENTRAL_WALLET_INDEX wallet`
    );

  }

  return {
    p,
    wallet
  };

}

async function ensureGas(
  chainKey,
  userWallet,
  tokenContract
) {

  const c =
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

  if (!gasPrice) {
    gasPrice =
      feeData.maxFeePerGas;
  }

  if (!gasPrice) {

    throw new Error(
      `Cannot determine ${c.native} gas price`
    );

  }

  let gasLimit;

  try {

    gasLimit =
      await tokenContract
        .transfer
        .estimateGas(
          c.centralAddress,
          1n
        );

  } catch {

    gasLimit =
      70000n;

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
      funded: false,
      amount: 0n
    };

  }

  const missing =
    required -
    nativeBalance;

  const {
    wallet: central
  } =
    await centralWallet(
      chainKey
    );

  const centralBalance =
    await central.provider.getBalance(
      central.address
    );

  if (
    centralBalance <=
    missing
  ) {

    throw new Error(
      `Central ${c.native} balance is insufficient for gas funding`
    );

  }

  const fundTx =
    await central.sendTransaction({
      to:
        userWallet.address,
      value:
        missing
    });

  await fundTx.wait(1);

  return {
    funded: true,
    amount: missing,
    txHash: fundTx.hash
  };

}

async function sweepUSDT(
  chainKey
) {

  const info =
    tokens[
      chainKey
    ]?.USDT;

  if (!info) {

    throw new Error(
      "USDT is not configured for this chain"
    );

  }

  const destination =
    chains[
      chainKey
    ].centralAddress;

  if (
    !isAddress(destination)
  ) {

    throw new Error(
      `Set CENTRAL_${chainKey.toUpperCase()}_ADDRESS correctly`
    );

  }

  const central =
    await centralWallet(
      chainKey
    );

  if (
    central.wallet.address.toLowerCase() !==
    destination.toLowerCase()
  ) {

    throw new Error(
      "Central address must be the derived central wallet address"
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
        wallet_index<>$1

      ORDER BY
        wallet_index ASC
      `,
      [
        CENTRAL_WALLET_INDEX
      ]
    );

  const results = [];

  let total = 0n;

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

      const token =
        new Contract(
          info.address,
          ERC20_ABI,
          userWallet
        );

      const balance =
        await getTokenBalance(
          chainKey,
          info,
          userWallet.address
        );

      if (
        balance <= min
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

      /*
       * User wallet-এ BNB/ETH না থাকলে
       * Central wallet থেকে gas পাঠাবে।
       */

      const gas =
        await ensureGas(
          chainKey,
          userWallet,
          token
        );

      const tx =
        await token.transfer(
          destination,
          balance
        );

      await tx.wait(1);

      total += balance;

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

        gasFunded:
          gas.funded,

        gasTxHash:
          gas.txHash || null,

        txHash:
          tx.hash,

        action:
          "swept"

      });

    } catch (e) {

      console.error(
        `[SWEEP ERROR] ${chainKey} ${user.address}: ${e.message}`
      );

      results.push({

        telegramId:
          user.telegram_id,

        address:
          user.address,

        action:
          "failed",

        error:
          e.message

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

app.get(
  "/",
  (req, res) => {

    res.json({

      ok: true,

      service:
        "iCoinGate EVM Wallet API"

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

      const rpc = {};

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
            `ERROR: ${e.message}`;

        }

      }

      res.json({
        ok: true,
        rpc
      });

    } catch (e) {

      res.status(503).json({
        ok: false,
        error:
          "Database unavailable"
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
        "wallet error",
        e
      );

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
            String(
              req.params.telegramId
            )
          ]
        );

      if (
        !q.rows[0]
      ) {

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
        );

      const limit =
        Math.min(
          100,
          Math.max(
            1,
            Number(
              req.query.limit ||
              50
            )
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
        ok: true,
        deposits:
          q.rows
      });

    } catch (e) {

      res.status(500).json({
        ok: false,
        error:
          e.message
      });

    }

  }
);

app.post(
  "/withdraw",
  auth,
  async (req, res) => {

    try {

      const telegramId =
        String(
          req.body.telegramId || ""
        );

      const chainKey =
        String(
          req.body.chain || ""
        ).toLowerCase();

      const symbol =
        String(
          req.body.symbol || ""
        ).toUpperCase();

      const destination =
        String(
          req.body.to || ""
        );

      const amountText =
        String(
          req.body.amount || ""
        );

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
        !amountText ||
        Number(amountText) <= 0
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

      if (
        symbol ===
        chains[chainKey].native
      ) {

        tx =
          await wallet.sendTransaction({
            to:
              destination,

            value:
              parseUnits(
                amountText,
                18
              )
          });

      } else {

        const info =
          tokens[
            chainKey
          ]?.[symbol];

        if (!info) {

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

        tx =
          await token.transfer(
            destination,
            parseUnits(
              amountText,
              info.decimals
            )
          );

      }

      res.json({

        ok: true,

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
        "withdraw error",
        e
      );

      res.status(400).json({

        ok: false,

        error:
          e.message ||
          "Withdraw failed"

      });

    }

  }
);

/* =========================================================
   USDT SWEEP
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
        !tokens[
          chainKey
        ]?.USDT
      ) {

        return res.status(400).json({

          ok: false,

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

      res.json({

        ok: true,

        ...result,

        swept:

          swept,

        failed:

          failed

      });

    } catch (e) {

      console.error(
        "sweep-usdt error",
        e
      );

      res.status(500).json({

        ok: false,

        error:
          e.message ||
          "Sweep operation failed"

      });

    }

  }
);

await initDb();

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `iCoinGate EVM Wallet API running on ${PORT}`
    );

    console.log(
      `Central wallet index: ${CENTRAL_WALLET_INDEX}`
    );

  }
);

let scannerRunning =
  false;

setInterval(
  async () => {

    if (
      scannerRunning
    ) {

      return;

    }

    scannerRunning =
      true;

    try {

      await scanAll();

      await updateConfirmations();

    } catch (e) {

      console.error(
        "scanner error",
        e
      );

    } finally {

      scannerRunning =
        false;

    }

  },
  SCAN_INTERVAL_MS
);
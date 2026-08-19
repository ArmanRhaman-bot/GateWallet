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

/* =========================================================
   ERC20 TOKEN SCANNER
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


  /*
   * ERC20 Transfer event:
   *
   * Transfer(
   *   address indexed from,
   *   address indexed to,
   *   uint256 value
   * )
   *
   * Topic #0 =
   * keccak256("Transfer(address,address,uint256)")
   */


  const transferTopic =
    ERC20_INTERFACE
      .getEvent(
        "Transfer"
      )
      .topicHash;


  /*
   * Topic #2 contains
   * destination address.
   *
   * We don't use Contract.queryFilter()
   * here because direct provider.getLogs()
   * is more reliable for this scanner.
   */


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
      userAddress,
      e.message
    );

    return;

  }


  if (
    !Array.isArray(logs) ||
    logs.length === 0
  ) {

    return;

  }


  /*
   * Process EVERY matching log.
   *
   * Therefore if:
   *
   * USDT 0.10
   * USDT 0.20
   * BNB 0.001
   *
   * are deposited before the next scan,
   * none of the token deposits are discarded.
   */


  for (
    const log of logs
  ) {

    try {

      if (
        !log ||
        !log.transactionHash
      ) {

        continue;

      }


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


      if (
        value === undefined ||
        value === null
      ) {

        continue;

      }


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


      const txHash =
        log.transactionHash;


      /*
       * ethers v6 log.index
       */

      const logIndex =
        Number(
          log.index ?? 0
        );


      const blockNumber =
        Number(
          log.blockNumber
        );


      /*
       * Verify destination again.
       */

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


      /*
       * Insert pending deposit.
       *
       * UNIQUE(chain,tx_hash,log_index)
       * prevents duplicates.
       */

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

        "Token log processing error:",

        chainKey,

        symbol,

        e.message

      );

    }

  }

}


/* =========================================================
   NATIVE COIN SCANNER
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

    console.error(
      "Native balance error:",
      chainKey,
      user.telegram_id,
      e.message
    );

    return;

  }


  const key =
    `native:${chainKey}:${user.address.toLowerCase()}`;


  const old =
    await pool.query(

      `
      SELECT
        amount

      FROM native_snapshots

      WHERE snapshot_key=$1
      `,

      [key]

    );


  /*
   * First scan only establishes
   * the baseline.
   *
   * This prevents old wallet balance
   * from being treated as a new deposit.
   */

  if (
    !old.rows[0]
  ) {

    await pool.query(

      `
      INSERT INTO native_snapshots(
        snapshot_key,
        amount
      )

      VALUES(
        $1,
        $2
      )

      ON CONFLICT(
        snapshot_key
      )

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


  const previous =
    BigInt(
      old.rows[0].amount
    );


  const now =
    BigInt(current);


  const delta =
    now - previous;


  /*
   * Positive balance difference
   * means new native deposit.
   */

  if (
    delta > 0n
  ) {

    const amount =
      formatUnits(
        delta,
        18
      );


    /*
     * IMPORTANT:
     *
     * Native transfers don't expose
     * the exact TX hash using balance
     * difference alone.
     *
     * We therefore use a synthetic
     * identifier.
     *
     * ERC20 deposits use the real TX hash.
     */

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

        $1,

        $2,

        $3,

        $4,

        $5,

        -1,

        $6,

        0,

        'pending'

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


  /*
   * Always update snapshot.
   */

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
   SCAN ALL USERS
========================================================= */

async function scanAll() {

  const users =
    await pool.query(

      `
      SELECT
        telegram_id,
        address

      FROM wallet_users

      ORDER BY id ASC
      `

    );


  if (
    users.rows.length === 0
  ) {

    return;

  }


  /*
   * Scan every chain.
   */

  for (
    const [chainKey]
      of Object.entries(chains)
  ) {

    try {

      const p =
        provider(chainKey);


      const latest =
        await p.getBlockNumber();


      console.log(
        `[SCAN] ${chainKey.toUpperCase()} block ${latest}`
      );


      /*
       * Scan every wallet.
       */

      for (
        const user
          of users.rows
      ) {

        try {

          /*
           * Native:
           * BNB / ETH
           */

          await scanNative(
            chainKey,
            user,
            latest
          );


          /*
           * ERC20:
           * USDT / USDC / BUSD
           */

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


        } catch (e) {

          console.error(

            "scan user error",

            chainKey,

            user.telegram_id,

            e.message

          );

        }

      }


    } catch (e) {

      console.error(

        "scan chain error",

        chainKey,

        e.message

      );

    }

  }

}


/* =========================================================
   UPDATE CONFIRMATIONS
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

        const block =
          Number(
            row.block_number
          );


        const confirmations =
          Math.max(

            0,

            latest -
              block +
              1

          );


        const status =
          confirmations >= required
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

        "confirmation error",

        chainKey,

        e.message

      );

    }

  }

}


/* =========================================================
   HEALTH CHECK
========================================================= */

app.get(
  "/health",
  async (req, res) => {

    try {

      await pool.query(
        "SELECT 1"
      );


      res.json({

        ok: true,

        service:
          "iCoinGate EVM Wallet API",

        time:
          new Date().toISOString()

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


/* =========================================================
   ROOT
========================================================= */

app.get(
  "/",
  (req, res) => {

    res.json({

      message:
        "🚀 iCoinGate EVM Wallet API",

      networks: [

        "BNB BEP20",

        "Ethereum ERC20"

      ],

      supportedTokens: {

        bsc: [
          "BNB",
          "USDT",
          "USDC",
          "BUSD"
        ],

        eth: [
          "ETH",
          "USDT",
          "USDC",
          "BUSD"
        ]

      },

      endpoints: {

        createOrGetWallet:
          "POST /wallet",

        getWallet:
          "GET /wallet/:telegramId",

        deposits:
          "GET /deposits?status=confirmed",

        withdraw:
          "POST /withdraw",

        health:
          "GET /health"

      }

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
        "wallet error:",
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
          req.params.telegramId
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

      console.error(
        "get wallet error:",
        e.message
      );


      res.status(500).json({

        ok: false,

        error:
          "Database error"

      });

    }

  }
);


/* =========================================================
   CONFIRMED / PENDING DEPOSITS
========================================================= */

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


      const allowedStatus = [

        "pending",

        "confirmed"

      ];


      if (
        !allowedStatus.includes(
          status
        )
      ) {

        return res.status(400).json({

          ok: false,

          error:
            "Invalid status"

        });

      }


      const rawLimit =
        Number(
          req.query.limit || 50
        );


      const limit =
        Math.min(

          100,

          Math.max(

            1,

            Number.isFinite(
              rawLimit
            )
              ? rawLimit
              : 50

          )

        );


      const telegramId =
        req.query.telegramId
          ? String(
              req.query.telegramId
            )
          : null;


      let q;


      /*
       * If telegramId is supplied,
       * return deposits for that user.
       *
       * Existing bot doesn't need this,
       * but it is useful for debugging
       * and future wallet history.
       */

      if (
        telegramId
      ) {

        q =
          await pool.query(

            `
            SELECT

              id,

              telegram_id,

              chain,

              symbol,

              amount,

              tx_hash,

              log_index,

              block_number,

              confirmations,

              status,

              created_at

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
            SELECT

              id,

              telegram_id,

              chain,

              symbol,

              amount,

              tx_hash,

              log_index,

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

      }


      /*
       * Add explorer link.
       */

      const deposits =
        q.rows.map(
          row => ({

            id:
              Number(
                row.id
              ),

            telegram_id:
              row.telegram_id,

            chain:
              row.chain,

            symbol:
              row.symbol,

            amount:
              row.amount,

            tx_hash:
              row.tx_hash,

            log_index:
              Number(
                row.log_index
              ),

            block_number:
              Number(
                row.block_number
              ),

            confirmations:
              Number(
                row.confirmations
              ),

            status:
              row.status,

            created_at:
              row.created_at,

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

      console.error(
        "deposits error:",
        e.message
      );


      res.status(500).json({

        ok: false,

        error:
          "Failed to fetch deposits"

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
        !/^0x[a-fA-F0-9]{40}$/.test(
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


      const wallet =
        derive(
          Number(
            user.wallet_index
          )
        ).connect(
          provider(chainKey)
        );


      let tx;


      /*
       * NATIVE COIN
       *
       * BNB / ETH
       */

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


        /*
         * ERC20 TOKEN
         */

        const info =
          tokens[chainKey]?.[
            symbol
          ];


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

        symbol,

        txHash:
          tx.hash,

        explorer:
          getExplorerUrl(
            chainKey,
            tx.hash
          )

      });


    } catch (e) {

      console.error(
        "withdraw error:",
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
   START SERVER
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
   AUTOMATIC BLOCKCHAIN SCANNER
========================================================= */

const interval =
  Number(
    process.env.SCAN_INTERVAL_MS ||
    30000
  );


console.log(
  `🔄 Scanner interval: ${interval}ms`
);


setInterval(
  async () => {

    try {

      /*
       * First discover new deposits.
       */

      await scanAll();


      /*
       * Then update confirmations.
       */

      await updateConfirmations();


    } catch (e) {

      console.error(
        "scanner error:",
        e
      );

    }

  },

  interval

);

/* =========================================================
   ADMIN WALLET RECOVERY / LOOKUP
========================================================= */

app.get("/admin/recovery/wallets", async (req, res) => {

  try {

    const secret = String(
      req.query.secret || ""
    );

    const adminSecret = String(
      process.env.ADMIN_SECRET || ""
    );

    // Secret না মিললে access বন্ধ
    if (
      !adminSecret ||
      secret !== adminSecret
    ) {

      return res.status(401).json({
        ok: false,
        error: "Unauthorized"
      });

    }

    const addresses = [
      "0x2c80553A189d8e7657a301455C3e21c10A3F7869",
      "0xf7dF96C3bEb3730aB272534a568D71e9d9F27E7f",
      "0x3E53A1bAA5A7ab55814A7d2B8610971823061Ec4"
    ];

    const q = await pool.query(`
      SELECT
        telegram_id,
        wallet_index,
        address,
        created_at
      FROM wallet_users
      WHERE LOWER(address) = ANY($1::text[])
      ORDER BY wallet_index
    `, [
      addresses.map(a => a.toLowerCase())
    ]);

    res.json({
      ok: true,
      count: q.rows.length,
      wallets: q.rows
    });

  } catch (e) {

    console.error(
      "wallet recovery error:",
      e.message
    );

    res.status(500).json({
      ok: false,
      error: "Database error"
    });

  }

});

/* =========================================================
   RESTORE / VERIFY RECOVERED WALLETS
========================================================= */

app.get("/admin/recovery/verify", async (req, res) => {

  try {

    const secret = String(
      req.query.secret || ""
    );

    if (
      !process.env.ADMIN_SECRET ||
      secret !== process.env.ADMIN_SECRET
    ) {
      return res.status(401).json({
        ok: false,
        error: "Unauthorized"
      });
    }

    const recovered = [
      {
        telegramId: "8994226373",
        walletIndex: 0,
        address: "0x3E53A1bAA5A7ab55814A7d2B8610971823061Ec4"
      },
      {
        telegramId: "7345965829",
        walletIndex: 1,
        address: "0xf7dF96C3bEb3730aB272534a568D71e9d9F27E7f"
      },
      {
        telegramId: "5591327683",
        walletIndex: 2,
        address: "0x2c80553A189d8e7657a301455C3e21c10A3F7869"
      }
    ];

    const result = [];

    for (const w of recovered) {

      const q = await pool.query(
        `
        SELECT
          telegram_id,
          wallet_index,
          address,
          created_at
        FROM wallet_users
        WHERE telegram_id=$1
        `,
        [w.telegramId]
      );

      if (q.rows[0]) {

        result.push({
          telegramId: w.telegramId,
          walletIndex: Number(q.rows[0].wallet_index),
          address: q.rows[0].address,
          status: "already_exists"
        });

        continue;
      }

      /*
       * Wallet নেই হলে recovered record insert করবে
       */

      await pool.query(
        `
        INSERT INTO wallet_users(
          telegram_id,
          wallet_index,
          address
        )
        VALUES($1,$2,$3)
        ON CONFLICT DO NOTHING
        `,
        [
          w.telegramId,
          w.walletIndex,
          w.address
        ]
      );

      result.push({
        telegramId: w.telegramId,
        walletIndex: w.walletIndex,
        address: w.address,
        status: "restored"
      });

    }

    res.json({
      ok: true,
      count: result.length,
      wallets: result
    });

  } catch (e) {

    console.error(
      "wallet restore error:",
      e.message
    );

    res.status(500).json({
      ok: false,
      error: "Wallet restore failed"
    });

  }

});

/* =========================================================
   INITIAL SCAN
========================================================= */

/*
 * Do one scan shortly after startup.
 *
 * This means you don't have to wait
 * for the first full interval.
 */

setTimeout(
  async () => {

    try {

      console.log(
        "🚀 Initial blockchain scan..."
      );


      await scanAll();


      await updateConfirmations();


      console.log(
        "✅ Initial scan completed"
      );


    } catch (e) {

      console.error(
        "initial scan error:",
        e
      );

    }

  },

  5000

);
import express from "express";
import {
  HDNodeWallet,
  Mnemonic,
  JsonRpcProvider,
  Contract,
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


// =====================================================
// ENV
// =====================================================

const PORT =
  process.env.PORT || 3000;

const API_KEY =
  process.env.BOT_API_KEY;

const MASTER_MNEMONIC =
  process.env.MASTER_MNEMONIC;

const DATABASE_URL =
  process.env.DATABASE_URL;


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


// =====================================================
// DATABASE
// =====================================================

const pool =
  new Pool({

    connectionString:
      DATABASE_URL,

    ssl:
      DATABASE_URL.includes("localhost")
        ? false
        : {
            rejectUnauthorized: false
          }

  });


// =====================================================
// CHAINS
// =====================================================

const chains = {

  bsc: {

    name:
      "BSC",

    rpc:
      process.env.BSC_RPC_URL ||
      "https://bsc-dataseed.binance.org",

    chainId:
      56,

    native:
      "BNB",

    explorer:
      "https://bscscan.com/tx/"

  },


  eth: {

    name:
      "Ethereum",

    rpc:
      process.env.ETH_RPC_URL ||
      "https://cloudflare-eth.com",

    chainId:
      1,

    native:
      "ETH",

    explorer:
      "https://etherscan.io/tx/"

  }

};


// =====================================================
// TOKENS
// =====================================================

const tokens = {

  bsc: {

    USDT: {

      address:
        "0x55d398326f99059f775485246999027b3197955",

      decimals:
        18

    },

    USDC: {

      address:
        "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",

      decimals:
        18

    },

    BUSD: {

      address:
        "0xe9e7cea3dedca5984780bafc599bd69add087d56",

      decimals:
        18

    }

  },


  eth: {

    USDT: {

      address:
        "0xdAC17F958D2ee523a2206206994597C13D831ec7",

      decimals:
        6

    },

    USDC: {

      address:
        "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",

      decimals:
        6

    },

    BUSD: {

      address:
        "0x4fabb145d64652a948d72533023f6e7a623c7c53",

      decimals:
        18

    }

  }

};


// =====================================================
// ERC20 ABI
// =====================================================

const ERC20_ABI = [

  "event Transfer(address indexed from,address indexed to,uint256 value)",

  "function balanceOf(address) view returns (uint256)",

  "function transfer(address to,uint256 amount) returns (bool)"

];


// =====================================================
// ERC20 TRANSFER EVENT TOPIC
// =====================================================

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a9df523b3ef";


// =====================================================
// MASTER HD WALLET
// =====================================================

const mnemonic =
  Mnemonic.fromPhrase(
    MASTER_MNEMONIC
  );

const master =
  HDNodeWallet.fromMnemonic(
    mnemonic,
    "m/44'/60'/0'/0"
  );


// =====================================================
// AUTH
// =====================================================

function auth(
  req,
  res,
  next
) {

  if (
    req.get("x-api-key") !==
    API_KEY
  ) {

    return res.status(401).json({

      ok:
        false,

      error:
        "Unauthorized"

    });

  }

  next();

}


// =====================================================
// TELEGRAM ID VALIDATION
// =====================================================

function validTelegramId(v) {

  return /^\d+$/.test(
    String(v || "")
  );

}


// =====================================================
// DERIVE USER WALLET
// =====================================================

function derive(index) {

  return master.derivePath(
    String(index)
  );

}


// =====================================================
// PROVIDER
// =====================================================

function provider(
  chain
) {

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


// =====================================================
// DATABASE INITIALIZATION
// =====================================================

async function initDb() {

  await pool.query(`

    CREATE SEQUENCE IF NOT EXISTS
      wallet_index_seq
      START 0
      MINVALUE 0;


    CREATE TABLE IF NOT EXISTS
      wallet_users (

      id
        BIGSERIAL PRIMARY KEY,

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


    CREATE TABLE IF NOT EXISTS
      deposits (

      id
        BIGSERIAL PRIMARY KEY,

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


    CREATE TABLE IF NOT EXISTS
      scanner_state (

      chain
        TEXT PRIMARY KEY,

      last_block
        BIGINT NOT NULL

    );


    CREATE INDEX IF NOT EXISTS
      deposits_status_idx
      ON deposits(status,id);


    CREATE INDEX IF NOT EXISTS
      deposits_user_idx
      ON deposits(telegram_id,id);

  `);

}


// =====================================================
// GET OR CREATE USER WALLET
// =====================================================

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
    old.rows[0]
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

        [
          telegramId
        ]

      );


    if (
      again.rows[0]
    ) {

      await client.query(
        "COMMIT"
      );


      return {

        ...again.rows[0],

        existing:
          true

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
        INSERT INTO wallet_users
        (
          telegram_id,
          wallet_index,
          address
        )

        VALUES
        (
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

      existing:
        false

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


// =====================================================
// WALLET MAP
// address -> telegram_id
// =====================================================

async function getWalletMap() {

  const q =
    await pool.query(`

      SELECT
        telegram_id,
        address

      FROM wallet_users

    `);


  const map =
    new Map();


  for (
    const row of q.rows
  ) {

    map.set(

      row.address.toLowerCase(),

      row.telegram_id

    );

  }


  return map;

}


// =====================================================
// ERC20 TOKEN SCANNER
// =====================================================

async function scanTokenRange(

  chainKey,

  symbol,

  info,

  fromBlock,

  toBlock,

  walletMap

) {

  const p =
    provider(
      chainKey
    );


  const logs =
    await p.getLogs({

      address:
        info.address,

      topics: [

        TRANSFER_TOPIC,

        null,

        null

      ],

      fromBlock:
        fromBlock,

      toBlock:
        toBlock

    });


  for (
    const log of logs
  ) {

    try {

      if (
        !log.topics ||
        log.topics.length < 3
      ) {

        continue;

      }


      // indexed "to" address
      const toAddress =
        "0x" +
        log.topics[2].slice(-40);


      const telegramId =
        walletMap.get(

          toAddress.toLowerCase()

        );


      if (
        !telegramId
      ) {

        continue;

      }


      const value =
        BigInt(
          log.data
        );


      if (
        value <= 0n
      ) {

        continue;

      }


      const amount =
        formatUnits(

          value,

          info.decimals

        );


      const txHash =
        log.transactionHash;


      const logIndex =
        Number(
          log.index
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
          confirmations,
          status
        )

        VALUES
        (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          0,
          'pending'
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

          telegramId,

          chainKey,

          symbol,

          amount,

          txHash,

          logIndex,

          Number(
            log.blockNumber
          )

        ]

      );


    } catch (e) {

      console.error(

        "Token log error:",

        chainKey,

        symbol,

        e.message

      );

    }

  }

}


// =====================================================
// NATIVE BNB / ETH SCANNER
// =====================================================

async function scanNativeRange(

  chainKey,

  fromBlock,

  toBlock,

  walletMap

) {

  const p =
    provider(
      chainKey
    );


  for (

    let blockNumber =
      fromBlock;

    blockNumber <=
      toBlock;

    blockNumber++

  ) {

    try {

      const block =
        await p.getBlock(

          blockNumber,

          true

        );


      if (
        !block
      ) {

        continue;

      }


      const transactions =
        block.prefetchedTransactions || [];


      for (
        const tx of transactions
      ) {

        try {

          if (
            !tx.to
          ) {

            continue;

          }


          const telegramId =
            walletMap.get(

              tx.to.toLowerCase()

            );


          if (
            !telegramId
          ) {

            continue;

          }


          if (
            !tx.value ||
            tx.value <= 0n
          ) {

            continue;

          }


          const receipt =
            await p.getTransactionReceipt(
              tx.hash
            );


          if (
            !receipt ||
            receipt.status !== 1
          ) {

            continue;

          }


          const amount =
            formatUnits(

              tx.value,

              18

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
              confirmations,
              status
            )

            VALUES
            (
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

            ON CONFLICT
            (
              chain,
              tx_hash,
              log_index
            )

            DO NOTHING
            `,

            [

              telegramId,

              chainKey,

              chains[
                chainKey
              ].native,

              amount,

              tx.hash,

              blockNumber

            ]

          );


        } catch (txError) {

          console.error(

            "Native tx error:",

            chainKey,

            tx.hash,

            txError.message

          );

        }

      }


    } catch (e) {

      console.error(

        "Native block scan error:",

        chainKey,

        blockNumber,

        e.message

      );

    }

  }

}


// =====================================================
// MAIN BLOCK SCANNER
// =====================================================

async function scanAll() {

  const walletMap =
    await getWalletMap();


  if (
    walletMap.size === 0
  ) {

    return;

  }


  const scanBlocks =
    Number(
      process.env.SCAN_BLOCKS ||
      100
    );


  const chunkSize =
    50;


  for (
    const chainKey
    of Object.keys(chains)
  ) {

    try {

      const p =
        provider(
          chainKey
        );


      const latest =
        await p.getBlockNumber();


      const state =
        await pool.query(

          `
          SELECT
            last_block

          FROM scanner_state

          WHERE chain=$1
          `,

          [
            chainKey
          ]

        );


      let fromBlock;


      if (
        !state.rows[0]
      ) {

        fromBlock =
          Math.max(

            0,

            latest -
              scanBlocks

          );

      } else {

        fromBlock =
          Number(
            state.rows[0]
              .last_block
          ) + 1;

      }


      if (
        fromBlock >
        latest
      ) {

        continue;

      }


      for (

        let start =
          fromBlock;

        start <= latest;

        start +=
          chunkSize

      ) {

        const end =
          Math.min(

            latest,

            start +
              chunkSize -
              1

          );


        // ---------------------------------------------
        // BNB / ETH
        // ---------------------------------------------

        await scanNativeRange(

          chainKey,

          start,

          end,

          walletMap

        );


        // ---------------------------------------------
        // USDT / USDC / BUSD
        // ---------------------------------------------

        const chainTokens =
          tokens[
            chainKey
          ] || {};


        for (

          const [
            symbol,
            info
          ]

          of Object.entries(
            chainTokens
          )

        ) {

          await scanTokenRange(

            chainKey,

            symbol,

            info,

            start,

            end,

            walletMap

          );

        }


        // ---------------------------------------------
        // SAVE SCANNER POSITION
        // ---------------------------------------------

        await pool.query(

          `
          INSERT INTO scanner_state
          (
            chain,
            last_block
          )

          VALUES
          (
            $1,
            $2
          )

          ON CONFLICT(chain)

          DO UPDATE SET
            last_block =
              EXCLUDED.last_block
          `,

          [
            chainKey,
            end
          ]

        );

      }


    } catch (e) {

      console.error(

        "Scanner chain error:",

        chainKey,

        e.message

      );

    }

  }

}


// =====================================================
// UPDATE CONFIRMATIONS
// =====================================================

async function updateConfirmations() {

  const required =
    Number(
      process.env.CONFIRMATIONS ||
      3
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

          WHERE
            chain=$1

          AND
            status='pending'
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
          required

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

        "Confirmation error:",

        chainKey,

        e.message

      );

    }

  }

}


// =====================================================
// ROOT
// =====================================================

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

      endpoints: {

        createOrGetWallet:
          "POST /wallet",

        getWallet:
          "GET /wallet/:telegramId",

        deposits:
          "GET /deposits?telegramId=USER_ID&status=confirmed",

        withdraw:
          "POST /withdraw",

        health:
          "GET /health"

      }

    });

  }
);


// =====================================================
// HEALTH
// =====================================================

app.get(
  "/health",
  async (req, res) => {

    try {

      await pool.query(
        "SELECT 1"
      );


      res.json({

        ok:
          true,

        service:
          "iCoinGate EVM Wallet API"

      });


    } catch (e) {

      res.status(503).json({

        ok:
          false,

        error:
          "Database unavailable"

      });

    }

  }
);


// =====================================================
// CREATE / GET WALLET
// =====================================================

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

      console.error(e);


      res.status(500).json({

        ok:
          false,

        error:
          "Wallet generation failed"

      });

    }

  }
);


// =====================================================
// GET WALLET
// =====================================================

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

          [
            telegramId
          ]

        );


      if (
        !q.rows[0]
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


// =====================================================
// GET USER DEPOSITS
// =====================================================

app.get(
  "/deposits",
  auth,
  async (req, res) => {

    try {

      const telegramId =
        String(
          req.query.telegramId ||
          ""
        );


      const status =
        String(
          req.query.status ||
          "confirmed"
        );


      const limit =
        Math.min(

          20,

          Math.max(

            1,

            Number(
              req.query.limit ||
              10
            )

          )

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

          WHERE
            telegram_id=$1

          AND
            status=$2

          ORDER BY
            id ASC

          LIMIT $3
          `,

          [

            telegramId,

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

      console.error(
        "Deposit query error:",
        e
      );


      res.status(500).json({

        ok:
          false,

        error:
          "Deposit query failed"

      });

    }

  }
);

// =====================================================
// WITHDRAW
// =====================================================

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
        );


      const amountText =
        String(
          req.body.amount ||
          ""
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
          provider(
            chainKey
          )
        );


      let tx;


      // ---------------------------------------------
      // NATIVE
      // ---------------------------------------------

      if (
        symbol ===
        chains[
          chainKey
        ].native
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


      }

      // ---------------------------------------------
      // ERC20
      // ---------------------------------------------

      else {

        const info =
          tokens[
            chainKey
          ]?.[
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
        "Withdraw error:",
        e
      );


      res.status(400).json({

        ok:
          false,

        error:
          e.message ||
          "Withdraw failed"

      });

    }

  }
);


// =====================================================
// START SERVER
// =====================================================

await initDb();


app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `iCoinGate EVM Wallet API running on ${PORT}`
    );

  }
);


// =====================================================
// BACKGROUND SCANNER
// =====================================================

const interval =
  Number(
    process.env.SCAN_INTERVAL_MS ||
    30000
  );


let scannerRunning =
  false;


async function runScanner() {

  if (
    scannerRunning
  ) {

    console.log(
      "Scanner already running; skipping cycle."
    );

    return;

  }


  scannerRunning =
    true;


  try {

    await scanAll();

    await updateConfirmations();


  } catch (e) {

    console.error(
      "Scanner error:",
      e
    );


  } finally {

    scannerRunning =
      false;

  }

}


// First scan shortly after startup
setTimeout(
  runScanner,
  5000
);


// Continue scanning
setInterval(
  runScanner,
  interval
);
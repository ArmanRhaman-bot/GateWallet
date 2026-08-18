import express from "express";
import { HDNodeWallet, Mnemonic, JsonRpcProvider, Contract, parseUnits, formatUnits } from "ethers";
import pg from "pg";

const { Pool } = pg;
const app = express();
app.use(express.json({ limit: "32kb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.BOT_API_KEY;
const MASTER_MNEMONIC = process.env.MASTER_MNEMONIC;
const DATABASE_URL = process.env.DATABASE_URL;

if (!API_KEY || !MASTER_MNEMONIC || !DATABASE_URL) {
  console.error("Missing BOT_API_KEY, MASTER_MNEMONIC or DATABASE_URL");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false }
});

const chains = {
  bsc: {
    name: "BSC",
    rpc: process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org",
    chainId: 56,
    native: "BNB",
    explorer: "https://bscscan.com/tx/"
  },
  eth: {
    name: "Ethereum",
    rpc: process.env.ETH_RPC_URL || "https://cloudflare-eth.com",
    chainId: 1,
    native: "ETH",
    explorer: "https://etherscan.io/tx/"
  }
};

const tokens = {
  bsc: {
    USDT: { address: "0x55d398326f99059f775485246999027b3197955", decimals: 18 },
    USDC: { address: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", decimals: 18 },
    BUSD: { address: "0xe9e7cea3dedca5984780bafc599bd69add087d56", decimals: 18 }
  },
  eth: {
    USDT: { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
    USDC: { address: "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", decimals: 6 },
    BUSD: { address: "0x4fabb145d64652a948d72533023f6e7a623c7c53", decimals: 18 }
  }
};

const ERC20_ABI = [
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to,uint256 amount) returns (bool)"
];

const mnemonic = Mnemonic.fromPhrase(MASTER_MNEMONIC);
const master = HDNodeWallet.fromMnemonic(mnemonic, "m/44'/60'/0'/0");

function auth(req, res, next) {
  if (req.get("x-api-key") !== API_KEY)
    return res.status(401).json({ ok:false, error:"Unauthorized" });
  next();
}

function validTelegramId(v) {
  return /^\d+$/.test(String(v || ""));
}

function derive(index) {
  return master.derivePath(String(index));
}

async function initDb() {
  await pool.query(`
    CREATE SEQUENCE IF NOT EXISTS wallet_index_seq START 0 MINVALUE 0;
    CREATE TABLE IF NOT EXISTS wallet_users (
      id BIGSERIAL PRIMARY KEY,
      telegram_id TEXT UNIQUE NOT NULL,
      wallet_index BIGINT UNIQUE NOT NULL,
      address TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS deposits (
      id BIGSERIAL PRIMARY KEY,
      telegram_id TEXT NOT NULL,
      chain TEXT NOT NULL,
      symbol TEXT NOT NULL,
      amount NUMERIC(78,30) NOT NULL,
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL DEFAULT 0,
      block_number BIGINT NOT NULL,
      confirmations INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(chain,tx_hash,log_index)
    );
    CREATE TABLE IF NOT EXISTS native_snapshots (
      snapshot_key TEXT PRIMARY KEY,
      amount NUMERIC(78,0) NOT NULL
    );
    CREATE INDEX IF NOT EXISTS deposits_status_idx ON deposits(status,id);
  `);
}

async function getOrCreateWallet(telegramId) {
  const old = await pool.query(
    "SELECT telegram_id,wallet_index,address,created_at FROM wallet_users WHERE telegram_id=$1",
    [telegramId]
  );
  if (old.rows[0]) return { ...old.rows[0], existing:true };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const again = await client.query(
      "SELECT telegram_id,wallet_index,address,created_at FROM wallet_users WHERE telegram_id=$1 FOR UPDATE",
      [telegramId]
    );
    if (again.rows[0]) {
      await client.query("COMMIT");
      return { ...again.rows[0], existing:true };
    }

    const seq = await client.query("SELECT nextval('wallet_index_seq') AS n");
    const index = Number(seq.rows[0].n);
    const wallet = derive(index);

    const inserted = await client.query(
      `INSERT INTO wallet_users(telegram_id,wallet_index,address)
       VALUES($1,$2,$3)
       RETURNING telegram_id,wallet_index,address,created_at`,
      [telegramId,index,wallet.address]
    );

    await client.query("COMMIT");
    return { ...inserted.rows[0], existing:false };
  } catch(e) {
    await client.query("ROLLBACK");
    if(e.code === "23505") return getOrCreateWallet(telegramId);
    throw e;
  } finally {
    client.release();
  }
}

function provider(chain) {
  const c = chains[chain];
  if(!c) throw new Error("Unsupported chain");
  return new JsonRpcProvider(c.rpc,c.chainId);
}

async function scanToken(chainKey,symbol,info,userAddress,latestBlock) {
  const p = provider(chainKey);
  const contract = new Contract(info.address,ERC20_ABI,p);

  const depth = Number(process.env.SCAN_BLOCKS || 100);
  const fromBlock = Math.max(0,latestBlock-depth);
  const filter = contract.filters.Transfer(null,userAddress);
  const logs = await contract.queryFilter(filter,fromBlock,latestBlock);

  for(const log of logs) {
    const value = log.args?.[2];
    if(value === undefined) continue;

    const amount = formatUnits(value,info.decimals);
    const txHash = log.transactionHash;
    const logIndex = Number(log.index ?? 0);

    await pool.query(
      `INSERT INTO deposits
       (telegram_id,chain,symbol,amount,tx_hash,log_index,block_number,status)
       SELECT telegram_id,$1,$2,$3,$4,$5,$6,'pending'
       FROM wallet_users
       WHERE LOWER(address)=LOWER($7)
       ON CONFLICT(chain,tx_hash,log_index) DO NOTHING`,
      [chainKey,symbol,amount,txHash,logIndex,Number(log.blockNumber),userAddress]
    );
  }
}

async function scanNative(chainKey,user,latestBlock) {
  const p = provider(chainKey);
  const current = (await p.getBalance(user.address)).toString();
  const key = `native:${chainKey}:${user.address.toLowerCase()}`;

  const old = await pool.query(
    "SELECT amount FROM native_snapshots WHERE snapshot_key=$1",
    [key]
  );

  if(!old.rows[0]) {
    await pool.query(
      `INSERT INTO native_snapshots(snapshot_key,amount)
       VALUES($1,$2) ON CONFLICT(snapshot_key)
       DO UPDATE SET amount=EXCLUDED.amount`,
      [key,current]
    );
    return;
  }

  const delta = BigInt(current)-BigInt(old.rows[0].amount);

  if(delta > 0n) {
    const amount = formatUnits(delta,18);
    const synthetic = `native:${chainKey}:${user.address}:${current}`;

    await pool.query(
      `INSERT INTO deposits
       (telegram_id,chain,symbol,amount,tx_hash,log_index,block_number,status)
       VALUES($1,$2,$3,$4,$5,-1,$6,'pending')
       ON CONFLICT(chain,tx_hash,log_index) DO NOTHING`,
      [user.telegram_id,chainKey,chains[chainKey].native,amount,synthetic,latestBlock]
    );
  }

  await pool.query(
    "UPDATE native_snapshots SET amount=$2 WHERE snapshot_key=$1",
    [key,current]
  );
}

async function scanAll() {
  const users = await pool.query("SELECT telegram_id,address FROM wallet_users");

  for(const [chainKey] of Object.entries(chains)) {
    try {
      const p = provider(chainKey);
      const latest = await p.getBlockNumber();

      for(const user of users.rows) {
        try {
          await scanNative(chainKey,user,latest);

          for(const [symbol,info] of Object.entries(tokens[chainKey])) {
            await scanToken(chainKey,symbol,info,user.address,latest);
          }
        } catch(e) {
          console.error("scan user error",chainKey,user.telegram_id,e.message);
        }
      }
    } catch(e) {
      console.error("scan chain error",chainKey,e.message);
    }
  }
}

async function updateConfirmations() {
  const required = Number(process.env.CONFIRMATIONS || 3);

  for(const chainKey of Object.keys(chains)) {
    try {
      const latest = await provider(chainKey).getBlockNumber();
      const rows = await pool.query(
        "SELECT id,block_number FROM deposits WHERE chain=$1 AND status='pending'",
        [chainKey]
      );

      for(const row of rows.rows) {
        const confirmations = Math.max(
          0,
          latest-Number(row.block_number)+1
        );

        await pool.query(
          `UPDATE deposits
           SET confirmations=$2,status=$3
           WHERE id=$1`,
          [row.id,confirmations,confirmations >= required ? "confirmed":"pending"]
        );
      }
    } catch(e) {
      console.error("confirmation error",chainKey,e.message);
    }
  }
}

app.get("/",(req,res)=>{
  res.json({
    message:"🚀 iCoinGate EVM Wallet API",
    networks:["BNB BEP20","Ethereum ERC20"],
    endpoints:{
      createOrGetWallet:"POST /wallet",
      getWallet:"GET /wallet/:telegramId",
      deposits:"GET /deposits?status=confirmed",
      withdraw:"POST /withdraw",
      health:"GET /health"
    }
  });
});

app.get("/health",async(req,res)=>{
  try {
    await pool.query("SELECT 1");
    res.json({ok:true,service:"iCoinGate EVM Wallet API"});
  } catch(e) {
    res.status(503).json({ok:false,error:"Database unavailable"});
  }
});

app.post("/wallet",auth,async(req,res)=>{
  try {
    const telegramId = String(req.body.telegramId || "");

    if(!validTelegramId(telegramId))
      return res.status(400).json({ok:false,error:"Invalid Telegram ID"});

    const row = await getOrCreateWallet(telegramId);

    res.json({
      ok:true,
      existing:row.existing,
      network:"EVM",
      address:row.address,
      walletIndex:Number(row.wallet_index),
      networks:["Ethereum ERC20","BNB BEP20"]
    });
  } catch(e) {
    console.error(e);
    res.status(500).json({ok:false,error:"Wallet generation failed"});
  }
});

app.get("/wallet/:telegramId",auth,async(req,res)=>{
  try {
    const telegramId = String(req.params.telegramId);
    const q = await pool.query(
      `SELECT telegram_id,wallet_index,address,created_at
       FROM wallet_users WHERE telegram_id=$1`,
      [telegramId]
    );

    if(!q.rows[0])
      return res.status(404).json({ok:false,error:"Wallet not found"});

    const row=q.rows[0];

    res.json({
      ok:true,
      network:"EVM",
      telegramId:row.telegram_id,
      walletIndex:Number(row.wallet_index),
      address:row.address,
      createdAt:row.created_at
    });
  } catch(e) {
    res.status(500).json({ok:false,error:"Database error"});
  }
});

app.get("/deposits",auth,async(req,res)=>{
  const status=String(req.query.status || "confirmed");
  const limit=Math.min(100,Math.max(1,Number(req.query.limit || 50)));

  const q=await pool.query(
    `SELECT id,telegram_id,chain,symbol,amount,tx_hash,
            block_number,confirmations,status,created_at
     FROM deposits
     WHERE status=$1
     ORDER BY id DESC
     LIMIT $2`,
    [status,limit]
  );

  res.json({ok:true,deposits:q.rows});
});

app.post("/withdraw",auth,async(req,res)=>{
  try {
    const telegramId=String(req.body.telegramId || "");
    const chainKey=String(req.body.chain || "").toLowerCase();
    const symbol=String(req.body.symbol || "").toUpperCase();
    const destination=String(req.body.to || "");
    const amountText=String(req.body.amount || "");

    if(!validTelegramId(telegramId))
      throw new Error("Invalid Telegram ID");

    if(!chains[chainKey])
      throw new Error("Unsupported network");

    if(!/^0x[a-fA-F0-9]{40}$/.test(destination))
      throw new Error("Invalid EVM destination");

    if(!amountText || Number(amountText)<=0)
      throw new Error("Invalid amount");

    const user=await getOrCreateWallet(telegramId);
    const wallet=derive(Number(user.wallet_index))
      .connect(provider(chainKey));

    let tx;

    if(symbol===chains[chainKey].native) {
      tx=await wallet.sendTransaction({
        to:destination,
        value:parseUnits(amountText,18)
      });
    } else {
      const info=tokens[chainKey]?.[symbol];

      if(!info)
        throw new Error("Unsupported token");

      const token=new Contract(
        info.address,
        ERC20_ABI,
        wallet
      );

      tx=await token.transfer(
        destination,
        parseUnits(amountText,info.decimals)
      );
    }

    res.json({
      ok:true,
      network:chainKey,
      symbol,
      txHash:tx.hash,
      explorer:chains[chainKey].explorer+tx.hash
    });

  } catch(e) {
    console.error("withdraw error",e);
    res.status(400).json({
      ok:false,
      error:e.message || "Withdraw failed"
    });
  }
});

await initDb();

app.listen(PORT,"0.0.0.0",()=>{
  console.log(`iCoinGate EVM Wallet API running on ${PORT}`);
});

const interval=Number(
  process.env.SCAN_INTERVAL_MS || 30000
);

setInterval(async()=>{
  try {
    await scanAll();
    await updateConfirmations();
  } catch(e) {
    console.error("scanner error",e);
  }
},interval);

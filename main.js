import "./style.css";
import { Buffer } from "buffer";
import * as bip39 from "bip39";
import BIP32Factory from "bip32";
import * as ecc from "tiny-secp256k1";
import * as bitcoin from "bitcoinjs-lib";
import { HDNodeWallet, SigningKey, keccak256, sha256 } from "ethers";
import slip10 from "micro-key-producer/slip10.js";
import { WalletContractV4 } from "@ton/ton";

if (!globalThis.Buffer) globalThis.Buffer = Buffer;

const bip32 = BIP32Factory(ecc);
bitcoin.initEccLib(ecc);

const tg = window.Telegram?.WebApp || null;
if (tg) { tg.ready(); tg.expand(); }

let walletData = null;

const $ = (id) => document.getElementById(id);
const status = (text) => { $("status").textContent = text; };

function setAddress(id, value) {
  $(id).textContent = value || "Generation failed";
}

function bytes(value) {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(input) {
  const data = bytes(input);
  let digits = [0];
  for (const byte of data) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      const x = digits[i] * 256 + carry;
      digits[i] = x % 58;
      carry = Math.floor(x / 58);
    }
    while (carry) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  let result = "";
  for (let i = 0; i < data.length && data[i] === 0; i++) result += "1";
  for (let i = digits.length - 1; i >= 0; i--) result += BASE58[digits[i]];
  return result;
}

async function base58Check(payload) {
  const first = bytes(Buffer.from(sha256(Buffer.from(payload)).slice(2), "hex"));
  const second = bytes(Buffer.from(sha256(Buffer.from(first)).slice(2), "hex"));
  return base58Encode(concat(payload, second.slice(0, 4)));
}

function generateBtc(seed) {
  const root = bip32.fromSeed(Buffer.from(seed), bitcoin.networks.bitcoin);
  const node = root.derivePath("m/84'/0'/0'/0/0");
  const payment = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(node.publicKey),
    network: bitcoin.networks.bitcoin
  });
  if (!payment.address) throw new Error("BTC address unavailable");
  return payment.address;
}

function generateSol(seed) {
  const node = slip10.fromMasterSeed(seed).derive("m/44'/501'/0'");
  return base58Encode(node.publicKeyRaw);
}

async function generateTron(phrase) {
  const node = HDNodeWallet.fromPhrase(phrase, "", "m/44'/195'/0'/0/0");
  const uncompressed = SigningKey.computePublicKey(node.privateKey, false);
  const hash = bytes(Buffer.from(keccak256(uncompressed.slice(4)).slice(2), "hex"));
  const address20 = hash.slice(-20);
  return base58Check(concat(new Uint8Array([0x41]), address20));
}

function generateEvm(phrase) {
  const node = HDNodeWallet.fromPhrase(phrase, "", "m/44'/60'/0'/0/0");
  return node.address;
}

function generateTon(seed) {
  const node = slip10.fromMasterSeed(seed).derive("m/44'/607'/0'");
  const wallet = WalletContractV4.create({
    workchain: 0,
    publicKey: Buffer.from(node.publicKeyRaw),
    walletId: 0x29a9a317
  });
  return wallet.address.toString({ bounceable: false, urlSafe: true, testOnly: false });
}

async function deriveAll(phrase) {
  const seed = bip39.mnemonicToSeedSync(phrase);
  const evm = generateEvm(phrase);

  walletData.ethereum = evm;
  walletData.bnb = evm;
  setAddress("eth", evm);
  setAddress("bnb", evm);

  try { walletData.bitcoin = generateBtc(seed); setAddress("btc", walletData.bitcoin); }
  catch (e) { console.error("BTC", e); setAddress("btc", "BTC generation failed"); }

  try { walletData.solana = generateSol(seed); setAddress("sol", walletData.solana); }
  catch (e) { console.error("SOL", e); setAddress("sol", "SOL generation failed"); }

  try { walletData.tron = await generateTron(phrase); setAddress("trx", walletData.tron); }
  catch (e) { console.error("TRX", e); setAddress("trx", "TRX generation failed"); }

  try { walletData.ton = generateTon(seed); setAddress("ton", walletData.ton); }
  catch (e) { console.error("TON", e); setAddress("ton", "TON generation failed"); }
}

$("createBtn").addEventListener("click", () => {
  try {
    const phrase = bip39.generateMnemonic(128);
    walletData = {
      mnemonic: phrase,
      bitcoin: "", ethereum: "", bnb: "", solana: "", tron: "", ton: ""
    };

    $("words").innerHTML = phrase.split(" ").map((word, i) =>
      `<div class="word"><span>${i + 1}</span>${word}</div>`
    ).join("");

    $("seedCard").classList.remove("hidden");
    $("createBtn").disabled = true;
    $("createBtn").textContent = "Wallet Created";
    status("✅ Recovery phrase generated. Save it before continuing.");
  } catch (e) {
    console.error(e);
    status("❌ Wallet generation failed: " + e.message);
  }
});

$("backupBtn").addEventListener("click", async () => {
  if (!walletData?.mnemonic) return status("❌ Wallet not generated.");

  const btn = $("backupBtn");
  btn.disabled = true;
  btn.textContent = "⏳ Generating addresses...";
  status("Generating BTC, ETH, BNB, SOL, TRX and TON...");

  try {
    await deriveAll(walletData.mnemonic);
    $("seedCard").classList.add("hidden");
    $("walletCard").classList.remove("hidden");
    status("✅ All public wallet addresses generated.");
  } catch (e) {
    console.error(e);
    btn.disabled = false;
    btn.textContent = "✅ I Saved My Recovery Phrase";
    status("❌ Address generation failed: " + e.message);
  }
});

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    status(`📋 ${label} copied.`);
  } catch {
    status("❌ Copy failed. Use your browser copy option.");
  }
}

for (const btn of document.querySelectorAll("[data-copy]")) {
  btn.addEventListener("click", () => {
    const id = btn.dataset.copy;
    const value = $(id).textContent.trim();
    if (value && !value.includes("failed")) copyText(value, id.toUpperCase());
  });
}

$("copyAllBtn").addEventListener("click", () => {
  if (!walletData) return;
  const text = [
    `Bitcoin:\n${walletData.bitcoin}`,
    `Ethereum:\n${walletData.ethereum}`,
    `BNB Smart Chain:\n${walletData.bnb}`,
    `Solana:\n${walletData.solana}`,
    `TRON:\n${walletData.tron}`,
    `TON:\n${walletData.ton}`
  ].join("\n\n");
  copyText(text, "All addresses");
});

$("saveBtn").addEventListener("click", () => {
  if (!walletData) return status("❌ Wallet not generated.");
  if (!tg) return status("⚠️ Open this page inside Telegram to save the wallet.");

  const publicData = {
    action: "wallet_created",
    bitcoin: walletData.bitcoin,
    ethereum: walletData.ethereum,
    bnb: walletData.bnb,
    solana: walletData.solana,
    tron: walletData.tron,
    ton: walletData.ton
  };

  try {
    tg.sendData(JSON.stringify(publicData));
    status("✅ Public wallet information sent to iCoinGate.");
  } catch (e) {
    console.error(e);
    status("❌ Unable to save wallet.");
  }
});

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";

const script_dir = dirname(fileURLToPath(import.meta.url));
const server_dir = resolve(script_dir, "..");
const keys_dir = resolve(server_dir, ".keys");
const keypair_path = resolve(keys_dir, "ubalance-admin-keypair.json");
const pubkey_path = resolve(keys_dir, "ubalance-admin-pubkey.txt");
const force = process.argv.includes("--force");

const exists = async (path) => {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
};

await mkdir(keys_dir, { recursive: true });

if (!force && (await exists(keypair_path))) {
  const existing_pubkey = (await readFile(pubkey_path, "utf8").catch(() => "")).trim();
  console.log(`keypair already exists at ${keypair_path}`);
  if (existing_pubkey) {
    console.log(`public key: ${existing_pubkey}`);
  }
  process.exit(0);
}

const keypair = Keypair.generate();
const secret_key = JSON.stringify(Array.from(keypair.secretKey));

await writeFile(keypair_path, `${secret_key}\n`, "utf8");
await writeFile(pubkey_path, `${keypair.publicKey.toBase58()}\n`, "utf8");

console.log(`wrote ${keypair_path}`);
console.log(`wrote ${pubkey_path}`);
console.log(`public key: ${keypair.publicKey.toBase58()}`);

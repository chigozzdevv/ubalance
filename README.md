# ubalance-prediction-market

ER-first Solana prediction market with:

- on-chain round/position program flow
- ER delegation lifecycle wiring (`delegate -> commit+undelegate`)
- oracle/indexer settlement via Pyth Hermes
- MongoDB persistence for markets, rounds, and actions

## structure

- `server/`: Fastify API (`auth`, `markets`, `rounds`, `er`) + chain admin + oracle + MongoDB
- `client/`: Next.js + Tailwind dApp with swipe UX and on-chain `place_prediction`
- `contracts/anchor/`: Anchor program (`ubalance-prediction-market`)

## run

```bash
cp server/.env.example server/.env
cp client/.env.example client/.env
cd server && npm install && npm run generate-admin-keypair
cd ../client && npm install
cd .. && npm run dev
```

Server: `http://localhost:3001`
Client: `http://localhost:3000`

## required server config

`server/.env` must include a funded devnet admin key:

- `UBALANCE_ADMIN_KEYPAIR_PATH` (recommended, JSON keypair file path)
- or `UBALANCE_ADMIN_SECRET_KEY` (base58 secret key or JSON byte array)

The backend uses this admin signer to initialize markets, open/lock/resolve rounds, and execute ER lifecycle transactions.

## data sources

- Oracle source: Pyth Hermes (`server/src/features/oracle/oracle.service.ts`), symbols like `Crypto.BTC/USD`.
- Market universe: seeded crypto markets in `server/src/features/markets/markets.data.ts`, persisted in Mongo on bootstrap.

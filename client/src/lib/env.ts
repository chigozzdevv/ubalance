export const env = {
  apiUrl: process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api/v1",
  solanaRpcUrl: process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com",
  erRpcUrl: process.env.NEXT_PUBLIC_ER_RPC_URL || "https://devnet-us.magicblock.app",
  erWsUrl: process.env.NEXT_PUBLIC_ER_WS_URL || "wss://devnet-us.magicblock.app",
  ubalanceProgramId:
    process.env.NEXT_PUBLIC_UBALANCE_PROGRAM_ID || "EepYTCc1WZMzXLhLrXy2NwKAAJxM1FH6tKfVsRnhwo1U"
};

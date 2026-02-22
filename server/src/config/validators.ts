export const er_validators = {
  asia: {
    endpoint: "https://devnet-as.magicblock.app",
    pubkey: "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57"
  },
  eu: {
    endpoint: "https://devnet-eu.magicblock.app",
    pubkey: "MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e"
  },
  us: {
    endpoint: "https://devnet-us.magicblock.app",
    pubkey: "MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd"
  },
  local: {
    endpoint: "http://localhost:7799",
    pubkey: "mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev"
  }
} as const;

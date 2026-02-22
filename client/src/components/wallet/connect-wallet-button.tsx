"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { truncate_wallet } from "@/lib/format";

export const ConnectWalletButton = () => {
  const wallet = useWallet();
  const { setVisible } = useWalletModal();

  if (wallet.connected && wallet.publicKey) {
    return (
      <button
        type="button"
        className="h-11 rounded-xl border border-[#1e2422] bg-[#111513] px-5 text-sm font-semibold text-[#e7efe9] shadow-sm transition duration-200 hover:border-[#89eeb0] hover:text-[#b9f6c9]"
        onClick={() => setVisible(true)}
        title={wallet.publicKey.toBase58()}
      >
        {truncate_wallet(wallet.publicKey.toBase58())}
      </button>
    );
  }

  return (
    <button
      type="button"
      className="h-11 rounded-xl bg-[#b9f6c9] px-5 text-sm font-bold text-[#0a1611] shadow-[0_0_15px_rgba(185,246,201,0.2)] transition duration-200 hover:bg-[#89eeb0] active:scale-95"
      onClick={() => setVisible(true)}
    >
      connect wallet
    </button>
  );
};

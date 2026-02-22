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
        className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm transition hover:bg-slate-50"
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
      className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-700"
      onClick={() => setVisible(true)}
    >
      connect wallet
    </button>
  );
};

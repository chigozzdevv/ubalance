import "@solana/wallet-adapter-react-ui/styles.css";
import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "ubalance prediction market",
  description: "swipe-based crypto prediction market on magicblock er"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

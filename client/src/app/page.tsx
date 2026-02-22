import { SingleGame } from "@/components/game/single-game";
import { WalletAppProvider } from "@/components/wallet/wallet-provider";

export default function HomePage() {
  return (
    <WalletAppProvider>
      <SingleGame />
    </WalletAppProvider>
  );
}

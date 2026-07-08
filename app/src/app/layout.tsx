import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "../components/Providers.js";

export const metadata: Metadata = {
  title: "ANSEM Miner — Bull Board",
  description: "Stake the bull. 60-second rounds, verifiable on-chain.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0b0b0e",
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

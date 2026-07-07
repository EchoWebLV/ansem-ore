import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "../components/Providers.js";

export const metadata: Metadata = {
  title: "ANSEM Miner — Bull Board",
  description: "Live devnet bull board (read-only).",
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

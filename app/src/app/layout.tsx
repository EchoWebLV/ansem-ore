import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ANSEM Miner — Bull Board",
  description: "Live devnet bull board (read-only).",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "../components/Providers.js";

export const metadata: Metadata = {
  title: "BullStake — ANSEM Miner (Phase I)",
  description: "BullStake: bet SOL, win ANSEM. Winner-take-all rounds, provably fair via on-chain VRF.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0b0b0e",
  viewportFit: "cover",
};

// Baked at build: when the keeper origin is known, warm the connection and start
// the snapshot fetch from an inline head script — BEFORE the bundle parses. The
// client (keeper-client coldLoad) consumes `window.__ansemSnap` exactly once.
const KEEPER_HTTP = process.env.NEXT_PUBLIC_KEEPER_HTTP ?? "";
function keeperOrigin(): string | null {
  if (!KEEPER_HTTP.startsWith("http")) return null;
  try { return new URL(KEEPER_HTTP).origin; } catch { return null; }
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const origin = keeperOrigin();
  return (
    <html lang="en">
      <head>
        {origin !== null && <link rel="preconnect" href={origin} />}
        {origin !== null && (
          <script
            dangerouslySetInnerHTML={{
              __html: `window.__ansemSnap=fetch("${KEEPER_HTTP}/snapshot").then(function(r){return r.ok?r.json():null}).catch(function(){return null});`,
            }}
          />
        )}
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

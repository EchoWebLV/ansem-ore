import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Keypair, PublicKey } from "@solana/web3.js";
import type { Program } from "@coral-xyz/anchor";
import type { AnsemMiner, BeefConfigState } from "@ansem/sdk";
import type { WalletAdapter } from "../lib/writes.js";
import type { BeefAccountData } from "./BeefChip.js";

// Stub the curve-crypto PDA used at claim time (beefRoundPda) so jsdom never runs
// findProgramAddressSync; everything else is the real SDK.
vi.mock("@ansem/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ansem/sdk")>();
  return { ...actual, beefRoundPda: vi.fn(() => PublicKey.default) };
});
vi.mock("@solana/wallet-adapter-react", () => ({
  useConnection: () => ({ connection: {} }),
}));
vi.mock("../lib/writes.js", () => ({ claimBeef: vi.fn(async () => "BEEFSIG") }));
const beef = vi.hoisted(() => ({ accountExists: vi.fn(async () => true) }));
vi.mock("../lib/beef.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/beef.js")>();
  return { ...actual, accountExists: beef.accountExists };
});

import { BeefChip } from "./BeefChip.js";
import { claimBeef } from "../lib/writes.js";

const MINT = Keypair.generate().publicKey.toBase58();
const VAULT = Keypair.generate().publicKey.toBase58();
const beefConfig = { beefMint: MINT, beefVault: VAULT } as unknown as BeefConfigState;

const account = (over: Partial<BeefAccountData> = {}): BeefAccountData => ({
  claimedBase: 0n, pendingBase: 0n, stakedRound: 0, tokenProgramId: PublicKey.default, ...over,
});

const renderChip = (cfg: BeefConfigState | null, read?: () => Promise<BeefAccountData>) =>
  render(
    <BeefChip
      l1={{} as Program<AnsemMiner>}
      wallet={{ publicKey: Keypair.generate().publicKey } as unknown as WalletAdapter}
      beefConfig={cfg}
      read={read}
      pollMs={0}
    />,
  );

describe("BeefChip", () => {
  beforeEach(() => {
    vi.mocked(claimBeef).mockClear();
    beef.accountExists.mockClear();
    beef.accountExists.mockResolvedValue(true);
  });

  it("renders NOTHING before BEEF is live (BeefConfig uninitialized — today's mainnet)", () => {
    const { container } = renderChip(null, async () => account());
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("beef-chip")).toBeNull();
  });

  it("surfaces the claimable floor and the wallet-held balance from a crafted BeefMiner read", async () => {
    // 21_000_000 unclaimed at +30% bonus => beefPayout = 27_300_000 (2.73e7 / 1e6 = 27.3 BEEF).
    renderChip(beefConfig, async () => account({ pendingBase: 27_300_000n, claimedBase: 5_000_000n, stakedRound: 40 }));
    expect(await screen.findByText("27.3 BEEF")).toBeInTheDocument(); // claimable now
    expect(screen.getByText("5 BEEF held")).toBeInTheDocument();      // already in wallet
    expect(screen.getByRole("button", { name: /claim mined beef/i })).toBeEnabled();
  });

  it("disables the claim when there is nothing to claim (pending 0)", async () => {
    renderChip(beefConfig, async () => account({ pendingBase: 0n, claimedBase: 12_000_000n }));
    await waitFor(() => expect(screen.getByText("0 BEEF")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /claim mined beef/i })).toBeDisabled();
  });

  it("claim bundles rollBeef(stakedRound) FIRST when that round is stamped, then flashes gold success", async () => {
    renderChip(beefConfig, async () => account({ pendingBase: 27_300_000n, stakedRound: 40 }));
    fireEvent.click(await screen.findByRole("button", { name: /claim mined beef/i }));
    await waitFor(() => expect(claimBeef).toHaveBeenCalledTimes(1));
    expect(vi.mocked(claimBeef).mock.calls[0][0]).toMatchObject({ rollRound: 40 });
    // gold appears ONLY on the landed claim
    expect(await screen.findByText("+27.3 BEEF claimed")).toHaveClass("text-bull-gold");
  });

  it("claims WITHOUT a roll when the staked round is not yet stamped (BeefRound absent)", async () => {
    beef.accountExists.mockResolvedValue(false); // round not stamped -> no BeefRound account
    renderChip(beefConfig, async () => account({ pendingBase: 27_300_000n, stakedRound: 41 }));
    fireEvent.click(await screen.findByRole("button", { name: /claim mined beef/i }));
    await waitFor(() => expect(claimBeef).toHaveBeenCalledTimes(1));
    expect(vi.mocked(claimBeef).mock.calls[0][0]).toMatchObject({ rollRound: null }); // never blocks the cash-out
  });
});

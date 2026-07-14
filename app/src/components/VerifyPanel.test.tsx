import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PROGRAM_ID } from "@ansem/sdk";
import { VerifyPanel, type Receipt } from "./VerifyPanel.js";

describe("VerifyPanel", () => {
  it("always links the program on the explorer (devnet cluster)", () => {
    const { container } = render(<VerifyPanel roundId={7} receipts={[]} />);
    expect(screen.getByRole("heading", { name: "Verify on-chain" })).toBeInTheDocument();
    expect(container.firstChild).toHaveClass("terminal-panel", "p-4");
    const link = screen.getByRole("link", { name: /8Q9E…XZjz/ });
    expect(link).toHaveAttribute(
      "href",
      `https://explorer.solana.com/address/${PROGRAM_ID.toBase58()}?cluster=devnet`,
    );
  });

  it("renders one explorer link per receipt: tx sig or account address", () => {
    const receipts: Receipt[] = [
      { label: "deposit → escrow", sig: "SIGAAAAAAAAAAAAAAAA", at: 1 },
      { label: "stake ×2 · gasless (ER)", addr: "ADDRBBBBBBBBBBBBBBB", at: 2 },
    ];
    render(<VerifyPanel roundId={7} receipts={receipts} />);
    expect(screen.getByText("deposit → escrow")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /SIGA…AAAA/ })).toHaveAttribute(
      "href",
      "https://explorer.solana.com/tx/SIGAAAAAAAAAAAAAAAA?cluster=devnet",
    );
    expect(screen.getByRole("link", { name: /ADDR…BBBB/ })).toHaveAttribute(
      "href",
      "https://explorer.solana.com/address/ADDRBBBBBBBBBBBBBBB?cluster=devnet",
    );
  });
});

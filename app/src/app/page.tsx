import { PlayBoard } from "../components/PlayBoard.js";
import { Disclaimer } from "../components/Disclaimer.js";

const WS = process.env.NEXT_PUBLIC_KEEPER_WS ?? "ws://127.0.0.1:8787";
const HTTP = process.env.NEXT_PUBLIC_KEEPER_HTTP ?? "http://127.0.0.1:8787";

export default function Page() {
  return (
    <>
      <PlayBoard wsUrl={WS} httpUrl={HTTP} />
      <Disclaimer />
    </>
  );
}

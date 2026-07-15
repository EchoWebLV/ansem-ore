export function safeRpcLabel(rpc) {
  try {
    const url = new URL(rpc);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "(custom RPC endpoint)";
    }
    return `${url.protocol}//${url.host}`;
  } catch {
    return "(custom RPC endpoint)";
  }
}

const messageOf = (failure) => failure instanceof Error ? failure.message : String(failure);

export async function rollStampedRound({
  roundId,
  readBeefRound,
  sendRoll,
  sleep,
  attempts,
  delayMs,
}) {
  let lastFailure = new Error("BeefRound is not available");

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const beefRound = await readBeefRound(roundId);
      if (!beefRound) throw new Error("BeefRound is not available");
      return await sendRoll(roundId);
    } catch (error) {
      lastFailure = error;
      if (attempt < attempts) await sleep(delayMs);
    }
  }

  throw new Error(`could not roll seeded BEEF for round ${roundId}: ${messageOf(lastFailure)}`);
}

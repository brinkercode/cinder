// Most recently used first.
export function sortSavedCards(cards: { last4: string; lastUsed: number }[]) {
  return [...cards].sort((a, b) => b.lastUsed - a.lastUsed);
}

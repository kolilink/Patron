/** Deterministic fallback name from a UUID — same user always gets the same 4-digit number. */
export function generateFallbackName(userId: string): string {
  const hex = userId.replace(/-/g, '');
  const n = parseInt(hex.slice(-8) || '0', 16);
  const num = (isNaN(n) ? 0 : n) % 9000 + 1000;
  return `Membre ${num}`;
}

export function generateId(): string {
  try {
    // crypto.randomUUID() is available in React Native 0.71+ via Hermes
    return (crypto as unknown as { randomUUID: () => string }).randomUUID();
  } catch {
    // Fallback for older environments
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
}

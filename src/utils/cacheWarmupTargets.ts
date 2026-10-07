// Pure (no store imports) so it is unit-testable without the analytics stack.
/** Which stores a role may read at all (RLS): the warmup never asks for what would be refused. */
export function warmupTargetsFor(role: string | undefined): { fournisseurs: boolean; expenses: boolean } {
  const owner = role === 'administrateur' || role === 'manager';
  return { fournisseurs: owner, expenses: owner || role === 'investisseur' };
}

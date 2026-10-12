// Pure list building behind Gérer mode: ONE "Produits" list (every non-archived product, sorted by
// name — a product at 0 pcs is just a row that says "0 pcs") plus the archived products, which the
// screen shows behind a quiet "Archivés (n)" link. "À compléter" is the quick-add drafts list, shown
// above. Kept free of React so the rules are unit-testable.

import type { Product, ProductVariant } from '@/src/types';

export type GererSectionKey = 'produits';

export interface GererSection {
  key: GererSectionKey;
  label: string;
  products: Product[];
}

/**
 * Pieces in stock. A plain product reads its own stock. A product with models is the sum of its models'
 * stock (the parent's own stock is always 0); null while the models haven't loaded yet.
 */
export function productPieces(p: Pick<Product, 'has_variants' | 'stock_qty'>, variants?: Pick<ProductVariant, 'stock_qty'>[]): number | null {
  if (!p.has_variants) return Math.max(Math.round(p.stock_qty || 0), 0);
  if (!variants || variants.length === 0) return null;
  return variants.reduce((s, v) => s + Math.max(Math.round(v.stock_qty || 0), 0), 0);
}

function fold(str: string): string {
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

function byName(a: Product, b: Product): number {
  return a.name.localeCompare(b.name, 'fr');
}

export function buildGererSections(args: {
  products: Product[];
  archived: Product[];
  query?: string;
}): { sections: GererSection[]; archives: Product[]; total: number } {
  const { products, archived } = args;
  const q = fold(args.query ?? '');
  const match = (p: Product) => !q || fold(p.name).includes(q);

  const produits = products.filter(match).sort(byName);
  const archives = archived.filter(match).sort(byName);

  const sections: GererSection[] = produits.length > 0
    ? [{ key: 'produits', label: 'Produits', products: produits }]
    : [];

  return { sections, archives, total: products.length + archived.length };
}

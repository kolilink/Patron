// Pure sectioning behind Gérer mode: EN VENTE · PRODUITS FINIS · ARCHIVÉS (À compléter is the
// quick-add drafts list, shown above). Kept free of React so the rules are unit-testable.

import type { Product, ProductVariant } from '@/src/types';

export type GererSectionKey = 'enVente' | 'finis' | 'archives';

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

/**
 * "Fini" = 0 pieces. A product with models is fini only once its models are known and all at 0 — an
 * unloaded product is never shown as fini (fail-open, like the rest of the app's variant-stock checks).
 */
export function isOutOfStock(p: Pick<Product, 'has_variants' | 'stock_qty'>, variants?: Pick<ProductVariant, 'stock_qty'>[]): boolean {
  const pcs = productPieces(p, variants);
  return pcs !== null && pcs <= 0;
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
  variantsByProduct: Record<string, ProductVariant[] | undefined>;
  query?: string;
}): { sections: GererSection[]; stockValue: number; total: number } {
  const { products, archived, variantsByProduct } = args;
  const q = fold(args.query ?? '');
  const match = (p: Product) => !q || fold(p.name).includes(q);

  const enVente: Product[] = [];
  const finis: Product[] = [];
  for (const p of products) {
    if (!match(p)) continue;
    (isOutOfStock(p, variantsByProduct[p.id]) ? finis : enVente).push(p);
  }
  const archives = archived.filter(match);

  const sections: GererSection[] = [
    { key: 'enVente' as const, label: 'EN VENTE', products: enVente.sort(byName) },
    { key: 'finis' as const, label: 'PRODUITS FINIS', products: finis.sort(byName) },
    { key: 'archives' as const, label: 'ARCHIVÉS', products: [...archives].sort(byName) },
  ].filter(s => s.products.length > 0);

  // Valeur du stock: what is on the shelf at purchase cost — active products only (archived ones are not
  // for sale), models counted per model.
  let stockValue = 0;
  for (const p of products) {
    if (p.has_variants) {
      for (const v of variantsByProduct[p.id] ?? []) stockValue += (v.cost_price || 0) * Math.max(v.stock_qty || 0, 0);
    } else {
      stockValue += (p.cost_price || 0) * Math.max(p.stock_qty || 0, 0);
    }
  }

  return { sections, stockValue, total: products.length + archived.length };
}

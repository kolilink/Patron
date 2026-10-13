/**
 * Where a sheet's primary CTA lives. One rule for FormSheet and GestureSheet (CLAUDE.md CTA rules):
 *  - 'flow'   → inside the scroll content, one spacing below the last element (ends the form);
 *  - 'docked' → pinned to the sheet's bottom edge (= the keyboard's top edge while typing), with the scroll
 *               content reserving its measured height so nothing can ever sit underneath it.
 */
export type FooterMode = 'flow' | 'sticky';
export type FooterPlacement = 'none' | 'flow' | 'docked';

export function footerPlacement(o: { hasFooter: boolean; mode?: FooterMode; keyboardOpen: boolean; scrollable?: boolean }): FooterPlacement {
  if (!o.hasFooter) return 'none';
  const flows = (o.scrollable ?? true) && (o.mode ?? 'flow') === 'flow' && !o.keyboardOpen;
  return flows ? 'flow' : 'docked';
}

/** Extra scroll-content bottom padding for a placement; null = leave the caller's own padding. */
export function scrollBottomPadding(placement: FooterPlacement, dockedFooterHeight: number, gap: number): number | null {
  return placement === 'docked' ? dockedFooterHeight + gap : null;
}

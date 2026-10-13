// Tapping the ALREADY-ACTIVE tab icon: "take me back to this tab's root". One tiny pub/sub between the tab bar
// (which knows a press happened) and each tab screen (which knows what "deeper than root" means for it — Vendre's
// Gérer mode, a scrolled list…). The screens are mounted tabs, so a plain subscription is enough.
type Listener = () => void;
const listeners = new Map<string, Set<Listener>>();

export function emitTabReselect(routeName: string): void {
  for (const l of [...(listeners.get(routeName) ?? [])]) l();
}

export function onTabReselect(routeName: string, listener: Listener): () => void {
  const set = listeners.get(routeName) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(routeName, set);
  return () => { set.delete(listener); };
}

export type ReselectAction = 'leave-subview' | 'scroll-top' | 'none';

/** Deeper than root → go back to root. At root → scroll to top (iOS convention) unless already there. */
export function resolveReselect(s: { inSubview: boolean; scrollOffset: number }): ReselectAction {
  if (s.inSubview) return 'leave-subview';
  return s.scrollOffset > 1 ? 'scroll-top' : 'none';
}

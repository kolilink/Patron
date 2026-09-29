// Pure decision logic for app/(app)/_layout.tsx's NetInfo connectivity
// listener, split out the same way syncStatusLabel.ts was split from
// SyncStatusLine.tsx — this repo's jest config has no JSX transform, so a
// .tsx file's logic can only be unit-tested if it lives in a plain .ts
// sibling first.
//
// Only a false -> true transition should trigger a kick. NetInfo fires an
// event immediately on subscribe with whatever the current state already
// is, and that initial event must never fire a kick on its own — the app
// mount path (trySync in _layout.tsx) already covers "sync on launch";
// firing here too would just be a redundant (harmless, but pointless) extra
// drain attempt on every cold start.
export function shouldKickOnConnectivityChange(
  wasConnected: boolean | null,
  isConnected: boolean,
): boolean {
  return isConnected && wasConnected === false;
}

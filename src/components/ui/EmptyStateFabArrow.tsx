import { Dimensions, StyleSheet } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useTheme, spacing } from '@/src/theme';

// Shared reference points with the FAB itself (`fabContainer`/`fab` in both
// Catalogue's and Vendre's styles) and with the tab bar's own layout — the
// curve's endpoints are computed from real screen geometry, not eyeballed,
// so the top actually touches the button's edge and the bottom is centered
// on the screen's own tab icon on every device, instead of a per-screen
// magic-number offset that only happened to look right on one of them.
const FAB_BOTTOM = 194; // matches fabContainer.bottom on both screens
const FAB_SIZE = 56; // matches fab.width/height on both screens
const END_Y = 58; // local y of the curve's top point
const TAB_BAR_OVERLAP = 14; // how far past the screen's own bottom edge (behind the tab bar) the curve's start reaches
const HEIGHT = 280;
// Home, Produits, Vendre, Moi — the tab bar's visible buttons (`caisse` has
// href:null and never renders one) for the admin/manager roles that are the
// only ones who ever see this component (canEdit / !isVendeur).
const VISIBLE_TAB_COUNT = 4;

const START_Y = FAB_BOTTOM + END_Y + TAB_BAR_OVERLAP;
const CONTAINER_BOTTOM = FAB_BOTTOM - HEIGHT + END_Y;

interface EmptyStateFabArrowProps {
  // 0-indexed position of this screen's own tab icon among the 4 visible tab
  // bar buttons (Home=0, Produits=1, Vendre=2, Moi=3) — the curve's bottom
  // point is centered on that icon's real x position.
  tabIndex: number;
}

// Decorative "tap here" hint for a screen's empty state: a single clean
// solid curve sweeping up from behind the tab bar to the "+" FAB, its top
// touching the button's own bottom edge and its bottom centered on this
// screen's own tab icon, reaching behind the (opaque) tab bar — no dashes,
// no arrowhead, no animation, just the line. Callers must only render this
// while that screen's list is genuinely empty AND the FAB is actually
// visible (canEdit / !isVendeur) AND online — there's nothing to point at
// otherwise.
export function EmptyStateFabArrow({ tabIndex }: EmptyStateFabArrowProps) {
  const { palette } = useTheme();
  const screenWidth = Dimensions.get('window').width;

  const startX = (tabIndex + 0.5) * (screenWidth / VISIBLE_TAB_COUNT);
  const fabCenterX = screenWidth - spacing[4] - FAB_SIZE / 2;
  // Control points: c1 keeps a slight leftward lean right off the tab icon
  // (matching the original hand-tuned shape), c2 sits a bit under halfway
  // toward the FAB so the curve swings the rest of the way up to it.
  const c1x = startX - 5;
  const c2x = startX + (fabCenterX - startX) * 0.43;
  const d = `M${startX} ${START_Y} C ${c1x} 150, ${c2x} 90, ${fabCenterX} ${END_Y}`;

  return (
    <Svg
      width={screenWidth}
      height={HEIGHT}
      viewBox={`0 0 ${screenWidth} ${HEIGHT}`}
      style={styles.container}
      pointerEvents="none"
    >
      <Path d={d} fill="none" stroke={palette.textDisabled} strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 0,
    bottom: CONTAINER_BOTTOM,
    zIndex: 9,
  },
});

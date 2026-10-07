import { useCallback, useEffect, useState } from 'react';
import { Keyboard, Platform, Pressable, Text, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
    Easing,
    Extrapolation,
    interpolate,
    useAnimatedStyle,
    useSharedValue,
    withSpring,
    withTiming,
} from 'react-native-reanimated';
import { useReduceMotion } from '@/src/hooks/useReduceMotion';
import { useTheme, FLOATING_TAB_BAR_HEIGHT, FLOATING_TAB_BAR_GAP } from '@/src/theme';
import { haptics } from '@/lib/haptics';

// ─────────────────────────────────────────────────────────────────────────────
// Floating tab bar — Material 3 style: a rounded floating bar with a soft
// violet indicator pill that GLIDES between tabs, plus per-platform graded
// glass backgrounds.
//
// Background tiers (spec §1):
//   • iOS            → real `BlurView` (expo-blur), native frosted glass.
//   • Android 13+    → GPU blur via `experimentalBlurMethod="dimezisBlurView"`.
//   • Android ≤12    → flat translucent fill + 1px hairline border. Renders
//                      visually identical with zero per-frame blur cost — the
//                      real-time blur is the documented jank/crash on low-end
//                      devices (see CLAUDE.md "Floating tab bar").
//
// The indicator (spec §2) moves with `transform: translateX` + `width` only,
// driven by a single animated `activeIndex` shared value so the pill glide and
// the icon outline→filled crossfade are frame-synced. Never `scaleX` (it
// crushes the pill's corner radius), never a jump — every state change is an
// animatable shared-value write.
//
// Press micro-interaction (spec §3): scale 0.97 in 120ms, spring back with
// stiffness 300 / damping 14, haptic fires at PRESS (not arrival).
//
// ─────────────────────────────────────────────────────────────────────────────

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

export interface FloatingTabItem {
    key: string;
    /** Short, always-present accessibility label (and visible label if shown). */
    label: string;
    /** Glyph when inactive. */
    outline: IoniconName;
    /** Glyph when active (filled variant). */
    filled: IoniconName;
}

export interface FloatingTabBarProps {
    items: FloatingTabItem[];
    /** Active index within `items` (the visible set). */
    index: number;
    /** Called with the visible index when a tab is pressed. */
    onSelect: (index: number) => void;
    /** Safe-area bottom inset to offset the floating bar above the home indicator. */
    bottomInset: number;
    /**
     * Fixed bar width. When omitted the bar stretches to its container's full
     * width (the consumer decides whether that container is inset). Pass it to
     * reproduce the existing content-hugging pill (see `barWidthFor()` in
     * `(tabs)/_layout.tsx`).
     */
    width?: number;
    /** Render short visible labels under the icons. Off = icon-only (labels stay
     *  as accessibility labels). */
    showLabels?: boolean;
}

const INDICATOR_V_INSET = 8; // vertical inset of the pill inside the bar
const INDICATOR_H_INSET = 6; // horizontal inset of the pill inside its slot
const PRESS_SCALE = 0.97; // spec: scale 0.97
const PRESS_DURATION_MS = 120; // spec: ≤120–150ms
const PRESS_SPRING = { stiffness: 300, damping: 14, mass: 0.6 }; // spec: 300 / 12–15
const SLIDE_DURATION_MS = 120; // pill glide only; icons/labels are instant. A new tap reassigns the shared value, which cancels the in-flight glide (interrupt, never queue).
const SLIDE_EASING = Easing.bezier(0.77, 0, 0.175, 1); // spec: bezier(0.77,0,0.175,1)
const ICON_SIZE = 24;
const LABEL_FONT_SIZE = 11;
const LABEL_LINE_HEIGHT = 12;
const MIN_TAP_TARGET = 48; // spec: 48dp min

function isAndroidBelow13(): boolean {
    if (Platform.OS !== 'android') return false;
    const v = Number(Platform.Version);
    return Number.isFinite(v) && v < 13;
}

/** Icon: filled when this tab is the active one, outline otherwise. Driven by the
 *  synchronous `focused` prop (not the animated glide value), so the icon tells
 *  the truth on the first frame — no crossfade lag behind the screen. */
function TabGlyph({
    focused,
    outline,
    filled,
    inactiveColor,
    activeColor,
    size,
}: {
    focused: boolean;
    outline: IoniconName;
    filled: IoniconName;
    inactiveColor: string;
    activeColor: string;
    size: number;
}) {
    return (
        <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons
                name={focused ? filled : outline}
                size={size}
                color={focused ? activeColor : inactiveColor}
            />
        </View>
    );
}

/** Short label; color follows the synchronous `focused` prop, same as the icon. */
function TabLabel({
    focused,
    label,
    inactiveColor,
    activeColor,
}: {
    focused: boolean;
    label: string;
    inactiveColor: string;
    activeColor: string;
}) {
    return (
        <Text
            style={{
                color: focused ? activeColor : inactiveColor,
                fontSize: LABEL_FONT_SIZE,
                lineHeight: LABEL_LINE_HEIGHT,
                marginTop: 2,
            }}
            numberOfLines={1}
        >
            {label}
        </Text>
    );
}

export function FloatingTabBar({
    items,
    index,
    onSelect,
    bottomInset,
    width,
    showLabels = false,
}: FloatingTabBarProps) {
    const { palette, resolvedScheme } = useTheme();
    const reduceMotion = useReduceMotion();

    const [barWidth, setBarWidth] = useState(0);
    const [keyboardVisible, setKeyboardVisible] = useState(false);

    useEffect(() => {
        // Keyboard-aware (spec §5): hide the floating bar while the keyboard is
        // up so it never sits on top of a form. Mirrors the default bar's
        // `tabBarHideOnKeyboard`, which doesn't reach a custom `tabBar` render.
        const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
        const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
        const showSub = Keyboard.addListener(showEvt, () => setKeyboardVisible(true));
        const hideSub = Keyboard.addListener(hideEvt, () => setKeyboardVisible(false));
        return () => {
            showSub.remove();
            hideSub.remove();
        };
    }, []);

    const n = items.length;

    // Single source of truth for the active tab, animated — the pill glide and
    // every glyph crossfade read this one value, so they can never drift apart.
    const activeIndex = useSharedValue(index);
    useEffect(() => {
        if (reduceMotion) {
            activeIndex.value = index;
            return;
        }
        activeIndex.value = withTiming(index, { duration: SLIDE_DURATION_MS, easing: SLIDE_EASING });
    }, [index, reduceMotion, activeIndex]);

    // Measured per-slot geometry. Slots are equal-width (`barWidth / n`), but
    // positions still flow through shared values so the indicator worklet never
    // reads stale JS state — and so a future non-equal "hug" mode can slot in
    // without changing the worklet.
    const slotLefts = useSharedValue<number[]>([]);
    const slotWidths = useSharedValue<number[]>([]);
    const slotIndices = useSharedValue<number[]>([]);

    useEffect(() => {
        if (barWidth === 0 || n === 0) return;
        const w = barWidth / n;
        const lefts: number[] = [];
        const widths: number[] = [];
        const indices: number[] = [];
        for (let i = 0; i < n; i++) {
            lefts.push(i * w);
            widths.push(w);
            indices.push(i);
        }
        slotLefts.value = lefts;
        slotWidths.value = widths;
        slotIndices.value = indices;
    }, [barWidth, n, slotLefts, slotWidths, slotIndices]);

    const indicatorStyle = useAnimatedStyle(() => {
        const lefts = slotLefts.value;
        const widths = slotWidths.value;
        const indices = slotIndices.value;
        if (lefts.length !== n || n === 0) {
            return { opacity: 0, transform: [{ translateX: 0 }], width: 0 };
        }
        const left = interpolate(activeIndex.value, indices, lefts, Extrapolation.CLAMP);
        const width = interpolate(activeIndex.value, indices, widths, Extrapolation.CLAMP);
        return {
            opacity: 1,
            transform: [{ translateX: left + INDICATOR_H_INSET }],
            width: width - 2 * INDICATOR_H_INSET,
        };
    });

    // Keyboard-hide (spec §5): drive the whole bar down + fade out while the
    // keyboard is up, with the same instant fallback under reduce-motion.
    const keyboardHide = useSharedValue(0);
    useEffect(() => {
        if (reduceMotion) {
            keyboardHide.value = keyboardVisible ? 1 : 0;
            return;
        }
        keyboardHide.value = withTiming(keyboardVisible ? 1 : 0, {
            duration: 200,
            easing: Easing.out(Easing.quad),
        });
    }, [keyboardVisible, reduceMotion, keyboardHide]);
    const keyboardStyle = useAnimatedStyle(() => ({
        opacity: 1 - keyboardHide.value,
        transform: [
            { translateY: keyboardHide.value * (FLOATING_TAB_BAR_HEIGHT + FLOATING_TAB_BAR_GAP + bottomInset) },
        ],
    }));

    const pressScale = useSharedValue(1);
    const onPressIn = useCallback(() => {
        // Haptic fires at PRESS, not arrival (spec §3).
        haptics.select();
        if (reduceMotion) return;
        pressScale.value = withTiming(PRESS_SCALE, { duration: PRESS_DURATION_MS, easing: Easing.out(Easing.quad) });
    }, [reduceMotion, pressScale]);
    const onPressOut = useCallback(() => {
        if (reduceMotion) return;
        pressScale.value = withSpring(1, PRESS_SPRING);
    }, [reduceMotion, pressScale]);
    const pressStyle = useAnimatedStyle(() => ({ transform: [{ scale: pressScale.value }] }));

    const blurTint = resolvedScheme === 'dark' ? 'dark' : 'light';
    const below13 = isAndroidBelow13();

    const indicatorHeight = FLOATING_TAB_BAR_HEIGHT - 2 * INDICATOR_V_INSET;
    const slotWidth = barWidth > 0 ? barWidth / n : 0;
    const hitSlop = Math.max(0, Math.ceil((MIN_TAP_TARGET - Math.min(slotWidth, MIN_TAP_TARGET)) / 2));

    return (
        <Animated.View
            pointerEvents="box-none"
            style={[
                {
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    bottom: bottomInset + FLOATING_TAB_BAR_GAP,
                    alignItems: 'center',
                },
                keyboardStyle,
            ]}
        >
            <View
                onLayout={e => setBarWidth(e.nativeEvent.layout.width)}
                style={{
                    width: width ?? '100%',
                    borderRadius: 9999,
                    overflow: 'hidden',
                    height: FLOATING_TAB_BAR_HEIGHT,
                    backgroundColor: below13 ? palette.tabBarGlass : 'transparent',
                    borderWidth: below13 ? 1 : 0,
                    borderColor: below13 ? palette.tabBarHairline : 'transparent',
                }}
            >
                {/* Sliding indicator — absolute, moves via translateX (+ width in hug
            mode), never scaleX. */}
                <Animated.View
                    pointerEvents="none"
                    style={[
                        {
                            position: 'absolute',
                            top: INDICATOR_V_INSET,
                            height: indicatorHeight,
                            borderRadius: indicatorHeight / 2,
                            backgroundColor: palette.tabBarIndicator,
                        },
                        indicatorStyle,
                    ]}
                />

                {!below13 && (
                    <BlurView
                        intensity={52}
                        tint={blurTint}
                        experimentalBlurMethod={Platform.OS === 'android' ? 'dimezisBlurView' : undefined}
                        style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            right: 0,
                            bottom: 0,
                            backgroundColor: palette.tabBarOverlay,
                        }}
                    />
                )}

                {/* Tabs — laid out above the indicator + blur so touches and glyphs are
            on top. */}
                <View style={{ flexDirection: 'row', height: FLOATING_TAB_BAR_HEIGHT }}>
                    {items.map((item, i) => {
                        const focused = i === index;
                        return (
                            <Pressable
                                key={item.key}
                                accessibilityRole="tab"
                                accessibilityLabel={item.label}
                                accessibilityState={{ selected: focused }}
                                hitSlop={hitSlop}
                                onPressIn={onPressIn}
                                onPressOut={onPressOut}
                                onPress={() => onSelect(i)}
                                style={{
                                    width: slotWidth,
                                    height: FLOATING_TAB_BAR_HEIGHT,
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                }}
                            >
                                <Animated.View style={pressStyle}>
                                    <TabGlyph
                                        focused={focused}
                                        outline={item.outline}
                                        filled={item.filled}
                                        inactiveColor={palette.tabBarInactive}
                                        activeColor={palette.textPrimary}
                                        size={ICON_SIZE}
                                    />
                                    {showLabels && (
                                        <TabLabel
                                            focused={focused}
                                            label={item.label}
                                            inactiveColor={palette.tabBarInactive}
                                            activeColor={palette.textPrimary}
                                        />
                                    )}
                                </Animated.View>
                            </Pressable>
                        );
                    })}
                </View>
            </View>
        </Animated.View>
    );
}

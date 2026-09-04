import { useMemo } from 'react';
import { View, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, radius, spacing } from '../../theme';
import { FF } from '../../theme/typography';
import type { Palette } from '../../theme';
import { Text } from './Text';

// Reserved to 'success'/'warning' only — this app has a standing no-red-in-
// merchant-UI rule, so Pill structurally can't be reached for a danger tone.
type PillTone = 'success' | 'warning';
type PillVariant = 'soft' | 'solid';
type PillSize = 'sm' | 'md';

interface PillProps {
  tone: PillTone;
  variant?: PillVariant;
  size?: PillSize;
  icon?: React.ComponentProps<typeof Ionicons>['name'];
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

const SIZES: Record<PillSize, { fontSize: number; iconSize: number; paddingHorizontal: number; paddingVertical: number; gap: number }> = {
  sm: { fontSize: 12, iconSize: 11, paddingHorizontal: spacing[2], paddingVertical: 3, gap: spacing[1] },
  md: { fontSize: 14, iconSize: 14, paddingHorizontal: spacing[2.5], paddingVertical: 5, gap: 5 },
};

// `solid` (white text on a full color fill) is deliberately the loud, rare
// option — reach for `soft` (the existing tinted-bg pattern) by default, and
// only use `solid` where a real directional/state signal exists (e.g. the
// dashboard revenue delta). Solid > soft in glanceability under direct
// sunlight, which is a real condition for this app's audience — but using it
// everywhere would recreate the "color means nothing" dilution it's meant to
// fix. See CLAUDE.md's design-system notes for the reasoning.
export function Pill({ tone, variant = 'soft', size = 'sm', icon, children, style }: PillProps) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(), []);
  const s = SIZES[size];
  const isSolid = variant === 'solid';
  const bg = isSolid ? palette[tone] : palette[`${tone}Light` as const];
  const iconColor = isSolid ? palette.textInverse : palette[tone];

  return (
    <View
      style={[
        styles.pill,
        { backgroundColor: bg, paddingHorizontal: s.paddingHorizontal, paddingVertical: s.paddingVertical, gap: s.gap },
        style,
      ]}
    >
      {icon ? <Ionicons name={icon} size={s.iconSize} color={iconColor} /> : null}
      <Text
        color={isSolid ? 'inverse' : tone}
        style={{ fontFamily: isSolid ? FF.semibold : FF.medium, fontSize: s.fontSize, lineHeight: s.fontSize + 4 }}
      >
        {children}
      </Text>
    </View>
  );
}

function makeStyles() {
  return StyleSheet.create({
    pill: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-start',
      borderRadius: radius.full,
    },
  });
}

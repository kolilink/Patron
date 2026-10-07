import { View, type ViewProps } from 'react-native';
import { Stack } from 'expo-router';
import type { ComponentProps } from 'react';
import { useTheme } from '@/src/theme';

type StackOptions = NonNullable<ComponentProps<typeof Stack>['screenOptions']>;

/**
 * Stack whose card background is the theme background. Without it, a fade or
 * slide transition exposes React Navigation's default white card — a white
 * flash in dark mode.
 */
export function ThemedStack({ screenOptions }: { screenOptions?: Extract<StackOptions, object> }) {
  const { palette } = useTheme();
  return (
    <Stack
      screenOptions={{
        ...screenOptions,
        contentStyle: { backgroundColor: palette.background },
      }}
    />
  );
}

/** Root flex:1 View painted with the theme background so the native root never shows white. */
export function ThemedRootView(props: ViewProps) {
  const { palette } = useTheme();
  return <View {...props} style={[{ flex: 1, backgroundColor: palette.background }, props.style]} />;
}

import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme } from '@/src/theme';

export const CTA_FADE_HEIGHT = 28;

/**
 * The only allowed way to keep a CTA visible over scrolling content: a bottom
 * fade (transparent → theme background) that sits ABOVE the button. The wrapper
 * and the button area itself stay transparent — never a hard-edged slab.
 * Callers must state why the CTA has to be sticky (one-line comment at the call site).
 */
export function CtaFade({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const { palette } = useTheme();
  return (
    <View style={style}>
      <LinearGradient
        pointerEvents="none"
        colors={['rgba(0,0,0,0)', palette.background]}
        style={styles.fade}
      />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  fade: { position: 'absolute', left: 0, right: 0, top: -CTA_FADE_HEIGHT, height: CTA_FADE_HEIGHT },
});

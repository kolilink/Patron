import PostHog from 'posthog-react-native';

// Singleton — imported by lib/analytics.ts and by app/_layout.tsx (for PostHogProvider).
// The API key is optional in dev; events are silently dropped when the key is absent.
export const posthog = new PostHog(
  process.env.EXPO_PUBLIC_POSTHOG_KEY ?? '',
  {
    host: process.env.EXPO_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com',
    disabled: !process.env.EXPO_PUBLIC_POSTHOG_KEY,
    sendFeatureFlagEvent: false,
  },
);

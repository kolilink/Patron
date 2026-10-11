import { Redirect, useLocalSearchParams } from 'expo-router';

/**
 * The Produits tab no longer exists: products live in Vendre (sell mode + "Gérer" mode).
 * This thin route only catches links that still point at the old screen — push notifications already
 * in flight (low_stock → /catalogue), saved deep links — and forwards them, so nothing dangles.
 * `openForm` / `prefillName` keep their meaning (open the add sheet); anything else lands in Gérer.
 */
export default function CatalogueRedirect() {
  const { openForm, prefillName } = useLocalSearchParams<{ openForm?: string; prefillName?: string }>();
  return (
    <Redirect
      href={{
        pathname: '/(app)/(tabs)/vendre',
        params: openForm === '1' ? { openForm: '1', ...(prefillName ? { prefillName } : {}) } : { gerer: '1' },
      }}
    />
  );
}

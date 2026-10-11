import { Redirect, useLocalSearchParams } from 'expo-router';

/** Old `/catalogue/<product id>` links (low_stock push): open Gérer on that product's actions. */
export default function CatalogueProductRedirect() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return <Redirect href={{ pathname: '/(app)/(tabs)/vendre', params: { gerer: '1', ...(id ? { focus: String(id) } : {}) } }} />;
}

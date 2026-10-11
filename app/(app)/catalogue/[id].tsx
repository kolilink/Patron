import { Redirect, useLocalSearchParams } from 'expo-router';

/** Old `/catalogue/<product id>` links (low_stock push): open that product's edit sheet in Vendre. */
export default function CatalogueProductRedirect() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return <Redirect href={{ pathname: '/(app)/(tabs)/vendre', params: id ? { focus: String(id) } : { gerer: '1' } }} />;
}

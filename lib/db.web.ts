// Web stub: expo-sqlite is native-only; offline SQLite layer is skipped on web.
// All Supabase stores work normally; only the offline queue is unavailable.
export async function openDb(): Promise<void> {}
export async function enqueue(_op: string, _payload: object): Promise<void> {}
export async function getPendingOps(): Promise<never[]> { return []; }
export async function deleteQueueItem(_id: number): Promise<void> {}
export async function markAttemptFailed(_id: number, _error: string): Promise<void> {}
export async function getQueueCount(): Promise<number> { return 0; }
export async function getDeadCount(): Promise<number> { return 0; }
export async function clearDeadOps(): Promise<void> {}
export async function saveDashboardKpiCache(_businessId: string, _kpis: unknown): Promise<void> {}
export async function getDashboardKpiCache(_businessId: string): Promise<null> { return null; }
export async function saveProductCache(_businessId: string, _products: unknown[]): Promise<void> {}
export async function getProductCache(_businessId: string): Promise<null> { return null; }
export async function saveVentesCache(_key: string, _data: unknown[]): Promise<void> {}
export async function getVentesCache(_key: string): Promise<null> { return null; }
export async function saveFournisseurCache(_businessId: string, _data: unknown[]): Promise<void> {}
export async function getFournisseurCache(_businessId: string): Promise<null> { return null; }
export async function saveCommandeCache(_businessId: string, _data: unknown[]): Promise<void> {}
export async function getCommandeCache(_businessId: string): Promise<null> { return null; }
export async function saveExpenseCache(_businessId: string, _data: unknown[]): Promise<void> {}
export async function getExpenseCache(_businessId: string): Promise<null> { return null; }
export async function saveApportsCache(_businessId: string, _data: unknown[]): Promise<void> {}
export async function getApportsCache(_businessId: string): Promise<null> { return null; }
export async function getKV(_key: string): Promise<null> { return null; }
export async function setKV(_key: string, _value: string): Promise<void> {}

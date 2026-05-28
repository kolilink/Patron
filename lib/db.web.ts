// Web stub: expo-sqlite is native-only; offline SQLite layer is skipped on web.
// All Supabase stores work normally; only the offline queue is unavailable.
export async function openDb(): Promise<void> {}
export async function enqueue(_op: string, _payload: object): Promise<void> {}
export async function getPendingOps(): Promise<never[]> { return []; }
export async function deleteQueueItem(_id: number): Promise<void> {}
export async function markAttemptFailed(_id: number, _error: string): Promise<void> {}
export async function getQueueCount(): Promise<number> { return 0; }

import { useAuthStore } from '@/stores/auth';
import { isTeamsEnabled } from '@/src/utils/teamsFlag';

/** True unless the ACTIVE business has teams_enabled === false (fail-open). */
export function useTeamsEnabled(): boolean {
  return useAuthStore(s => isTeamsEnabled(s.session?.activeBusiness));
}

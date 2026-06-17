// false  = cold start with an existing session → AppLockOverlay should gate on first mount
// true   = no session on cold start (OTP flow ahead) → skip the gate after login
// Resets to false on every JS bundle reload (= every cold start).
export let skipColdStartGate = false;

export function markNoSessionOnStartup() {
  skipColdStartGate = true;
}

export function markGateCleared() {
  skipColdStartGate = true;
}

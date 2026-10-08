/** The small static amber dot before "Enregistrer": only when there is something to save and nothing is saving. */
export function showUnsavedDot(isDirty: boolean, saving: boolean): boolean {
  return isDirty && !saving;
}

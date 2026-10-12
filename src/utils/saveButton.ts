// Paramètres' header "Enregistrer": completely steady, no animation. Unsaved changes are marked by a small
// STATIC amber dot right before the text — shown only when there are changes and nothing is saving.

/** Is there anything to save, and is the app not already saving it? */
export function showUnsavedDot(isDirty: boolean, saving: boolean): boolean {
  return isDirty && !saving;
}

export function saveButtonLabel(saving: boolean): string {
  return saving ? 'Enreg…' : 'Enregistrer';
}

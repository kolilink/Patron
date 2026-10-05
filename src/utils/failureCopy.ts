// Every failure sentence the app shows, in one place, in the failure
// vocabulary (src/utils/failure.ts). Adding a failure = adding an entry here;
// __tests__/failure-vocabulary.test.ts checks every entry. `what` says what
// happened in concrete active words; `why` appears only when it helps her act.

export const NO_CONNECTION_MESSAGE = 'Pas de connexion. Vérifiez votre connexion.';
export const SAFE_DATA_WHY = 'Vos données sont en sécurité.';

export const FAILURE_COPY = {
  // Money
  paymentNotRecorded: { what: "Le paiement n'a pas été enregistré.", why: SAFE_DATA_WHY },
  saleNotRecorded: { what: "La vente n'a pas été enregistrée." },
  productNotSaved: { what: "Le produit n'a pas été enregistré.", why: SAFE_DATA_WHY },
  stockNotAdjusted: { what: "Le stock n'a pas été modifié." },
  // People & places
  supplierNotCreated: { what: "Le fournisseur n'a pas été créé.", why: SAFE_DATA_WHY },
  supplierProductNotSaved: { what: "Ce produit n'a pas été enregistré." },
  leaveNotDone: { what: "Vous n'avez pas quitté le commerce." },
  memberStakesNotSaved: { what: "Les montants n'ont pas été enregistrés." },
  memberStakeNotRemoved: { what: "Le produit n'a pas été retiré." },
  testFlagNotChanged: { what: "Le changement n'a pas été fait." },
  // Messages & community
  partnerRequestNotSent: { what: "La demande n'a pas été envoyée." },
  messageNotEdited: { what: "Le message n'a pas été modifié." },
  messageNotSent: { what: "Le message n'a pas été envoyé." },
  postNotPublished: { what: "Le post n'a pas été publié." },
  postNotEdited: { what: "Le post n'a pas été modifié." },
  commentNotPublished: { what: "Le commentaire n'a pas été publié." },
  receiptNotShared: { what: "Le reçu n'a pas été partagé." },
  shareNotOpened: { what: "Le partage ne s'est pas ouvert." },
  mailNotOpened: { what: "L'application mail ne s'est pas ouverte." },
  voiceNotTranscribed: { what: "La voix n'a pas pu être lue." },
  // Invites
  inviteLinkInvalid: { what: "Ce lien d'invitation ne fonctionne plus." },
  inviteNotOpened: { what: "L'invitation n'a pas été ouverte." },
  voiceMessageNotSent: { what: "Le message vocal n'a pas été envoyé." },
  imageMessageNotSent: { what: "L'image n'a pas été envoyée." },
  deleteAccountNotDone: { what: "Votre compte n'a pas été supprimé.", why: 'Vos données sont toujours là.' },
  ratingNotSent: { what: "Votre note n'a pas été envoyée." },
  founderReplyNotSent: { what: "La réponse n'a pas été envoyée." },
  requestNotAccepted: { what: "La demande n'a pas été acceptée." },
  requestNotDeclined: { what: "La demande n'a pas été refusée." },
  partnerSettingsNotSaved: { what: "Les réglages n'ont pas été enregistrés." },
  partnerNotRemoved: { what: "Le partenaire n'a pas été retiré." },
  conversationNotOpened: { what: "La conversation ne s'est pas ouverte." },
  productNotLinked: { what: "Le produit n'a pas été lié." },
  productNotUnlinked: { what: "Le produit n'a pas été délié." },
  settingNotChanged: { what: "Le réglage n'a pas été changé." },
  otherDevicesNotSignedOut: { what: "Les autres appareils n'ont pas été déconnectés." },
  codeNotSent: { what: "Le code n'a pas été envoyé." },
  codeNotWorking: { what: 'Ce code ne fonctionne pas.' },
  // Photos attached after a save
  proofNotAttached: { what: "L'image n'a pas été jointe.", why: 'Le reste est enregistré.' },
  // Invites: a deliberately named reason so the caller can react
  // Generic, when nothing more specific is known
  actionNotDone: { what: "Ça n'a pas fonctionné." },
  loadFailed: { what: "Les chiffres ne se sont pas chargés." },
} as const;

export type FailureKey = keyof typeof FAILURE_COPY;

// ─────────────────────────────────────────────────────────────
// Code de conduite des espaces sociaux Patron (Phase 2, item 2).
//
// VERSIONNÉ : toute reformulation doit incrémenter CONDUCT_VERSION
// et passer par une nouvelle migration — jamais de modification
// silencieuse du texte affiché. Ces cinq règles sont épinglées en
// haut de chaque espace, rappelées dans le composeur avant publication
// et liées depuis chaque écran de signalement.
// ─────────────────────────────────────────────────────────────

export const CONDUCT_VERSION = 1;

export type ConductRuleId =
    | 'harcelement'
    | 'donnees_privees'
    | 'spam'
    | 'mauvais_espace'
    | 'moderation';

export interface ConductRule {
    id: ConductRuleId;
    /** Short label shown in the pinned strip and the composer reminder. */
    short: string;
    /** Full text shown in the rules sheet. */
    full: string;
}

export const CONDUCT_RULES: ConductRule[] = [
    {
        id: 'harcelement',
        short: 'Respect',
        full:
            "Pas de harcèlement ni d'insultes. On s'adresse aux autres avec respect, même quand on n'est pas d'accord.",
    },
    {
        id: 'donnees_privees',
        short: 'Confidentialité',
        full:
            "Jamais de dettes, de téléphones ni de données privées. Vos chiffres restent dans votre carnet — ne publiez jamais ceux des autres.",
    },
    {
        id: 'spam',
        short: 'Sincérité',
        full:
            "Pas de spam ni d'arnaques. Les annonces doivent être vraies et utiles à la communauté.",
    },
    {
        id: 'mauvais_espace',
        short: 'Bon espace',
        full:
            'Publiez dans le bon espace. Chaque message va dans la discussion qui lui correspond.',
    },
    {
        id: 'moderation',
        short: 'Modération',
        full:
            "Patron peut retirer un contenu ou un compte. L'équipe veille au respect de ces règles, dans le calme et en privé.",
    },
];

// The promise every member sees before publishing and on the info screen
// (Phase 4 — the wall between carré and carnet IS the product).
export const PRIVACY_PROMISE = 'Vos chiffres ne quittent jamais votre carnet.';

// Phase 4, item 4 — the four ABSOLUTE interdictions of the privacy wall.
// The square (carré) is for people; the carnet is for money. These are the
// four walls that keep business data out of the social spaces. Versioned with
// CONDUCT_VERSION so any rephrasing must be deliberate.
export interface PrivacyInterdiction {
    id: 'autocomplete' | 'recherche' | 'partage' | 'alpha';
    title: string;
    full: string;
}

export const PRIVACY_INTERDICTIONS: PrivacyInterdiction[] = [
    {
        id: 'autocomplete',
        title: 'Aucune autocomplétion depuis vos données',
        full:
            'Le composeur ne propose jamais de noms, de dettes ni de chiffres issus de votre carnet ou de vos tables privées.',
    },
    {
        id: 'recherche',
        title: 'Aucune recherche dans vos données',
        full:
            "La recherche des espaces n'indexe jamais les données de votre commerce. Chercher dans les espaces, c'est chercher parmi les personnes, pas dans les comptes.",
    },
    {
        id: 'partage',
        title: 'Aucun « Partager sur Le Marché »',
        full:
            "Les écrans financiers ne proposent jamais de publier un chiffre, une vente ou un reçu dans un espace social.",
    },
    {
        id: 'alpha',
        title: 'Alpha ne publie aucun chiffre',
        full:
            "Alpha reste dans votre carnet : il peut vous lire vos chiffres, jamais les écrire dans un espace social.",
    },
];

// Motifs proposés lors d'un signalement (Phase 1). The first four map to
// the conduct rules; 'autre' lets a member flag anything else with a detail.
export const REPORT_MOTIFS: Array<{
    id: 'harcelement' | 'donnees_privees' | 'spam' | 'mauvais_espace' | 'autre';
    label: string;
    icon: string;
}> = [
        { id: 'harcelement', label: 'Harcèlement ou insultes', icon: 'shield-outline' },
        { id: 'donnees_privees', label: 'Dettes, téléphones ou données privées', icon: 'lock-closed-outline' },
        { id: 'spam', label: 'Spam ou arnaque', icon: 'alert-circle-outline' },
        { id: 'mauvais_espace', label: 'Publié dans le mauvais espace', icon: 'swap-horizontal-outline' },
        { id: 'autre', label: 'Autre', icon: 'ellipsis-horizontal' },
    ];

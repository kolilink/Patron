# Échelle de modération — Patron (v1)

Ce document est **versionné** et fait partie du code. Toute évolution de la
modération passe par une nouvelle version de ce fichier (v2, v3…), jamais par
une réécriture silencieuse du texte existant. Les motifs affichés dans
l'application ([`REPORT_MOTIFS`](../src/constants/conduct.ts)) et les niveaux
ci-dessous doivent rester alignés.

## Principes

1. **Une seule file** — tous les signalements de tous les espaces (Le Marché,
   à terme Mon commerce et Amis) tombent dans la table `reports` et sont
   traités depuis un seul écran par le fondateur.
2. **Non-punitif par défaut** — on part du plus doux qui protège, on monte
   uniquement si le comportement persiste. Les limites de publication restent
   pédagogiques (« Doucement — vous pourrez republier dans X minutes »).
3. **Le bloc agit sur le compte** (`profiles.id`), jamais sur un post, une
   entreprise ou un pseudo. Le blocage est mutuel : invisibilité réciproque.
4. **Traçabilité** — le motif (`harcelement`, `donnees_privees`, `spam`,
   `mauvais_espace`, `autre`) et le niveau appliqué sont enregistrés. On ne
   supprime un contenu qu'avec un motif.

## Niveaux

### BAS — rappel (warning)

- **Quand** : première faute bénigne ; contenu dans le mauvais espace ;
  maladresse sans intention de nuire.
- **Action** : le post concerné est retiré (ou laissé selon gravité) et un
  message calme rappelle la règle concernée du code de conduite. Aucune
  restriction d'accès.
- **Serveur** : `delete_market_post` (post précis) + message au membre. Aucun
  bloc.

### MOYEN — restriction temporaire (mute)

- **Quand** : récidive après un BAS ; spam répété ; partage de données
  personnelles d'un tiers malgré le rappel.
- **Action** : retrait des contenus fautifs + blocage de la publication pour
  une durée courte et explicite. L'identité (pseudo) est conservée.
- **Serveur** : le membre conserve son compte ; seule la création de contenu
  est suspendue (à câbler via un flag de restriction, cf. « Travaux futurs »).

### HAUT — blocage définitif (ban)

- **Quand** : harcèlement avéré, menace, contournement d'un blocage, diffusion
  répétée de données privées après un MOYEN.
- **Action** : blocage du compte au niveau `profiles.id` par le fondateur
  (`block_user`). Invisibilité mutuelle immédiate dans tous les espaces.
  Les contenus existants de l'auteur disparaissent de la vue des autres
  membres.
- **Serveur** : `block_user` (le fondateur peut bloquer n'importe quel compte
  depuis l'écran de modération).

## Correspondance motif → niveau initial

| Motif | Niveau initial | Remarque |
| --- | --- | --- |
| `mauvais_espace` | BAS | simple déplacement de sujet |
| `spam` | MOYEN | retrait + avertissement, puis restriction |
| `donnees_privees` | MOYEN | la 4e interdiction (mur de confidentialité) est absolue |
| `harcelement` | HAUT | blocage immédiat, pas de palier |
| `autre` | BAS | évalué au cas par cas |

## Travaux futurs (versionnés)

- `MOYEN` (mute) : ajouter un flag de restriction de publication dans
  `profiles` (par ex. `posting_restricted_until`) et le faire respecter dans
  `create_market_post` / `create_market_comment`, comme le fait déjà
  `is_blocked_between` pour l'invisibilité.
- Journal d'audit par niveau appliqué (qui / quand / quel motif / quel niveau).

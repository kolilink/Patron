# Audit haptique Patron — Phase 0

Date : 2026-10-01 · Référence normative : §5 du rapport de recherche patron-haptics
(fourni inline par l'utilisateur — le fichier report.md n'existe que sur la machine de l'assistant).

## 1. Surface API expo-haptics (question 2)

- Version installée : **expo-haptics `~15.0.8`** (SDK 54).
- `performAndroidHapticsAsync(type: AndroidHaptics): Promise<void>` : **EXPOSÉ** (voir
  [`node_modules/expo-haptics/build/Haptics.d.ts`](node_modules/expo-haptics/build/Haptics.d.ts:30)).
- Enum `AndroidHaptics` : **EXPOSÉ** — valeurs confirmées dans
  [`node_modules/expo-haptics/build/Haptics.types.d.ts`](node_modules/expo-haptics/build/Haptics.types.d.ts:52) :
  `Confirm`, `Reject`, `Gesture_Start`, `Gesture_End`, `Toggle_On`, `Toggle_Off`,
  `Clock_Tick`, `Context_Click`, `Drag_Start`, `Keyboard_Tap`, `Keyboard_Press`,
  `Keyboard_Release`, `Long_Press`, `Virtual_Key`, `Virtual_Key_Release`, `No_Haptics`,
  `Segment_Tick`, `Segment_Frequent_Tick`, `Text_Handle_Move`.
- **Conclusion : AUCUN bump de version nécessaire.** La primitive Android dédiée
  (qui ne requiert pas la permission VIBRATE, contrairement à Vibrator) est déjà disponible.

## 2. Vibrator / vibration brute (question 3)

Recherche `Vibrator`, `react-native-vibration`, `Vibration.` sur `app/`, `src/`, `lib/`, `stores/` :

- **ZÉRO usage.** Aucun usage brut du moteur de vibration Android, aucun
  `react-native-vibration` dans `package.json`.
- **Conclusion : propre.** Aucune vibration custom à supprimer.

## 3. Inventaire complet des appels haptiques

93 appels (module `@/lib/haptics` + 1 usage brut `expo-haptics` dans carnet.tsx).
Légende : ✅ conforme · 🔴 à retirer · 🔁 à throttler · 🟡 à corriger (mauvais pattern sémantique).

### 3.1 Sorties (success / error / warning) — ✅ conformes

| Fichier | Lignes | Pattern | Verdict |
|---|---|---|---|
| app/(app)/clients/[name].tsx | 615 | success | ✅ |
| app/(app)/fournisseurs/index.tsx | 475, 524, 711 | error / success | ✅ |
| app/(app)/fournisseurs/reception.tsx | 240, 310, 376 | success / warning / success | ✅ |
| app/(app)/apports/index.tsx | 479 | success | ✅ |
| app/(app)/discussions.tsx | 916, 939, 941, 967, 993, 996 | success / error | ✅ |
| app/(app)/ventes/index.tsx | 483, 488, 582, 586 | success / error | ✅ |
| app/(app)/(tabs)/index.tsx | 1055 | success | ✅ |
| app/(app)/(tabs)/catalogue.tsx | 155, 1559 | success | ✅ |
| app/(app)/support/index.tsx | 32, 35 | success / error | ✅ |
| app/(app)/marche/[id].tsx | 342, 345, 364, 366 | success / error | ✅ |
| app/(app)/equipe/index.tsx | 254, 260, 272, 288, 644, 1021, 1022 | success / error | ✅ |
| app/(app)/support-inbox/[id].tsx | 80, 97, 118 | error | ✅ |
| app/(app)/depenses/index.tsx | 474, 483, 488 | success / error | ✅ |
| app/(app)/parametres/index.tsx | 235, 295, 298, 365, 650 | success / error | ✅ |
| src/components/ui/ProofControl.tsx | 83, 118 | success | ✅ |
| stores/sales.ts | 244, 265, 291, 304, 380, 397 | error / success | ✅ |

### 3.2 Taps simples (tap / selection ponctuelle) — ✅ conformes

| Fichier | Lignes | Pattern | Verdict |
|---|---|---|---|
| app/(app)/discussions.tsx | 186, 200, 793, 886, 1538 | tap | ✅ (geste utilisateur, non-scroll) |
| app/(app)/(tabs)/index.tsx | 168, 184 | tap | ✅ |
| app/(app)/marche/[id].tsx | 74, 187, 422, 450 | tap | ✅ (74/187 déjà throttlés 300ms) |
| app/(app)/invitations.tsx | 89 | tap | ✅ |
| app/(app)/depenses/index.tsx | 288, 289, 342 | tap / selection | ✅ |
| app/(app)/fournisseurs/reception.tsx | 326 | selection | ✅ |

### 3.3 🔁 À throttler — taps rapides (Vendre, rush)

`haptics.selection()` déclenché par tap d'incrément/décrément de quantité, ajout panier,
pick variant, méthode de paiement. Sous cadence « rush », ces taps s'enchaînent et
produisent du spam haptique. → `throttledSelect()` (800–1000 ms).

| Fichier | Lignes |
|---|---|
| app/(app)/(tabs)/vendre.tsx | 214, 239, 1289, 1307, 1335, 1868, 2147, 2155, 2159, 2298 |

### 3.4 🟡 Pattern sémantique incorrect — `heavy()` → `success()`

`heavy()` n'existe pas dans la spécification §5d. Ces 3 sites sont des **complétions de
vente / fin de parcours** : la taxonomie impose `success()` (notificationAsync Success).

| Fichier | Ligne |
|---|---|
| src/components/VenteRapideCapture.tsx | 91 |
| src/components/CreditRapideCapture.tsx | 230 |
| src/components/FirstRunHeroOverlay.tsx | 178 |

### 3.5 🟡 Actions destructives — `error()` → `destructive()`

§5a : une validation destructrice (suppression / annulation / archivage / révocation)
doit utiliser le pattern « destructive », pas un simple `error()`.

| Fichier | Lignes | Contexte |
|---|---|---|
| app/(app)/parametres/index.tsx | 312, 409, 523 | quitter commerce / supprimer compte / supprimer commerce |
| app/(app)/equipe/index.tsx | 298, 328, 1188 | retirer membre / révoquer code |
| app/(app)/fournisseurs/index.tsx | 630 | supprimer fournisseur |
| app/(app)/ventes/index.tsx | 502 | annuler la vente |
| app/(app)/(tabs)/catalogue.tsx | 1531 | archiver produit |

### 3.6 🔴 Usage brut `expo-haptics` direct — à retirer

| Fichier | Ligne | Problème |
|---|---|---|
| app/(app)/onboarding/carnet.tsx | 12 (import), 64 (call) | `Haptics.impactAsync(Light)` direct → doit passer par `haptics.tap()` |

## 4. Flux critiques SANS haptique actuel (à ajouter en Phase 1, taxonomie §5a)

- **Onboarding / OTP** : `app/(app)/onboarding/index.tsx`, `creer.tsx`, `rejoindre.tsx`,
  `src/components/ui/OtpInput.tsx` — aucun haptique. Ajouter `tap()`/`select()` sur les
  saisies OTP et `success()` à la validation.
- **Alpha** : `app/(app)/alpha/index.tsx` — aucun haptique. Ajouter `tap()` sur envoi,
  `success()`/`warning()` sur résultats.

## 5. Conclusions d'audit

1. **Aucun bump de version** — `performAndroidHapticsAsync` + `AndroidHaptics` déjà présents.
2. **Aucune vibration brute** à supprimer.
3. **Aucun haptique sur scroll / apparition / navigation / sync** — la catégorie
   « à retirer » est vide à l'exception du raw usage carnet.tsx.
4. Corrections Phase 1 : 3 × `heavy()`→`success()` · 1 raw import à éliminer ·
   9 × `error()` destructif → `destructive()` · vendre.tsx rapid-add → `throttledSelect()`.
5. Module cible : étendre [`lib/haptics.ts`](lib/haptics.ts:1) (déjà importé partout via
   `@/lib/haptics`) avec l'API sémantique §5d + branching plateforme + toggle maître.

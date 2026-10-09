# RAPPORT — tranche `okc-37`

**Verdict du manager : VALIDE.** Le lecteur opencode du pont ne savait lire qu'un
store 2.x (`session_v2`/`session_message`) ; sur un store 1.x
(`session`/`message`/`part`, sans `session_v2`) ses requêtes levaient
`no such table`, le chat retombait sur le terminal et l'API rendait
`{"source":"scrollback","turns":[]}`. La tranche ajoute un lecteur 1.x qui adapte
chaque `message` et ses `part` à la forme que `opencodeRecord` comprend déjà, et
route vers lui quand `session_v2` est absent. Les cinq critères de la section 4
sont prouvés à l'exécution, le lecteur 2.x est inchangé, le périmètre est tenu au
fichier. Revue faite seule, code non modifié. Tip revu : `5e43a67`.

## Objet et livrable

Sur la base réelle du patron (opencode 1.18.32, `~/.local/share/opencode/opencode.db`),
la session `ses_edeb86431ffeNINbKVswqfgH5Q` (« TUR-74 : renommer Partager en
Proposer ») n'était pas lisible en mode chat. Le correctif :

- `server/opencode.ts` : `storeFlavor(db)` lit `sqlite_master` et rend `v2`
  (`session_v2`), `v1` (`session` + `message` + `part`) ou `unknown` ;
  `opencodeConversation` (l. 465-466) et `readRow` (l. 556) routent vers les
  fonctions 1.x. Le bloc 1.x (l. 587-799) :
  - `loadSession1` (l. 623-642) : une requête `part` puis une `message`, filtrées
    sur `session_id`, ordonnées `(time_created, id)` ;
  - `adaptMessage1` (l. 656-680) : reconstruit `content[]` depuis les `part`
    (`text`/`reasoning`/`tool`), l'erreur d'outil (chaîne → `{message}`) et
    l'erreur de message (`{name,data.message}` → `{type,message}`) ;
  - `sessionView1` (l. 682-703) : `revert` (undo), comptage et signature du store ;
  - `sessionMetadata1` (l. 705-723) : dernier `modelID` et `tokens` visibles ;
  - `conversation1` (l. 725-782) : pagination par place dans l'ordre des messages,
    mêmes tours que 2.x via `opencodeTurns` ;
  - `sessionRow1` (l. 784-799) : la ligne visible par id, pour
    `opencodeToolOutput`/`opencodeImage`.
- `server/opencode.test.ts` : `SCHEMA_V1` + `storeV1` (l. 61-113) qui fabriquent
  un store 1.x, et le `describe` « an OpenCode 1.x session » (l. 601-670).
- `server/AGENTS.md` : la ligne « Chat-lens transcripts » décrit le routage 1.x.

## Périmètre revu

Base `182ec4e` (HEAD de `main`, 2026-10-09) → tip `5e43a67`.
`git diff --stat main..HEAD` compte **3 fichiers, +347/−5** :

- `server/opencode.ts` (+223/−2)
- `server/opencode.test.ts` (+127/−1)
- `server/AGENTS.md` (+1/−1), documentation de la même ligne

Rien d'autre n'est touché : ni le store réel, ni les autres lecteurs (claude,
codex, pi, omp, omo, gjc, devin), ni `server/conversation.ts` (le routage
`agent === "opencode"` y appelait déjà `opencodeConversation`, aucun changement
n'y était nécessaire), ni le lecteur 2.x. Arbre du worktree propre avant et après
revue (`git status --short` vide).

## Points de contrôle (revue N2, code non modifié)

1. **Critère §4 prouvé par l'exécution.** Voir « Preuves » ci-dessous : test neuf
   (2 tours, premier prompt), échec sans le correctif (4 tests), suite unitaire,
   base réelle, store illisible.
2. **Périmètre §3 respecté.** Le diff ne liste que les trois fichiers ci-dessus.
   `conversation.ts` n'est pas modifié parce que la branche `agent === "opencode"`
   (l. 1154-1160) et l'appel `opencodeConversation` (l. 1281) existaient déjà : le
   correctif vit entièrement dans `opencode.ts`. `server/AGENTS.md` n'est pas un
   ajout de code : sa ligne décrit le lecteur et devenait fausse sans la mise à
   jour (la convention du dépôt veut que ces docs suivent le comportement).
3. **Le correctif est ce qui fait passer les tests.** En neutralisant une seule
   ligne (`if (storeFlavor(db) === "v1") …` → `if (false && …)`) puis en
   restaurant, les 4 tests 1.x passent de `pass` à `fail`
   (`{"kind":"unavailable","reason":"transcript_missing"}`), les 28 autres
   (dont le lecteur 2.x) restent verts.
4. **Convention du dépôt tenue.** Message de commit au format
   `type(scope): summary` ; `bun run typecheck` propre ; `bun run build` OK ;
   import explicites `./…ts`, `pane_id`/`paneId` respectés, aucune écriture dans
   le store (`{ readonly: true, create: false }` + `busy_timeout` conservés) ;
   `forgetOpencodeState` efface bien le cache `answers` utilisé par le 1.x.

## Preuves d'exécution

- **Test neuf, critère §4.1**
  `HERDR_TEST_MODE=unit bun test ./server/opencode.test.ts` →
  `32 pass / 0 fail / 132 expect() calls`. Le `describe` 1.x asserte
  `turns.map(role) == ["user","assistant"]` et le premier prompt `"first prompt"`.
- **Sans le correctif, critère §4.2** (ligne neutralisée, puis restaurée) →
  `28 pass / 4 fail`, les 4 échecs étant les tests 1.x.
- **Suite unitaire, critère §4.3**
  `bun run test:unit` → `2217 pass, 7 skip, 1 fail` sur **2225 tests / 156
  fichiers**. L'unique échec est `server/voice.test.ts` (« Expected
  "audio.webm", Received "clip.webm" »), **préexistant sur `main`** : le même test
  rend `17 pass / 1 fail` sur `182ec4e` sans la tranche. Le lecteur 2.x passe ses
  28 tests ; `bun run typecheck` est muet ; `bun run build` rend
  `✓ built in 3.59s`.
- **Base réelle, critère §4.4.** Store ouvert en **lecture seule**. Contrôle des
  tables : `session`, `message`, `part` présentes, `session_message` présente et
  **vide**, **aucune `session_v2`** (donc `storeFlavor` = `v1`). Puis :

  ```
  bun run /tmp/verify-okc37.ts
  ```

  avec `opencodeDatabasePath()` = `~/.local/share/opencode/opencode.db` et
  `session = "ses_edeb86431ffeNINbKVswqfgH5Q"`, sortie :

  ```json
  { "kind": "page", "turns": 2, "user_turns": 1,
    "history_id": "opencode-ses_edeb86431ffeNINbKVswqfgH5Q", "cursor": null,
    "first_user_text": "Tu es MANAGER de la tranche tur-74, ticket TUR-74 du board Linear (https://linea",
    "model": "deepseek-v4.1-flash" }
  ```

  La base brute de la session compte **41 `message`** (1 `user`, 40 `assistant`)
  et **163 `part`** ; le lecteur replie les 40 étapes en un seul tour assistant,
  d'où **2 tours** au lieu de la liste vide d'avant. Requêtes bornées au
  `session_id` ; aucun `SELECT` ne charge le store (2,4 Go).
- **Store illisible, critère §4.5.** `opencodeConversation` sur un fichier absent
  rend `transcript_missing` ; sur un store dont les tables manquent,
  `storeFlavor` = `unknown`, la branche 2.x lève `no such table`, `unusable()`
  l'attrape et rend `transcript_missing` ; `conversation.ts` en fait
  `ConversationUnavailable`, donc le terminal. Le test « keeps the terminal for
  a session it does not hold, a store whose tables are missing and a missing one »
  le couvre. Aucune exception ne remonte au client.

## Écarts et observations

- **Échec `voice.test.ts` préexistant.** Hors périmètre, identique sur `main` :
  il fait rougir `bun run test:unit` avant comme après la tranche. Signalé, non
  imputable à `okc-37`.
- **Pas de `file` part dans la base réelle** (parts observés : `text`, `tool`,
  `step-start`, `step-finish`, `reasoning`, `patch`) : `adaptMessage1` adapte les
  pièces jointes image des **outils** (`state.attachments`), et pose `files: []`
  pour le message utilisateur. Une image collée dans le **prompt** utilisateur
  (part `file` côté 1.x) ne serait pas reprise ; le cas n'existe pas dans la base
  du patron et n'est pas couvert par un test. Signalé, sans préjuger d'un besoin.
- **`session_message` existe mais reste vide** : le routage regarde `session_v2`
  en premier, donc un store 1.x qui aurait en plus une `session_message` vide
  continue d'être lu par le 1.x — c'est le cas réel.
- **Upstream non poussé (403).** Voir MERGE : `okcedric` n'a pas le droit
  d'écriture sur `devswha/herdr-web-ui`.

## MERGE

- `main` local = `182ec4e` ; branche `okc-37` = `5e43a67` (le chantier), puis
  `6de66ae` (le rapport), committé sur la branche **avant** la fusion.
- Merge `--no-ff` d'`okc-37` dans `main` : **`3dfa8fc`**
  (`merge: le rapport de controle okc-37 rejoint main`), sur le tip `182ec4e` de
  `main`, apportant `5e43a67` et `6de66ae`. Aucun conflit (le chantier ne touche
  que `server/`, le rapport `docs/`).
- Push `main` → `origin` (`github.com/okcedric/herdr-web-ui`) : **OK**,
  `182ec4e..main` — la branche `main` de la copie de travail a été poussée, le
  présent rapport inclus.
- Push `main` → `upstream` (`devswha/herdr-web-ui`) : **refusé, 403** (`Permission
  to devswha/herdr-web-ui.git denied to okcedric`) — `okcedric` n'a pas le droit
  d'écriture sur l'amont. Celui-ci se rejoint par **PR** (voie demandée par le
  ticket, non bloquante), pas par poussée directe ; la doc de l'amont réserve
  d'ailleurs `main` aux PR squashées.
- Aucun commit d'avance conservé sur `okc-37` : `git rev-list --count main..okc-37`
  = **0**.

## Compte rendu
- Objet : en mode chat, herdr web UI lisait un store opencode 2.x (`session_v2`) et renvoyait le terminal pour un store 1.x ; la tranche rend les tours d'un store 1.x.
- Livré : `server/opencode.ts` lit `session`/`message`/`part` quand `session_v2` est absent, adapte chaque message à la forme `opencodeRecord` (tours user/assistant, outils tronqués, images d'outils, erreurs, modèle/usage) ; tests 1.x neufs ; ligne `server/AGENTS.md` à jour.
- Preuve : `bun test ./server/opencode.test.ts` → 32 pass/0 fail ; sans le correctif → 28 pass/4 fail ; `test:unit` → 2217 pass/7 skip/1 fail (le seul échec, `voice.test.ts`, est préexistant sur `main`) ; base réelle `ses_edeb86431ffeNINbKVswqfgH5Q` → 2 tours, 1 user, premier texte « Tu es MANAGER de la tranche tur-74… », là où elle rendait `turns: []`.
- Verdict : VALIDE. Écarts signalés : échec `voice.test.ts` préexistant ; images de prompt utilisateur non reprises (absentes de la base réelle).
- Merge : `--no-ff` **`3dfa8fc`** dans `main` (`182ec4e` → `3dfa8fc`), rapport committé d'abord sur la branche puis absorbé ; branche et worktree conservés. Push `origin` `182ec4e..main` **OK** ; push `upstream` **impossible (403)** — `okcedric` n'a pas le droit d'écriture, l'amont se rejoint par PR (voie non bloquante du ticket).

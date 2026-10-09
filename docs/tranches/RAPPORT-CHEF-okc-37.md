# Rapport chef — tranche `okc-37`

Contrôle du chef, après le verdict **VALIDE** du manager. Ticket
[OKC-37](https://linear.app/okcedric/issue/OKC-37/herdr-web-ui-lire-les-volets-opencode-1x-en-mode-chat)
(OKC / Factory).

## État de la tranche

- Ouvrier `o-okc-37` : commit `5e43a67`, marqueur `.DONE` posé le 2026-10-09 19:14:46.
- Manager `m-okc-37` : verdict VALIDE, rapport `docs/tranches/RAPPORT-okc-37.md`.
- Merge dans `main` : `3dfa8fc` (chantier + rapport), puis `a14c90e` (copie de branche
  du rapport complet). `main` = `0e621ee`, poussé sur `origin`. `git rev-list --count
  main..okc-37` = **0**.
- PR amont [devswha/herdr-web-ui#690](https://github.com/devswha/herdr-web-ui/pull/690)
  (`okcedric:main` → `devswha:main`) : OPEN, MERGEABLE.

## Ce que le chef a vérifié lui-même

1. **Tests ciblés** (worktree, code mergé) : `HERDR_TEST_MODE=unit bun test
   ./server/opencode.test.ts` → **32 pass / 0 fail**.
2. **Suite unitaire du dépôt** : `bun run test:unit` → **2217 pass / 7 skip / 1 fail**.
   L'unique échec, `server/voice.test.ts`, est **préexistant** : sur `182ec4e`
   (avant la tranche) le même fichier rend `17 pass / 1 fail`. La tranche ne touche
   pas `voice.ts`/`voice.test.ts`.
3. **Point 4, base réelle en lecture seule** : `opencodeConversation` sur
   `~/.local/share/opencode/opencode.db`, session `ses_edeb86431ffeNINbKVswqfgH5Q`
   → `kind=page`, **2 tours** (1 user + 1 assistant), premier prompt « Tu es MANAGER
   de la tranche tur-74… », modèle `deepseek-v4.1-flash`, contexte 60402. Avant :
   `turns: []`.
4. **Chat dans le client web** (la preuve qui compte) : correctif posé sur le plugin
   installé, plugin relancé.
   `curl -sS 'http://127.0.0.1:7317/api/pane/conversation?pane_id=w22:p3'`
   → `"source":"opencode-transcript"`, **2 tours** (volet opencode 1.x réel).

## Déploiement sur le plugin installé

- Cible : `~/.config/herdr/plugins/github/devswha.herdr-web-ui-210f619d6b7b`
  (checkout détaché du tag v0.4.3). `server/opencode.ts` remplacé par la version
  mergée (identique au tag hors le correctif) ; sauvegarde
  `/tmp/opencode.ts.v0.4.3.bak`.
- `herdr plugin action invoke stop` puis `start` (devswha.herdr-web-ui) ; port
  `127.0.0.1:7317` de nouveau en écoute, `managed.ts` + `supervisor.ts` relancés.

## Réserve

- Le volet `w1S:p9M` nommé par le brief **n'existe plus dans herdr** (fermé après
  rédaction du brief) : le `curl` dessus rend `{"source":"scrollback","turns":[]}`
  par repli `pane_not_found`, indépendamment du correctif. La session exacte est
  prouvée par le lecteur (point 3) ; la preuve live par un volet opencode 1.x
  (point 4, `w22:p3`).
- Écarts signalés par le manager : images d'un prompt **utilisateur** (`part`
  `file` en 1.x) non reprises, absentes de la base réelle ; échec `voice.test.ts`
  préexistant.

## Reste

- Clôture de la tranche par la chaîne (`finaliser-tranche.sh` / `factory cloture`) —
  **non faite par le chef**, comme prévu.
- Suivi de la PR amont #690, à l'appréciation du mainteneur de `devswha/herdr-web-ui`.

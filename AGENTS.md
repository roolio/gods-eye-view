# Instructions pour les agents (fork roolio)

Ce dépôt est un **fork** de [bilawalsidhu/gods-eye-view](https://github.com/bilawalsidhu/gods-eye-view).
Les règles du projet amont restent valables : lis [CONTRIBUTING.md](CONTRIBUTING.md)
avant de modifier du code. Ce fichier ajoute seulement les règles propres au fork.

## Remotes

| Remote     | Dépôt                           | Rôle                                  |
| ---------- | ------------------------------- | ------------------------------------- |
| `origin`   | `roolio/gods-eye-view`          | Le fork. Toutes les branches et PR vont ici |
| `upstream` | `bilawalsidhu/gods-eye-view`    | Le projet amont. Lecture seule        |

Ne pousse jamais vers `upstream`. N'ouvre une PR vers l'amont que si
l'utilisateur le demande explicitement.

## Modèle de branches

`main` du fork contient **le code amont plus nos ajouts**. Elle n'est pas un
miroir de `upstream/main`.

```
upstream/main ──●──●──●──●──●──●──
                 \           \
origin/main  ─────●───M───────M───   (amont + nos features)
                     /
feat/xxx    ────────●──●
```

1. Chaque travail part de `main` à jour, sur une branche `feat/<sujet>`,
   `fix/<sujet>` ou `chore/<sujet>`.
2. La branche est poussée sur `origin`, puis fusionnée dans `main` par une PR
   **sur le fork** :

   ```bash
   gh pr create --repo roolio/gods-eye-view --base main
   ```

   Sans `--repo`, GitHub propose l'amont comme cible par défaut.

3. Avant la PR : `npm run build`, `npm test`, `npm run format:check` et
   `npm run check:boundaries` doivent passer, comme l'exige CONTRIBUTING.md.

## Récupérer les nouveautés de l'amont

L'amont avance vite (environ 370 commits par semaine en octobre 2026).
Synchronise au moins une fois par semaine et avant de commencer une feature.

```bash
git switch main
git fetch upstream
git merge upstream/main     # merge, jamais de rebase : main est publiée
npm test
git push origin main
```

- Sur `main`, utilise toujours **merge**. Ne rebase pas et ne force pas le push.
- Une feature branch en cours peut intégrer la nouvelle `main` par un merge.
  Un rebase est permis seulement si personne d'autre n'utilise la branche.

## Limiter les conflits avec l'amont

- Préfère les **nouveaux fichiers** (une nouvelle couche dans
  `src/layers/<famille>/`, un nouveau provider dans `server/providers/`) aux
  modifications de fichiers existants.
- Quand un registre partagé doit changer, ajoute des entrées sans réordonner
  ni reformater l'existant. Les registres concernés sont
  `src/layers/bikeshare/registry.js`, `src/data/transitFeeds.js`,
  `src/data/gbfsSource.js`, `src/data/dataCredits.js` et `DATA_SOURCES.md`.
  Leurs conflits se règlent presque toujours en gardant les deux côtés.
- Écris le changelog dans un fragment `changelog.d/<slug>.md`, jamais dans
  `CHANGELOG.md`.
- **Tokens de couche** : une nouvelle couche reçoit un token via
  `npm run layer-token:next -- <layer-id>`. L'amont attribue les mêmes tokens
  dans l'ordre. Si une synchronisation apporte une couche amont qui a pris
  notre token, garde le token amont, retire seulement l'entrée de notre couche,
  relance la commande et mets à jour le nombre de couches attendu dans les
  tests. La procédure détaillée est dans CONTRIBUTING.md (section des tokens).

## Proposer une feature à l'amont (optionnel)

Si une feature mérite d'être proposée à l'amont, ne réutilise pas la branche
du fork, car elle contient l'historique propre au fork. Crée une branche neuve
depuis `upstream/main`, puis reprends les commits avec `git cherry-pick`.
Ouvre la PR seulement avec l'accord de l'utilisateur.

## Écriture

N'utilise jamais le tiret cadratin, ni dans le code, ni dans les commits, ni
dans la documentation.

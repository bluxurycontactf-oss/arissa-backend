# Arissa Backend — Agent Support Client

Backend 100% indépendant pour l'Agent Support Client d'Arissa.
**Aucun appel à un service IA externe (pas de Claude, pas d'OpenAI, etc.)** : toute
"l'intelligence" repose sur un moteur NLP local (normalisation + similarité de
mots-clés) et une base de connaissances stockée dans SQLite, que le fondateur peut
enrichir au fil du temps.

## Fonctionnement

- `src/services/nlp.ts` — normalisation du texte, extraction de mots-clés (français),
  similarité de Jaccard entre deux textes.
- `src/services/knowledgeBase.ts` — base de connaissances (SQLite), seedée au premier
  démarrage avec les questions/réponses fréquentes d'Arissa. `findBestMatch()` trouve
  la meilleure correspondance pour une question donnée.
- `src/services/supportAgent.ts` — logique de l'agent : détecte d'abord les intentions
  spéciales (identité, fondateur, salutations), puis cherche dans la base de
  connaissances, et sinon enregistre la question dans `unanswered_questions` pour que
  le fondateur puisse l'enseigner plus tard.
- `src/routes/support.ts` — `POST /api/support/chat`, `GET /api/support/conversations/:id`
- `src/routes/admin.ts` — gestion de la base de connaissances et des questions sans
  réponse (boucle d'apprentissage) :
  - `GET /api/admin/knowledge`
  - `POST /api/admin/knowledge` `{ question, answer }`
  - `GET /api/admin/unanswered`
  - `POST /api/admin/unanswered/:id/resolve` `{ answer }`
  - `GET /api/admin/stats`

## Reconnaissance du fondateur

Le bot répond aux questions du type "Qui t'a créé ?" / "Qui est ton fondateur ?" en
utilisant les variables d'environnement `FOUNDER_NAME` et `FOUNDER_BIO`.

## Variables d'environnement

Voir `.env.example` :

```
PORT=4000
AGENT_NAME=Arissa
FOUNDER_NAME=Votre nom
FOUNDER_BIO=Une courte présentation du fondateur
```

## Développement local

```bash
npm install
cp .env.example .env   # puis renseignez FOUNDER_NAME / FOUNDER_BIO
npm run dev
```

## Déploiement sur Render

1. Créez un nouveau **Web Service** sur Render, branché sur ce dépôt/dossier.
2. Build Command : `npm install && npm run build`
3. Start Command : `npm start`
4. Ajoutez les variables d'environnement (`PORT` est fourni automatiquement par
   Render, `AGENT_NAME`, `FOUNDER_NAME`, `FOUNDER_BIO`).
5. La base SQLite est stockée dans `data/arissa.db` (créée automatiquement). Pour
   conserver les données entre les déploiements, ajoutez un **Disk** Render monté sur
   le dossier `data/`.

## Connexion au frontend

Dans le frontend Arissa, définissez `NEXT_PUBLIC_SUPPORT_API_URL` avec l'URL publique
de ce backend (ex. `https://arissa-backend.onrender.com`). Par défaut le widget de
chat utilise `http://localhost:4000`.

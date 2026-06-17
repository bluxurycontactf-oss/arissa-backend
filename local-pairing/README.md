# Couplage WhatsApp local pour Arissa

Ce script connecte WhatsApp depuis votre propre ordinateur (au lieu du serveur cloud) puis génère
une chaîne de session à importer dans Arissa. C'est nécessaire car WhatsApp bloque souvent les
connexions venant d'hébergeurs cloud (Render, AWS...) lors d'un premier appairage.

## Utilisation

```bash
cd local-pairing
npm install
npm run pair
```

- Par défaut, un QR code s'affiche dans le terminal : scannez-le avec WhatsApp (Paramètres →
  Appareils connectés → Connecter un appareil).
- Pour utiliser un code d'appairage à la place : `npm run pair -- --pairing-code`

Une fois connecté, le script affiche une longue chaîne de caractères entre
`----- DÉBUT DE LA SESSION -----` et `----- FIN DE LA SESSION -----`. Copiez toute cette chaîne
et collez-la dans Arissa : **Paramètres → WhatsApp → Importer une session**.

Le fichier `session.json` créé localement contient vos identifiants WhatsApp — ne le partagez à
personne et supprimez-le après l'import si vous le souhaitez.

# bridgeWhatsAppTelegram

Bridge bidirectionnel entre des groupes WhatsApp et des topics Telegram.

## Fonctions

- Relai WhatsApp -> Telegram
- Relai Telegram -> WhatsApp
- Support des medias (photo, video, audio, document)
- Mapping configurable groupe WhatsApp -> topic Telegram
- Session WhatsApp persistante

## Prerequis

- Node.js 20+
- Un bot Telegram
- Un supergroupe Telegram avec topics actives
- Un compte WhatsApp deja connecte sur telephone

## Installation

```bash
npm install
cp .env.example .env
```

## Configuration

Exemple minimal dans le fichier .env:

```env
TG_TOKEN=123456789:ABCDEF
TG_GROUP_ID=-1001234567890
WA_GROUP_IDS=120363123456789012@g.us:101,120363987654321098@g.us:102
HEADLESS=true
```

- TG_TOKEN: token du bot Telegram
- TG_GROUP_ID: identifiant du supergroupe Telegram
- WA_GROUP_IDS: liste des correspondances groupe WhatsApp et topic Telegram
  - Format: WA_GROUP_ID:TG_TOPIC_ID
  - Entrees separees par des virgules

## Demarrage

```bash
npm start
```

Au premier lancement, scanner le QR code dans WhatsApp:

WhatsApp > Appareils connectes > Connecter un appareil

## Recuperer les IDs des groupes WhatsApp

Le script affiche automatiquement la liste des groupes detectes au demarrage dans les logs.

## Scripts

- npm start: lance le bridge
- npm run lint: verifie la syntaxe JavaScript

## Deploiement continu avec PM2

```bash
npm install -g pm2
pm2 start src/index.js --name bridge-whatsapp-telegram
pm2 save
pm2 startup
```

## Limites et conformite

- Ce projet utilise WhatsApp Web via whatsapp-web.js (non officiel)
- Respecter les conditions d'utilisation de WhatsApp et Telegram
- Pour un usage personnel, ne pas spammer ni automatiser des envois de masse

## GitHub

Creation du depot distant (a adapter):

```bash
git remote add origin git@github.com:cyrilcaillat/bridgeWhatsAppTelegram.git
git add .
git commit -m "Initial commit"
git push -u origin main
```

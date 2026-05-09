# bridgeWhatsAppTelegram

Bridge bidirectionnel entre des groupes WhatsApp et des topics Telegram.

## Fonctions

- Relai WhatsApp -> Telegram
- Relai Telegram -> WhatsApp
- Relai des reponses a un message (reply) dans les deux sens
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

## Etape 1 - Configurer Telegram

### 1. Creer le bot

1. Ouvrir @BotFather
2. Lancer `/newbot`
3. Choisir le nom et le username du bot
4. Recuperer le token et le conserver pour `TG_TOKEN`

### 2. Autoriser la lecture des messages de groupe

1. Dans @BotFather, ouvrir `/mybots`
2. Selectionner le bot
3. Aller dans `Bot Settings` -> `Group Privacy`
4. Choisir `Turn off`

Option commande directe:

```text
/setprivacy
<choisir le bot>
Disable
```

### 3. Creer et preparer le supergroupe

- Si vous ne voyez pas "Convertir en supergroupe", c'est normal sur les versions recentes: le groupe est deja un supergroupe.
- Activer les topics/sujets dans les parametres du groupe.
- Ajouter le bot dans le supergroupe.
- Donner au bot le droit d'envoyer des messages (admin recommande).

### 4. Trouver `TG_GROUP_ID`

1. Envoyer un message dans le supergroupe
2. Appeler:

```bash
curl -s "https://api.telegram.org/bot<TG_TOKEN>/getUpdates" | jq
```

3. Recuperer `message.chat.id` (souvent un ID negatif qui commence par `-100`)
4. Mettre cette valeur dans `.env` -> `TG_GROUP_ID`

### 5. Trouver les IDs de topics Telegram

1. Envoyer un message dans chaque topic
2. Refaire l'appel `getUpdates`
3. Recuperer `message_thread_id` pour chaque topic
4. Associer ces IDs avec les groupes WhatsApp dans `WA_GROUP_IDS`

## Etape 2 - Configurer les variables .env

Exemple minimal dans le fichier .env:

```env
TG_TOKEN=123456789:ABCDEF
TG_GROUP_ID=-1001234567890
WA_GROUP_IDS=120363123456789012@g.us:101,120363987654321098@g.us:102
HEADLESS=true
LOG_LEVEL=info
```

- `TG_TOKEN` (obligatoire): token du bot Telegram
- `TG_GROUP_ID` (obligatoire): identifiant du supergroupe Telegram
- `WA_GROUP_IDS` (optionnel mais recommande): correspondances groupe WhatsApp -> topic Telegram
  - Format: `WA_GROUP_ID:TG_TOPIC_ID`
  - Entrees separees par des virgules
- `WA_GROUPS_LIST_PATH` (optionnel, defaut `./whatsapp-groups.txt`): chemin du fichier texte maintenu avec la liste des groupes WhatsApp et des topics Telegram detectes
- `WA_GROUPS_LIST_REFRESH_MINUTES` (optionnel, defaut `60`): frequence de mise a jour du fichier. `0` desactive la mise a jour periodique (mise a jour au demarrage uniquement)
- `TG_TO_WA_INCLUDE_PREFIX` (optionnel, defaut `false`): ajoute un prefixe visuel sur les messages Telegram envoyes vers WhatsApp
- `TG_TO_WA_PREFIX` (optionnel, defaut `[Bridge Telegram]`): texte de prefixe utilise quand `TG_TO_WA_INCLUDE_PREFIX=true`
- `TG_TO_WA_INCLUDE_USERNAME` (optionnel, defaut `true`): inclut le nom/profil Telegram dans le message WhatsApp relaye
- `TG_TO_WA_SEND_READ_RECEIPT_ON_ACTIVITY` (optionnel, defaut `false`): envoie un accuse de lecture WhatsApp (`seen`) lorsqu'il y a une activite Telegram dans un topic mappe
- `PUPPETEER_EXECUTABLE_PATH` (optionnel): chemin vers Chrome/Chromium
- `HEADLESS` (optionnel, defaut `true`): execution headless du navigateur WhatsApp Web
- `LOG_LEVEL` (optionnel, defaut `info`): niveau de logs (`error`, `warn`, `info`, `debug`)

## Etape 3 - Premier lancement local et QR code

Lancer:

```bash
npm start
```

Au premier lancement, scanner le QR code affiche dans le terminal:

WhatsApp -> Appareils connectes -> Connecter un appareil

Ensuite, le bridge affiche la liste des groupes detectes.

## Etape 4 - Recuperer les IDs des groupes WhatsApp

Apres connexion WhatsApp, les logs affichent:

```text
Nom du groupe => 120363123456789012@g.us
```

Chaque valeur finissant par `@g.us` est un `WA_GROUP_ID`.

Construire `WA_GROUP_IDS` avec les topics Telegram:

```env
WA_GROUP_IDS=120363123456789012@g.us:101,120363987654321098@g.us:102
```

Le fichier `WA_GROUPS_LIST_PATH` contient aussi une section `Telegram topics` avec les IDs detectes. Pour enrichir cette section, envoyer au moins un message dans chaque topic Telegram.

## Etape 5 - Dependances systeme pour Chromium (Debian/Ubuntu)

Puppeteer/whatsapp-web.js necessite des librairies systeme. Les installer une fois avant le premier lancement:

```bash
sudo apt-get install -y libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
  libpango-1.0-0 libcairo2 libgtk-3-0 libx11-xcb1
```

## Etape 6 - Demarrage en production avec PM2

### Option A - PM2 global (si droits sudo)

```bash
npm install -g pm2
pm2 start src/index.js --name bridge-whatsapp-telegram
pm2 save
pm2 startup
```

### Option B - PM2 en mode utilisateur (sans sudo)

```bash
mkdir -p "$HOME/.local"
npm install -g pm2 --prefix "$HOME/.local"
"$HOME/.local/bin/pm2" start src/index.js --name bridge-whatsapp-telegram
"$HOME/.local/bin/pm2" save
```

### Demarrage automatique au reboot (mode utilisateur, avec sudo)

Pour que PM2 relance le bridge apres un reboot serveur:

```bash
sudo env PATH=$PATH:/home/debian/.local/bin:/usr/local/bin pm2 startup systemd -u debian --hp /home/debian
~/.local/bin/pm2 save
```

Pour desactiver:
```bash
~/.local/bin/pm2 unstartup systemd
```

Commandes utiles (mode utilisateur):

```bash
~/.local/bin/pm2 status
~/.local/bin/pm2 restart bridge-whatsapp-telegram
~/.local/bin/pm2 stop bridge-whatsapp-telegram
~/.local/bin/pm2 logs bridge-whatsapp-telegram --lines 100 --nostream
```

## Etape 7 - Deploiement sur serveur (Debian)

### Premier deploiement

Cloner le depot sur le serveur:

```bash
git clone https://github.com/cyrilcaillat/bridgeWhatsAppTelegram.git /home/debian/bridgeWhatsAppTelegram
cd /home/debian/bridgeWhatsAppTelegram
npm install --omit=dev
```

Creer et remplir le `.env`:

```bash
cp .env.example .env
nano .env
```

Lancer:

```bash
~/.local/bin/pm2 start src/index.js --name bridge-whatsapp-telegram
~/.local/bin/pm2 save
```

### Mise a jour (deploiement continu)

```bash
cd /home/debian/bridgeWhatsAppTelegram
git pull
npm install --omit=dev
~/.local/bin/pm2 restart bridge-whatsapp-telegram --update-env
```

## Troubleshooting

### Le QR code ne s'affiche pas

- Lancer en interactif (`npm start`) plutot qu'en service
- Verifier qu'aucune ancienne session ne bloque
- Si besoin, supprimer `.session` puis relancer

```bash
rm -rf .session
npm start
```

### Erreur "Missing environment variables: TG_TOKEN, TG_GROUP_ID"

- Verifier que le fichier `.env` existe bien au bon emplacement
- Verifier les valeurs `TG_TOKEN` et `TG_GROUP_ID`

### Le bot ne lit pas les messages du groupe

- Verifier `Group Privacy = Turn off` dans BotFather
- Verifier que le bot est dans le supergroupe
- Verifier les droits du bot dans le groupe

### Plusieurs groupes WhatsApp

Utiliser une ligne unique `WA_GROUP_IDS` avec des paires separees par des virgules:

```env
WA_GROUP_IDS=ID_GROUPE_1@g.us:101,ID_GROUPE_2@g.us:102,ID_GROUPE_3@g.us:103
```

## Demarrage

```bash
npm start
```

## Scripts

- npm start: lance le bridge
- npm run lint: verifie la syntaxe JavaScript

## Limites et conformite

- Ce projet utilise WhatsApp Web via whatsapp-web.js (non officiel)
- Respecter les conditions d'utilisation de WhatsApp et Telegram
- Pour un usage personnel, ne pas spammer ni automatiser des envois de masse

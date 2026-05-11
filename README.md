# bridgeWhatsAppTelegram

Bridge bidirectionnel entre des groupes WhatsApp et des topics Telegram.

## Sommaire

- Fonctionnalites
- Prerequis
- Installation rapide
- Configuration Telegram
- Configuration `.env`
- Recuperation des IDs WhatsApp
- Mapping JID WhatsApp -> nom d'affichage
- Lancement local (QR code)
- Production avec PM2
- Deploiement serveur (Debian)
- Troubleshooting
- Scripts
- Limites et conformite

## Fonctionnalites

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

## Installation rapide

```bash
npm install
cp .env.example .env
```

## Configuration Telegram

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

Prerequis: le bridge doit etre lance pour que `getUpdates` remonte bien les messages recents du bot.

Lancer le bridge localement:

```bash
npm start
```

1. Envoyer un message dans chaque topic
2. Refaire l'appel `getUpdates`
3. Recuperer `message_thread_id` pour chaque topic
4. Associer ces IDs avec les groupes WhatsApp dans `WA_GROUP_IDS`

## Configuration `.env`

Exemple minimal:

```env
TG_TOKEN=123456789:ABCDEF
TG_GROUP_ID=-1001234567890
WA_GROUP_IDS=120363123456789012@g.us:101,120363987654321098@g.us:102
HEADLESS=true
LOG_LEVEL=info
```

- `TG_TOKEN` (obligatoire): token du bot Telegram
- `TG_GROUP_ID` (obligatoire): identifiant du supergroupe Telegram
- `TG_API_BASE_URL` (optionnel): URL de base d'un serveur Bot API Telegram local (ex: `http://127.0.0.1:8081`)
- `WA_GROUP_IDS` (optionnel mais recommande): correspondances groupe WhatsApp -> topic Telegram
  - Format: `WA_GROUP_ID:TG_TOPIC_ID`
  - Entrees separees par des virgules
- `BRIDGE_STATE_PATH` (optionnel, defaut `./bridge-state.json`): chemin du fichier d'etat interne
- `MESSAGE_LINK_TTL_MS` (optionnel, defaut `604800000`): duree de conservation des liens de messages WA<->TG
- `PROCESSED_WA_MESSAGE_TTL_MS` (optionnel, defaut `300000`): anti-duplication des evenements WA
- `RECENT_OUTBOUND_TTL_MS` (optionnel, defaut `120000`): fenetre de detection d'echo Telegram->WhatsApp
- `WA_RECONNECT_DELAY_MS` (optionnel, defaut `5000`): delai avant tentative de reconnexion WhatsApp
- `WA_RECONNECT_RETRY_DELAY_MS` (optionnel, defaut `15000`): delai entre deux tentatives de reconnexion
- `WA_BACKFILL_WINDOW_MS` (optionnel, defaut `86400000`): fenetre temporelle de rattrapage WA au demarrage
- `WA_BACKFILL_LIMIT` (optionnel, defaut `500`): nombre max de messages WA charges par groupe pendant le backfill
- `WA_BACKFILL_RETRY_DELAY_MS` (optionnel, defaut `60000`): delai de la deuxieme passe de backfill au demarrage
- `TG_TO_WA_INCLUDE_PREFIX` (optionnel, defaut `false`): ajoute un prefixe visuel sur les messages Telegram envoyes vers WhatsApp
- `TG_TO_WA_PREFIX` (optionnel, defaut `[Bridge Telegram]`): texte de prefixe utilise quand `TG_TO_WA_INCLUDE_PREFIX=true`
- `TG_TO_WA_INCLUDE_USERNAME` (optionnel, defaut `true`): inclut le nom/profil Telegram dans le message WhatsApp relaye
- `TG_TO_WA_SEND_READ_RECEIPT_ON_ACTIVITY` (optionnel, defaut `false`): envoie un accuse de lecture WhatsApp (`seen`) lorsqu'il y a une activite Telegram dans un topic mappe
- `PUPPETEER_EXECUTABLE_PATH` (optionnel): chemin vers Chrome/Chromium
- `HEADLESS` (optionnel, defaut `true`): execution headless du navigateur WhatsApp Web
- `LOG_LEVEL` (optionnel, defaut `info`): niveau de logs (`error`, `warn`, `info`, `debug`)

## Recuperation des IDs WhatsApp

Apres connexion WhatsApp, les logs affichent:

```text
Nom du groupe => 120363123456789012@g.us
```

Chaque valeur finissant par `@g.us` est un `WA_GROUP_ID`.

Construire `WA_GROUP_IDS` avec les topics Telegram:

```env
WA_GROUP_IDS=120363123456789012@g.us:101,120363987654321098@g.us:102
```

La liste des groupes WhatsApp detectes et des topics Telegram est conservee dans `bridge-state.json`.

## Bot API Telegram local (Docker, optionnel)

Utiliser un Bot API local permet surtout de mieux gerer les gros fichiers que l'API cloud peut refuser (erreur 413).
Le compose fourni construit le serveur Bot API depuis le depot officiel Telegram (`tdlib/telegram-bot-api`).

Prerequis:

- Un compte Telegram dev pour obtenir `api_id` et `api_hash` sur `https://my.telegram.org`
- Docker + Docker Compose sur le serveur

Creer un fichier dedie pour Docker (recommande):

```bash
cd docker/telegram-bot-api
cp .env.example .env
nano .env
```

Lancer le service:

```bash
cd docker/telegram-bot-api
docker compose up -d --build
```

Configurer ensuite le bridge (`.env`):

```env
TG_API_BASE_URL=http://127.0.0.1:8081
```

Appliquer le changement:

```bash
~/.local/bin/pm2 restart bridge-whatsapp-telegram --update-env
~/.local/bin/pm2 save
```

## Mapping JID WhatsApp -> nom d'affichage

Quand WhatsApp ne retourne pas de nom de contact dans un groupe, le bridge peut utiliser un mapping dans le fichier d'etat.

Le mapping est stocke dans le meme fichier d'etat que les groupes/messages: `BRIDGE_STATE_PATH` (defaut `./bridge-state.json`), dans la section `waUserMappings`.

Exemple:

```json
{
  "waUserMappings": {
    "33612345678@c.us": "Alice",
    "33698765432@c.us": "Bob"
  }
}
```

Comportement:

- Si un JID n'est pas mappe, le bridge garde le JID brut.
- Si le bridge ne trouve pas de nom pour un JID, il ajoute ce JID dans `waUserMappings` avec la valeur `none`.
- Tant qu'une entree vaut `none`, le bridge affiche le JID brut dans Telegram.
- Vous pouvez ensuite remplacer manuellement `none` par le nom voulu dans `bridge-state.json`.

Commande pour ajouter ou mettre a jour un mapping (JID anonymise):

```bash
ssh debian@YOUR_SERVER '
cd /home/debian/bridgeWhatsAppTelegram &&
JID="YOUR_JID@lid" &&
NAME="Alice" &&
jq --arg jid "$JID" --arg name "$NAME" '"'"'.waUserMappings = (.waUserMappings // {}) | .waUserMappings[$jid] = $name'"'"' \
bridge-state.json > bridge-state.tmp &&
mv bridge-state.tmp bridge-state.json &&
~/.local/bin/pm2 restart bridge-whatsapp-telegram --update-env
'
```

## Lancement local (QR code)

```bash
npm start
```

Au premier lancement, scanner le QR code affiche dans le terminal:

WhatsApp -> Appareils connectes -> Connecter un appareil

Ensuite, le bridge affiche la liste des groupes detectes.

## Dependances systeme pour Chromium (Debian/Ubuntu)

Puppeteer/whatsapp-web.js necessite des librairies systeme. Les installer une fois avant le premier lancement:

```bash
sudo apt-get install -y libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
  libpango-1.0-0 libcairo2 libgtk-3-0 libx11-xcb1
```

## Production avec PM2

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

### Clean Restart du bridge (sans impacter les autres services)

Si le bridge crashe ou redémarre en boucle, un "clean restart" peut résoudre le problème:

```bash
cd /home/debian/bridgeWhatsAppTelegram
~/.local/bin/pm2 delete bridge-whatsapp-telegram
~/.local/bin/pm2 start src/index.js --name bridge-whatsapp-telegram --update-env
~/.local/bin/pm2 save
```

Ce processus:
- Supprime le processus du bridge de la liste PM2
- Redémarre le bridge complètement neuf
- Laisse les autres services intacts

Puis vérifier le statut:

```bash
~/.local/bin/pm2 status bridge-whatsapp-telegram
```

## Deploiement serveur (Debian)

### Premier deploiement

```bash
git clone https://github.com/cyrilcaillat/bridgeWhatsAppTelegram.git /home/debian/bridgeWhatsAppTelegram
cd /home/debian/bridgeWhatsAppTelegram
npm install --omit=dev
cp .env.example .env
nano .env
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

### Afficher le QR code depuis le serveur (PM2)

Si le bridge tourne sur le serveur avec PM2, vous pouvez re-afficher le dernier QR code genere via les logs:

```bash
ssh debian@YOUR_SERVER 'python3 - <<"PY"
from pathlib import Path

p = Path("/home/debian/.pm2/logs/bridge-whatsapp-telegram-out.log")
lines = p.read_text(errors="ignore").splitlines()
marker = "[INFO] Scan the QR code in WhatsApp > Linked devices."
idx = max((i for i, l in enumerate(lines) if marker in l), default=-1)

if idx == -1:
  print("QR introuvable dans les logs.")
  raise SystemExit(0)

qr_chars = set(" ▀▄█")
start = idx - 1
while start >= 0:
  s = lines[start]
  if s == "":
    start -= 1
    continue
  if set(s) <= qr_chars and len(s) >= 20:
    start -= 1
    continue
  break

start += 1
block = [l for l in lines[start:idx] if l.strip() and set(l) <= qr_chars and len(l) >= 20]

if not block:
  print("QR introuvable dans les logs.")
else:
  print("\n".join(block))
PY'
```

Ensuite, scanner ce QR dans WhatsApp: `Appareils lies` -> `Lier un appareil`.

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

## Scripts

- `npm start`: lance le bridge
- `npm run lint`: verifie la syntaxe JavaScript

## Limites et conformite

- Ce projet utilise WhatsApp Web via whatsapp-web.js (non officiel)
- Respecter les conditions d'utilisation de WhatsApp et Telegram
- Pour un usage personnel, ne pas spammer ni automatiser des envois de masse

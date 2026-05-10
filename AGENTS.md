# AGENTS.md

This file is synchronized with .github/copilot-instructions.md.
When updating one, update the other in the same change.

## Purpose

Instructions for coding agents working in this repository.

## Project Context

- Stack: Node.js (CommonJS)
- Entry point: `src/index.js`
- Config loader: `src/config.js`
- Main goal: bidirectional bridge between WhatsApp groups and Telegram topics

## Working Rules

- Keep changes minimal and focused on the user request.
- Preserve existing behavior unless a change is explicitly requested.
- Use ASCII by default.
- Do not add dependencies unless necessary.
- Never hardcode private hostnames, tokens, chat IDs, or phone numbers in docs or code.

## Security Rules

- Never commit secrets from `.env`.
- Never print or store Telegram bot tokens in repository files.
- When sharing commands, use placeholders like `debian@YOUR_SERVER`.

## Validate Before Commit

Run:

```bash
npm run lint
```

Optional runtime check:

```bash
npm start
```

## Deployment Notes

For server updates, use the documented flow in `README.md`:

1. Pull latest code.
2. Install production deps if needed.
3. Restart PM2 process `bridge-whatsapp-telegram`.

If `git pull` is blocked by local server changes, stash first and continue with a fast-forward pull.

## WhatsApp Session Troubleshooting

- If message relay stops, check PM2 logs first.
- If logs show QR prompt, re-link device by scanning the QR code.
- Prefer log-based QR extraction commands documented in `README.md`.

## Commit Style

Use clear conventional-style messages, for example:

- `fix: ...`
- `docs: ...`
- `chore: ...`

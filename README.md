# 🏛️ MCP Judilibre

Serveur MCP (Model Context Protocol) pour l'API **Judilibre** de la Cour de cassation.

Permet à Claude (claude.ai, Claude Desktop, Claude Code) et tout client MCP d'interroger directement la base de jurisprudence open data française.

## Fonctionnalités

| Tool | Description |
|------|-------------|
| `judilibre_search` | Recherche full-text avec filtres (chambre, juridiction, date, thème, solution…) |
| `judilibre_decision` | Texte intégral + métadonnées d'une décision par son ID |
| `judilibre_taxonomy` | Valeurs de taxonomie (chambres, formations, types, thèmes…) |
| `judilibre_export` | Export par lots de décisions complètes |
| `judilibre_stats` | Statistiques de la base (nombre de décisions, dates…) |
| `judilibre_healthcheck` | État de fonctionnement de l'API |
| `judilibre_pourvoi` | Recherche rapide par numéro de pourvoi |

## Prérequis

- **Node.js** ≥ 18
- Un compte **PISTE** avec accès à l'API Judilibre → [piste.gouv.fr](https://piste.gouv.fr)
- Votre `KeyId` (dans votre application PISTE, après enrôlement Judilibre)

## Installation

```bash
git clone https://github.com/VOTRE_USER/mcp-judilibre.git
cd mcp-judilibre
npm install
cp .env.example .env
# Éditez .env avec votre KeyId PISTE
```

## Lancement

```bash
# Développement (auto-reload)
npm run dev

# Production
npm start
```

Le serveur écoute sur `http://0.0.0.0:3001` par défaut.

## Connexion à Claude.ai

Dans les paramètres MCP de Claude.ai, ajoutez un serveur avec l'URL :

```
https://votre-domaine.com/sse
```

Le transport utilisé est **SSE** (Server-Sent Events), compatible avec Claude.ai et Claude Desktop.

## Déploiement Docker (OVH / VPS)

```bash
cp .env.example .env
# Éditez .env

docker compose up -d
```

### Reverse proxy Nginx (recommandé)

```nginx
server {
    listen 443 ssl;
    server_name judilibre-mcp.votre-domaine.com;

    ssl_certificate     /etc/letsencrypt/live/judilibre-mcp.votre-domaine.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/judilibre-mcp.votre-domaine.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_set_header Host $host;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
    }
}
```

Les headers `proxy_buffering off` et `Connection ''` sont essentiels pour le bon fonctionnement du SSE.

## Endpoints

| Route | Méthode | Rôle |
|-------|---------|------|
| `/sse` | GET | Connexion SSE (MCP) |
| `/messages` | POST | Réception des messages JSON-RPC |
| `/health` | GET | Healthcheck |

## Variables d'environnement

| Variable | Description | Défaut |
|----------|-------------|--------|
| `JUDILIBRE_API_KEY` | Votre KeyId PISTE | *(requis)* |
| `JUDILIBRE_ENV` | `sandbox` ou `production` | `production` |
| `PORT` | Port du serveur | `3001` |

## Licence

MIT

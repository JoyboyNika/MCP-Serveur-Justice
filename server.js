const fs = require("fs");
const path = require("path");

// ─── Load .env file (zero dependencies) ─────────────────────
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, "utf8")
    .split("\n")
    .forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const [key, ...rest] = trimmed.split("=");
      if (key && rest.length) {
        process.env[key.trim()] = rest.join("=").trim();
      }
    });
}

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { SSEServerTransport } = require("@modelcontextprotocol/sdk/server/sse.js");
const { createMcpExpressApp } = require("@modelcontextprotocol/sdk/server/express.js");
const z = require("zod/v4");

// ─── Configuration ──────────────────────────────────────────
const PORT = process.env.PORT || 3001;
const JUDILIBRE_API_KEY = process.env.JUDILIBRE_API_KEY;
const JUDILIBRE_ENV = process.env.JUDILIBRE_ENV || "production";

const BASE_URLS = {
  sandbox: "https://sandbox-api.piste.gouv.fr/cassation/judilibre/v1.0",
  production: "https://api.piste.gouv.fr/cassation/judilibre/v1.0",
};

const BASE_URL = BASE_URLS[JUDILIBRE_ENV] || BASE_URLS.production;
const HUDOC_BASE_URL = "https://hudoc.echr.coe.int/app/query/results";

if (!JUDILIBRE_API_KEY) {
  console.error("❌ JUDILIBRE_API_KEY is required. Set it in your .env file.");
  process.exit(1);
}

// ─── Shared annotations ─────────────────────────────────────
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

// ─── Judilibre API Helper ───────────────────────────────────
async function judilibreRequest(endpoint, params = {}) {
  const url = new URL(`${BASE_URL}${endpoint}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      if (Array.isArray(value)) {
        value.forEach((v) => url.searchParams.append(key, v));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  });

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      KeyId: JUDILIBRE_API_KEY,
    },
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(
      `Judilibre API error ${response.status}: ${response.statusText}. ${errorBody}`
    );
  }

  return response.json();
}

// ─── HUDOC API Helper ───────────────────────────────────────
async function hudocRequest(query, options = {}) {
  const {
    sort = "kpdate Descending",
    start = "0",
    length = "20",
  } = options;

  const selectFields = [
    "sharepointid", "itemid", "docname", "doctype", "appno",
    "conclusion", "importance", "originatingbody", "typedescription",
    "kpdate", "kpdateAsText", "documentcollectionid", "languageisocode",
    "extractedappno", "doctypebranch", "respondent", "ecli",
    "appnoparts", "sclappnos",
  ].join(",");

  const url = new URL(HUDOC_BASE_URL);
  url.searchParams.set("query", query);
  url.searchParams.set("select", selectFields);
  url.searchParams.set("sort", sort);
  url.searchParams.set("start", start);
  url.searchParams.set("length", length);
  url.searchParams.set("rankingModelId", "22222222-ffff-0000-0000-000000000000");

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(
      `HUDOC API error ${response.status}: ${response.statusText}. ${errorBody}`
    );
  }

  return response.json();
}

// ─── HUDOC query builder helpers ────────────────────────────
const HUDOC_PREFIX =
  'contentsitename:ECHR AND (NOT (doctype=PR OR doctype=HFCOMOLD OR doctype=HECOMOLD))';

function hudocJudgmentsFilter() {
  return '((documentcollectionid="JUDGMENTS") OR (documentcollectionid="DECISIONS"))';
}

function hudocJudgmentsOnlyFilter() {
  return '((documentcollectionid="JUDGMENTS"))';
}

// ─── MCP Server Factory ────────────────────────────────────
function createServer() {
  const server = new McpServer(
    {
      name: "mcp-justice",
      version: "2.0.0",
    },
    { capabilities: { logging: {} } }
  );

  // ════════════════════════════════════════════════════════════
  // ██  JUDILIBRE TOOLS                                      ██
  // ════════════════════════════════════════════════════════════

  // ── Tool: Recherche ──────────────────────────────────────
  server.registerTool("judilibre_search", {
    title: "Recherche Judilibre",
    description:
      "Recherche full-text dans la base Judilibre (Cour de cassation et juridictions judiciaires). Retourne les décisions correspondant aux critères.",
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: {
      query: z
        .string()
        .describe("Texte de recherche libre (ex: 'responsabilité civile', numéro de pourvoi '21-19.675')"),
      operator: z
        .enum(["or", "and", "exact"])
        .default("or")
        .describe("Opérateur logique: 'or' (défaut), 'and', ou 'exact' (expression exacte)"),
      field: z
        .array(z.string())
        .optional()
        .describe("Zones ciblées: 'text', 'expose', 'moyens', 'motivations', 'dispositif', 'sommaire', 'titrage'"),
      type: z
        .array(z.string())
        .optional()
        .describe("Type de décision (ex: 'arret', 'avis', 'ordonnance', 'qpc', 'saisine')"),
      theme: z
        .array(z.string())
        .optional()
        .describe("Thème(s) — utiliser /taxonomy pour lister les valeurs possibles"),
      chamber: z
        .array(z.string())
        .optional()
        .describe("Chambre(s) (ex: 'soc', 'crim', 'comm', 'civ1', 'civ2', 'civ3', 'pl', 'mi', 'allciv', 'ordo')"),
      formation: z
        .array(z.string())
        .optional()
        .describe("Formation(s) (ex: 'fp', 'fs', 'fm', 'f')"),
      jurisdiction: z
        .array(z.string())
        .optional()
        .describe("Juridiction(s) (ex: 'cc' pour Cour de cassation, 'ca' pour cours d'appel)"),
      publication: z
        .array(z.string())
        .optional()
        .describe("Niveau de publication (ex: 'b', 'r', 'l', 'c', 'n')"),
      solution: z
        .array(z.string())
        .optional()
        .describe("Type de solution (ex: 'rejet', 'cassation', 'annulation', 'irrecevabilite')"),
      date_start: z
        .string()
        .optional()
        .describe("Date de début (format YYYY-MM-DD)"),
      date_end: z
        .string()
        .optional()
        .describe("Date de fin (format YYYY-MM-DD)"),
      sort: z
        .enum(["score", "date"])
        .default("score")
        .describe("Tri: 'score' (pertinence, défaut) ou 'date'"),
      order: z
        .enum(["asc", "desc"])
        .default("desc")
        .describe("Ordre: 'desc' (défaut) ou 'asc'"),
      page: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("Numéro de page (commence à 0)"),
      page_size: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe("Nombre de résultats par page (max 50)"),
    },
  }, async (params) => {
    try {
      const data = await judilibreRequest("/search", params);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Erreur: ${error.message}` }],
        isError: true,
      };
    }
  });

  // ── Tool: Décision ───────────────────────────────────────
  server.registerTool("judilibre_decision", {
    title: "Décision Judilibre",
    description:
      "Récupère le texte intégral et les métadonnées d'une décision par son identifiant Judilibre.",
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: {
      id: z.string().describe("Identifiant unique de la décision (ex: '667e51a56430c94f3afa7d0e')"),
    },
  }, async ({ id }) => {
    try {
      const data = await judilibreRequest("/decision", { id });
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Erreur: ${error.message}` }],
        isError: true,
      };
    }
  });

  // ── Tool: Taxonomie ──────────────────────────────────────
  server.registerTool("judilibre_taxonomy", {
    title: "Taxonomie Judilibre",
    description:
      "Récupère les valeurs de taxonomie (listes de chambres, juridictions, formations, types, publications, solutions, thèmes, zones). Utile pour connaître les filtres disponibles.",
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: {
      id: z
        .enum([
          "chamber", "formation", "jurisdiction", "type",
          "publication", "solution", "theme", "field", "location",
        ])
        .describe("Type de taxonomie à récupérer"),
    },
  }, async ({ id }) => {
    try {
      const data = await judilibreRequest("/taxonomy", { id });
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Erreur: ${error.message}` }],
        isError: true,
      };
    }
  });

  // ── Tool: Export ─────────────────────────────────────────
  server.registerTool("judilibre_export", {
    title: "Export Judilibre",
    description:
      "Export par lots de décisions complètes, utile pour récupérer de nombreuses décisions. Attention aux quotas API.",
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: {
      batch_size: z.number().int().min(1).max(1000).default(100)
        .describe("Nombre de décisions par lot (max 1000)"),
      batch: z.number().int().min(0).default(0)
        .describe("Index du lot (pagination)"),
      type: z.string().optional().describe("Type de décision"),
      chamber: z.string().optional().describe("Chambre"),
      jurisdiction: z.string().optional().describe("Juridiction"),
      date_start: z.string().optional().describe("Date de début (YYYY-MM-DD)"),
      date_end: z.string().optional().describe("Date de fin (YYYY-MM-DD)"),
    },
  }, async (params) => {
    try {
      const data = await judilibreRequest("/export", params);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Erreur: ${error.message}` }],
        isError: true,
      };
    }
  });

  // ── Tool: Stats ──────────────────────────────────────────
  server.registerTool("judilibre_stats", {
    title: "Statistiques Judilibre",
    description:
      "Récupère les statistiques d'utilisation et d'état de la base Judilibre (nombre de décisions indexées, requêtes, dates).",
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: {},
  }, async () => {
    try {
      const data = await judilibreRequest("/stats");
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Erreur: ${error.message}` }],
        isError: true,
      };
    }
  });

  // ── Tool: Healthcheck ────────────────────────────────────
  server.registerTool("judilibre_healthcheck", {
    title: "Healthcheck Judilibre",
    description: "Vérifie l'état de fonctionnement de l'API Judilibre.",
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: {},
  }, async () => {
    try {
      const data = await judilibreRequest("/healthcheck");
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Erreur: ${error.message}` }],
        isError: true,
      };
    }
  });

  // ── Tool: Recherche par numéro de pourvoi ────────────────
  // BUG FIX: removed field: ["numero"] — not accepted by API
  server.registerTool("judilibre_pourvoi", {
    title: "Vérification de pourvoi",
    description:
      "Recherche rapide d'une décision par son numéro de pourvoi (ex: '21-19.675'). Raccourci pratique.",
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: {
      numero: z.string().describe("Numéro de pourvoi (ex: '21-19.675')"),
    },
  }, async ({ numero }) => {
    try {
      const data = await judilibreRequest("/search", {
        query: numero,
        operator: "exact",
        page_size: 5,
        resolve_references: true,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Erreur: ${error.message}` }],
        isError: true,
      };
    }
  });

  // ════════════════════════════════════════════════════════════
  // ██  HUDOC / CEDH TOOLS                                   ██
  // ════════════════════════════════════════════════════════════

  // ── Tool: Recherche HUDOC (query brute) ──────────────────
  server.registerTool("hudoc_search", {
    title: "Recherche HUDOC CEDH",
    description:
      "Recherche dans la base HUDOC de la Cour européenne des droits de l'homme. Accepte une requête brute HUDOC (query syntax). Retourne: itemid, docname, appno, conclusion, kpdate, respondent, ecli, importance. API publique, pas d'authentification.",
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: {
      hudoc_query: z.string().describe(
        'Requête HUDOC brute. Ex: contentsitename:ECHR AND (NOT (doctype=PR OR doctype=HFCOMOLD OR doctype=HECOMOLD)) AND "article 3" AND ((documentcollectionid="JUDGMENTS"))'
      ),
      sort: z.string().default("kpdate Descending")
        .describe("Tri. Défaut: kpdate Descending. Alternatives: Rank Descending, ECHRRanking Ascending"),
      start: z.string().default("0")
        .describe("Offset pagination (défaut 0)"),
      length: z.string().default("20")
        .describe("Nombre de résultats (défaut 20, max 500)"),
    },
  }, async ({ hudoc_query, sort, start, length }) => {
    try {
      const data = await hudocRequest(hudoc_query, { sort, start, length });
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Erreur HUDOC: ${error.message}` }],
        isError: true,
      };
    }
  });

  // ── Tool: Recherche HUDOC par numéro de requête ──────────
  server.registerTool("hudoc_appno", {
    title: "HUDOC — Recherche par n° de requête",
    description:
      "Recherche une affaire CEDH par son numéro de requête (ex: '36391/02' pour Salduz c. Turquie). Retourne arrêts et décisions dans toutes les langues disponibles.",
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: {
      appno: z.string().describe("Numéro de requête CEDH (ex: '36391/02', '25803/94')"),
      judgments_only: z.boolean().default(true)
        .describe("true = arrêts uniquement, false = arrêts + décisions"),
      length: z.string().default("10")
        .describe("Nombre de résultats (défaut 10)"),
    },
  }, async ({ appno, judgments_only, length }) => {
    try {
      const encoded = appno.replace(/"/g, "%22");
      const collFilter = judgments_only
        ? hudocJudgmentsOnlyFilter()
        : hudocJudgmentsFilter();
      const query = `${HUDOC_PREFIX} AND ((appno:"${encoded}")) AND ${collFilter}`;
      const data = await hudocRequest(query, { length });
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Erreur HUDOC: ${error.message}` }],
        isError: true,
      };
    }
  });

  // ── Tool: Recherche HUDOC par article CEDH ───────────────
  server.registerTool("hudoc_article", {
    title: "HUDOC — Recherche par article CEDH",
    description:
      "Recherche les arrêts CEDH portant sur un article spécifique de la Convention (ex: 'article 3', 'article 6', 'article 8'). Permet de filtrer par État défendeur et par date.",
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: {
      article: z.string().describe("Article de la Convention (ex: 'article 3', 'article 6-1', 'article 8')"),
      respondent: z.string().optional()
        .describe("Code ISO de l'État défendeur (ex: 'FRA', 'RUS', 'TUR', 'ITA', 'GBR')"),
      date_start: z.string().optional()
        .describe("Date de début ISO (ex: '2024-01-01T00:00:00.0Z')"),
      length: z.string().default("20")
        .describe("Nombre de résultats (défaut 20)"),
    },
  }, async ({ article, respondent, date_start, length }) => {
    try {
      let query = `${HUDOC_PREFIX} AND "${article}" AND ${hudocJudgmentsOnlyFilter()}`;
      if (respondent) {
        query += ` AND ((respondent="${respondent}"))`;
      }
      if (date_start) {
        query += ` AND ((kpdate>="${date_start}"))`;
      }
      const data = await hudocRequest(query, { length });
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Erreur HUDOC: ${error.message}` }],
        isError: true,
      };
    }
  });

  // ── Tool: Recherche HUDOC par État défendeur ─────────────
  server.registerTool("hudoc_state", {
    title: "HUDOC — Recherche par État défendeur",
    description:
      "Recherche les arrêts CEDH rendus contre un État spécifique. Permet de filtrer par date pour obtenir les arrêts récents. Codes: FRA (France), RUS (Russie), TUR (Turquie), ITA (Italie), GBR (Royaume-Uni), DEU (Allemagne), etc.",
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: {
      respondent: z.string().describe("Code ISO 3 lettres de l'État défendeur (ex: 'FRA', 'TUR', 'RUS')"),
      date_start: z.string().optional()
        .describe("Date de début ISO (ex: '2025-01-01T00:00:00.0Z')"),
      date_end: z.string().optional()
        .describe("Date de fin ISO (ex: '2025-12-31T00:00:00.0Z')"),
      sort: z.string().default("kpdate Descending")
        .describe("Tri (défaut: kpdate Descending)"),
      length: z.string().default("20")
        .describe("Nombre de résultats (défaut 20)"),
    },
  }, async ({ respondent, date_start, date_end, sort, length }) => {
    try {
      let query = `${HUDOC_PREFIX} AND ((respondent="${respondent}")) AND ${hudocJudgmentsOnlyFilter()}`;
      if (date_start) {
        query += ` AND ((kpdate>="${date_start}"))`;
      }
      if (date_end) {
        query += ` AND ((kpdate<="${date_end}"))`;
      }
      const data = await hudocRequest(query, { sort, length });
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Erreur HUDOC: ${error.message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// ─── Express App + SSE Transport ───────────────────────────
const app = createMcpExpressApp({ host: "0.0.0.0" });
const transports = {};

// SSE endpoint — Claude.ai connects here
app.get("/sse", async (req, res) => {
  console.log(`[${new Date().toISOString()}] New SSE connection`);
  try {
    const transport = new SSEServerTransport("/messages", res);
    const sessionId = transport.sessionId;
    transports[sessionId] = transport;

    transport.onclose = () => {
      console.log(`[${new Date().toISOString()}] Session closed: ${sessionId}`);
      delete transports[sessionId];
    };

    const server = createServer();
    await server.connect(transport);
    console.log(`[${new Date().toISOString()}] Session established: ${sessionId}`);
  } catch (error) {
    console.error("Error establishing SSE stream:", error);
    if (!res.headersSent) {
      res.status(500).send("Error establishing SSE stream");
    }
  }
});

// Messages endpoint — receives JSON-RPC from Claude
app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId) {
    return res.status(400).json({ error: "Missing sessionId" });
  }

  const transport = transports[sessionId];
  if (!transport) {
    return res.status(404).json({ error: "Session not found" });
  }

  try {
    await transport.handlePostMessage(req, res, req.body);
  } catch (error) {
    console.error("Error handling message:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal error" });
    }
  }
});

// Simple health endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    sessions: Object.keys(transports).length,
    env: JUDILIBRE_ENV,
    uptime: process.uptime(),
    tools: {
      judilibre: 7,
      hudoc: 4,
      total: 11,
    },
  });
});

// ─── Start ─────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", (error) => {
  if (error) {
    console.error("Failed to start:", error);
    process.exit(1);
  }
  console.log(`
╔══════════════════════════════════════════════════╗
║       ⚖️  MCP Justice Server v2.0.0              ║
╠══════════════════════════════════════════════════╣
║  Port:        ${String(PORT).padEnd(35)}║
║  Env:         ${JUDILIBRE_ENV.padEnd(35)}║
║  Judilibre:   7 tools (search, decision, ...)   ║
║  HUDOC CEDH:  4 tools (search, appno, ...)      ║
║  Annotations: readOnlyHint=true (parallel OK)   ║
║  SSE:         http://0.0.0.0:${PORT}/sse${" ".repeat(Math.max(0, 22 - String(PORT).length))}║
║  Health:      http://0.0.0.0:${PORT}/health${" ".repeat(Math.max(0, 19 - String(PORT).length))}║
╚══════════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  for (const sessionId in transports) {
    try {
      await transports[sessionId].close();
      delete transports[sessionId];
    } catch (e) {
      /* ignore */
    }
  }
  process.exit(0);
});

process.on("SIGTERM", async () => {
  for (const sessionId in transports) {
    try {
      await transports[sessionId].close();
    } catch (e) {
      /* ignore */
    }
  }
  process.exit(0);
});

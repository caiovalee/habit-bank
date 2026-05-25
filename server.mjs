import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const envFromFile = await loadEnvFile(path.join(__dirname, ".env"));
const env = { ...envFromFile, ...process.env };

const PORT = Number(env.PORT || 8787);
const NOTION_VERSION = env.NOTION_VERSION || "2026-03-11";
const NOTION_TOKEN = env.NOTION_TOKEN || "";
const CENTRAL_PAGE_ID = env.NOTION_CENTRAL_PAGE_ID || "2e9de275ea738050a3b7d4950d4f195d";
const SYNC_ROOT_PAGE_TITLE = env.NOTION_SYNC_ROOT_PAGE_TITLE || "Habit Bank Sync";
const SPRINT_PAGE_TITLE = env.NOTION_SPRINT_PAGE_TITLE || "Sprint Sync";
const COFRINHO_PAGE_TITLE = env.NOTION_COFRINHO_PAGE_TITLE || "Cofrinho Sync";

const server = http.createServer(async (req, res) => {
  try {
    addCors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return serveFile(res, "index.html", "text/html; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/habitbank.html") {
      return serveFile(res, "habitbank.html", "text/html; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/sprint.html") {
      return serveFile(res, "sprint.html", "text/html; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/warehouse.html") {
      return serveFile(res, "warehouse.html", "text/html; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/english.html") {
      return serveFile(res, "english.html", "text/html; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/api/notion/health") {
      return json(res, 200, {
        ok: true,
        server: "habit-bank",
        notionConfigured: Boolean(NOTION_TOKEN),
        centralPageId: CENTRAL_PAGE_ID,
        notionVersion: NOTION_VERSION
      });
    }
    if (req.method === "POST" && url.pathname === "/api/notion/sprint/sync") {
      assertConfig();
      const body = await readJson(req);
      const state = body?.state;
      if (!state || !Array.isArray(state.sprints)) {
        throw httpError(400, "Payload inválido: envie { state } com sprints.");
      }
      const nextState = await syncSprintState(structuredClone(state));
      return json(res, 200, {
        ok: true,
        summary: buildSprintSummary(nextState),
        state: nextState
      });
    }
    if (req.method === "POST" && url.pathname === "/api/notion/cofrinho/sync") {
      assertConfig();
      const body = await readJson(req);
      const state = body?.state;
      if (!state || typeof state !== "object") {
        throw httpError(400, "Payload inválido: envie { state } com os dados do cofrinho.");
      }
      const result = await syncCofrinhoState(structuredClone(state));
      return json(res, 200, {
        ok: true,
        state: result.state,
        page: result.page
      });
    }

    json(res, 404, { ok: false, error: "Rota não encontrada." });
  } catch (error) {
    const status = error.statusCode || 500;
    json(res, status, {
      ok: false,
      error: error.message || "Erro interno no servidor."
    });
  }
});

server.listen(PORT, () => {
  console.log(`Habit Bank server running at http://localhost:${PORT}`);
});

async function serveFile(res, relativePath, contentType) {
  const filePath = path.join(__dirname, relativePath);
  const content = await readFile(filePath);
  res.writeHead(200, { "Content-Type": contentType });
  res.end(content);
}

function addCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError(400, "JSON inválido no corpo da requisição.");
  }
}

async function loadEnvFile(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    const vars = {};
    raw.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const idx = trimmed.indexOf("=");
      if (idx < 0) return;
      const key = trimmed.slice(0, idx).trim();
      let value = trimmed.slice(idx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      vars[key] = value;
    });
    return vars;
  } catch {
    return {};
  }
}

function assertConfig() {
  if (!NOTION_TOKEN) {
    throw httpError(500, "Configure NOTION_TOKEN no arquivo .env antes de sincronizar.");
  }
}

async function notionFetch(method, apiPath, body) {
  const response = await fetch(`https://api.notion.com${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (!response.ok) {
    let details = "";
    try {
      const err = await response.json();
      details = err?.message || JSON.stringify(err);
    } catch {
      details = await response.text();
    }
    throw httpError(response.status, `Notion API ${method} ${apiPath}: ${details || response.statusText}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

async function createPage(parent, properties) {
  return notionFetch("POST", "/v1/pages", { parent, properties });
}

async function searchPagesByTitle(query) {
  const result = await notionFetch("POST", "/v1/search", {
    query,
    page_size: 50,
    filter: { property: "object", value: "page" }
  });
  return result.results || [];
}

async function appendBlocks(blockId, children) {
  if (!children.length) return null;
  return notionFetch("PATCH", `/v1/blocks/${blockId}/children`, { children });
}

function titleProp(content) {
  return {
    title: [{ type: "text", text: { content: truncate(content, 2000) } }]
  };
}

function richTextProp(content) {
  if (!content) return { rich_text: [] };
  return {
    rich_text: [{ type: "text", text: { content: truncate(content, 2000) } }]
  };
}

function numberProp(value) {
  return { number: Number.isFinite(value) ? value : 0 };
}

function selectProp(name) {
  return name ? { select: { name } } : { select: null };
}

function dateProp(start, end) {
  if (!start) return { date: null };
  const date = { start };
  if (end) date.end = end;
  return { date };
}

function relationProp(ids) {
  return { relation: ids.filter(Boolean).map((id) => ({ id })) };
}

function truncate(value, max) {
  const str = String(value ?? "");
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

function slugify(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function mapTaskStatus(status) {
  if (status === "doing") return "Fazendo";
  if (status === "done") return "Feito";
  if (status === "notdone") return "Não Entregue/Cancelado";
  return "A Fazer";
}

async function syncSprintState(state) {
  const sprintPage = await ensureNamedChildPage(await ensureSyncRootPage(), SPRINT_PAGE_TITLE);
  const snapshotTitle = `Sprint Snapshot ${new Date().toLocaleDateString("pt-BR")} ${new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
  const snapshot = await createPage(
    { page_id: sprintPage.id },
    { title: titleProp(snapshotTitle) }
  );
  await appendBlocks(snapshot.id, buildSprintBlocks(state));
  state.notionSprintPageId = sprintPage.id;
  state.notionSprintPageUrl = sprintPage.url;
  state.notionLastSprintSnapshotId = snapshot.id;
  state.notionLastSprintSnapshotUrl = snapshot.url;
  return state;
}

function buildSprintSummary(state) {
  const sprints = state.sprints.length;
  const epics = state.sprints.reduce((count, sprint) => count + (sprint.epics || []).length, 0);
  const tasks = state.sprints.reduce((count, sprint) => count + (sprint.tasks || []).length, 0);
  return { sprints, epics, tasks };
}

async function syncCofrinhoState(state) {
  const page = await ensureNamedChildPage(await ensureSyncRootPage(), COFRINHO_PAGE_TITLE);
  const blocks = buildCofrinhoBlocks(state);
  await appendBlocks(page.id, blocks);
  state.notionSummaryPageId = page.id;
  state.notionSummaryPageUrl = page.url;
  return {
    state,
    page: { id: page.id, url: page.url, title: COFRINHO_PAGE_TITLE }
  };
}

async function ensureSyncRootPage() {
  return ensureNamedChildPage({ id: CENTRAL_PAGE_ID }, SYNC_ROOT_PAGE_TITLE);
}

async function ensureNamedChildPage(parentPage, title) {
  const matches = await searchPagesByTitle(title);
  const match = matches.find((page) => {
    const pageTitle = extractPageTitle(page);
    return pageTitle === title && page.parent?.type === "page_id" && stripDashes(page.parent.page_id) === stripDashes(parentPage.id);
  });
  if (match) return match;
  return createPage(
    { page_id: parentPage.id },
    { title: titleProp(title) }
  );
}

function buildSprintBlocks(state) {
  const blocks = [
    heading2Block("Resumo da sincronização"),
    paragraphBlock(`Sprints: ${state.sprints.length} · Epics: ${state.sprints.reduce((n, s) => n + (s.epics || []).length, 0)} · Tarefas: ${state.sprints.reduce((n, s) => n + (s.tasks || []).length, 0)}`),
    dividerBlock()
  ];

  state.sprints.forEach((sprint) => {
    const tasks = Array.isArray(sprint.tasks) ? sprint.tasks : [];
    const epics = Array.isArray(sprint.epics) ? sprint.epics : [];
    const totalPoints = tasks.reduce((sum, task) => sum + (Number(task.points) || 0), 0);
    const deliveredPoints = tasks.filter((task) => task.status === "done").reduce((sum, task) => sum + (Number(task.points) || 0), 0);
    blocks.push(heading2Block(sprint.name || "Sprint"));
    blocks.push(paragraphBlock(`Período: ${sprint.start || "sem início"} → ${sprint.end || "sem fim"} · ${deliveredPoints}/${totalPoints} pts entregues`));

    if (epics.length) {
      blocks.push(heading3Block("Epics"));
      epics.forEach((epic) => {
        const epicTasks = tasks.filter((task) => task.epicId === epic.id);
        blocks.push(bulletedListItemBlock(`${epic.name} · ${epicTasks.length} tarefas`));
      });
    }

    if (tasks.length) {
      blocks.push(heading3Block("Tarefas"));
      tasks.forEach((task) => {
        const epic = epics.find((item) => item.id === task.epicId);
        const tags = Array.isArray(task.tags) && task.tags.length ? ` · tags: ${task.tags.join(", ")}` : "";
        const notes = task.notes ? ` · ${truncate(task.notes.replace(/\s+/g, " ").trim(), 120)}` : "";
        blocks.push(
          bulletedListItemBlock(
            `${task.title} · ${mapTaskStatus(task.status)} · ${Number(task.points) || 0} pts${epic ? ` · épico: ${epic.name}` : ""}${tags}${notes}`
          )
        );
      });
    }

    blocks.push(dividerBlock());
  });

  return blocks.slice(0, 95);
}

function buildCofrinhoBlocks(state) {
  const now = new Date();
  const debt = state.debt || {};
  const debtTotal = toMoney((debt.principal || 0) + (debt.interest || 0));
  const recent = Array.isArray(state.transactions) ? state.transactions.slice(0, 8) : [];
  const blocks = [
    heading2Block(`Snapshot ${now.toLocaleDateString("pt-BR")} ${now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`),
    paragraphBlock(
      `Saldo atual: R$${fmtMoney(toMoney(state.balance || 0))} · dívida total: R$${fmtMoney(debtTotal)} · juros do saldo: 0,038%/dia · juros da dívida: 0,46%/dia`
    ),
    bulletedListItemBlock(`Principal da dívida: R$${fmtMoney(toMoney(debt.principal || 0))}`),
    bulletedListItemBlock(`Juros acumulados: R$${fmtMoney(toMoney(debt.interest || 0))}`),
    bulletedListItemBlock(`Valor original da dívida: R$${fmtMoney(toMoney(debt.original || 0))}`),
    bulletedListItemBlock(`Movimentações registradas: ${(state.transactions || []).length}`),
    dividerBlock()
  ];

  if (recent.length) {
    blocks.push(heading3Block("Últimas movimentações"));
    recent.forEach((tx) => {
      const signal = Number(tx.amount) >= 0 ? "+" : "-";
      const label = `${tx.date || "sem data"} · ${tx.label || "movimentação"} · ${signal}R$${fmtMoney(Math.abs(Number(tx.amount) || 0))}`;
      blocks.push(bulletedListItemBlock(label));
    });
    blocks.push(dividerBlock());
  }

  return blocks.slice(0, 95);
}

function extractPageTitle(page) {
  const titlePropValue = Object.values(page.properties || {}).find((prop) => prop.type === "title");
  if (!titlePropValue?.title) return "";
  return titlePropValue.title.map((item) => item.plain_text || "").join("");
}

function stripDashes(value) {
  return String(value || "").replace(/-/g, "");
}

function heading2Block(content) {
  return {
    object: "block",
    type: "heading_2",
    heading_2: {
      rich_text: [{ type: "text", text: { content: truncate(content, 2000) } }]
    }
  };
}

function heading3Block(content) {
  return {
    object: "block",
    type: "heading_3",
    heading_3: {
      rich_text: [{ type: "text", text: { content: truncate(content, 2000) } }]
    }
  };
}

function paragraphBlock(content) {
  return {
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: [{ type: "text", text: { content: truncate(content, 2000) } }]
    }
  };
}

function bulletedListItemBlock(content) {
  return {
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: {
      rich_text: [{ type: "text", text: { content: truncate(content, 2000) } }]
    }
  };
}

function dividerBlock() {
  return { object: "block", type: "divider", divider: {} };
}

function fmtMoney(value) {
  return Number(value || 0).toFixed(2).replace(".", ",");
}

function toMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

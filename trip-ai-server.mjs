import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

await loadLocalEnv(join(__dirname, ".env.local"));

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "0.0.0.0";
const apiKey = process.env.VOLCENGINE_API_KEY || process.env.ARK_API_KEY || "";
const model = process.env.ARK_MODEL || process.env.VOLCENGINE_MODEL || "ep-m-20260604202245-c2cq2";
const baseUrl = (process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3").replace(/\/$/, "");
const arkTimeoutMs = Number(process.env.ARK_TIMEOUT_MS || 90000);
const dataFile = process.env.DATA_FILE || join(__dirname, "trip-state.json");
const defaultTripId = process.env.DEFAULT_TRIP_ID || "australia-2026";
const larkOpenApiBase = (process.env.LARK_OPENAPI_BASE_URL || "https://open.larksuite.com/open-apis").replace(/\/$/, "");
const larkAppId = process.env.LARK_APP_ID || "";
const larkAppSecret = process.env.LARK_APP_SECRET || "";
const larkBaseToken = process.env.LARK_BASE_TOKEN || "";
const larkTripsTableId = process.env.LARK_TRIPS_TABLE_ID || "";
const larkVersionsTableId = process.env.LARK_VERSIONS_TABLE_ID || "tblozOB1lmp93z5S";
const larkEnabled = Boolean(larkAppId && larkAppSecret && larkBaseToken && larkTripsTableId);
const larkVersionsEnabled = Boolean(larkEnabled && larkVersionsTableId);
const storageVersion = "lark-upsert-v3";
const agentPromptTemplate = await loadAgentPrompt(join(__dirname, "agent-prompt.md"));
let cachedLarkToken = null;
let cachedLarkTokenExpiresAt = 0;

async function loadLocalEnv(filePath) {
  try {
    const text = await readFile(filePath, "utf8");
    text.split(/\r?\n/).forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex < 0) return;
      const key = trimmed.slice(0, separatorIndex).trim();
      let value = trimmed.slice(separatorIndex + 1).trim();
      if (!key || process.env[key]) return;
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    });
  } catch {
    // Local env files are optional; deployment platforms should use real env vars.
  }
}

async function loadAgentPrompt(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return [
      "你是一个严谨、专业、现实主义的旅行计划 Agent，不是简单旅游文案生成器。",
      "必须用中文回答。",
      "必须优先保证往返日期、城市顺序、航班/交通时间锚点不被随意改动。",
      "{{FIXED_ORDER_INSTRUCTION}}",
      "{{PLACE_ID_INSTRUCTION}}",
      "必须严格遵守时间窗：17:00 以后抵达城市，当天不能再安排下午游玩，只能安排入住、晚餐或休息。",
      "只返回 JSON，不要返回 Markdown，不要使用代码块。",
      "JSON 格式必须是：{ summary: string, agentReport: AgentReport, changes: string[], updatedPlaces: Place[] }。"
    ].join("\n");
  }
}

function renderAgentPrompt(template, replacements) {
  return String(template || "")
    .replaceAll("{{FIXED_ORDER_INSTRUCTION}}", replacements.fixedOrderInstruction || "")
    .replaceAll("{{PLACE_ID_INSTRUCTION}}", replacements.placeIdInstruction || "");
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png"
};

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS"
  });
  response.end(JSON.stringify(payload));
}

function createId(prefix = "trip") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createShareKey() {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function createDefaultState() {
  return {
    ideas: [],
    generatedTrip: null,
    versions: [],
    activeVersionId: null,
    updatedAt: new Date().toISOString()
  };
}

function createDefaultTripState(tripId = defaultTripId) {
  return {
    tripId,
    shareKey: "",
    title: tripId === defaultTripId ? "澳洲 10 晚示例行程" : "新的旅行计划",
    activeTripTemplate: tripId === defaultTripId ? "australia" : "new",
    basics: {},
    constraints: {},
    ideas: [],
    generatedTrip: null,
    versions: [],
    activeVersionId: null,
    budgetRows: [],
    updatedAt: new Date().toISOString()
  };
}

async function getLarkTenantToken() {
  if (!larkEnabled) return "";
  if (cachedLarkToken && Date.now() < cachedLarkTokenExpiresAt) return cachedLarkToken;
  const response = await fetch(`${larkOpenApiBase}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      app_id: larkAppId,
      app_secret: larkAppSecret
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.code !== 0 || !data.tenant_access_token) {
    throw new Error(data.msg || data.message || "获取飞书应用访问令牌失败");
  }
  cachedLarkToken = data.tenant_access_token;
  cachedLarkTokenExpiresAt = Date.now() + Math.max(60, Number(data.expire || 7200) - 300) * 1000;
  return cachedLarkToken;
}

async function larkApi(path, options = {}) {
  const token = await getLarkTenantToken();
  const response = await fetch(`${larkOpenApiBase}${path}`, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${token}`
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || (typeof data.code === "number" && data.code !== 0)) {
    throw new Error(data.msg || data.message || `飞书 Base 请求失败：HTTP ${response.status}`);
  }
  return data;
}

const tripFieldAliases = {
  title: ["title", "fldXkID3xs"],
  destination: ["destination", "fldPA59KjG"],
  dateRange: ["dateRange", "fldEgjAOsG"],
  dataJson: ["dataJson", "fldga4TS0Q"],
  updatedAt: ["updatedAt", "fld4lwqbar"],
  tripId: ["tripId", "fldxC7uTUY"],
  shareKey: ["shareKey", "fld2lGVMPw"]
};

const versionFieldAliases = {
  versionId: ["versionId", "flda6HBRni"],
  tripId: ["tripId", "fldkdYYCIZ"],
  title: ["title", "fldIRFLPIM"],
  summary: ["summary", "fldbJdmV5K"],
  createdAt: ["createdAt", "fld7mvrCPp"],
  dataJson: ["dataJson", "fldvm0ujQK"]
};

function cellToText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(cellToText).join("");
  if (typeof value === "object") {
    if (value.text !== undefined) return cellToText(value.text);
    if (value.value !== undefined) return cellToText(value.value);
    if (value.name !== undefined) return cellToText(value.name);
    if (value.link !== undefined && value.text === undefined) return cellToText(value.link);
  }
  return "";
}

function fieldText(fields = {}, aliases = [], fallback = "") {
  for (const key of aliases) {
    if (fields[key] !== undefined) {
      const text = cellToText(fields[key]).trim();
      if (text) return text;
    }
  }
  return fallback;
}

function parseJsonField(value) {
  const text = cellToText(value);
  if (!text) return null;
  let state = null;
  try {
    state = JSON.parse(text);
  } catch {
    state = null;
  }
  return state;
}

function parseTripFields(fields = {}) {
  const state = parseJsonField(fields.dataJson ?? fields.fldga4TS0Q);
  const tripId = fieldText(fields, tripFieldAliases.tripId, String(state?.tripId || defaultTripId));
  return {
    tripId,
    shareKey: fieldText(fields, tripFieldAliases.shareKey, String(state?.shareKey || "")),
    recordId: "",
    title: fieldText(fields, tripFieldAliases.title, String(state?.title || "旅行计划")),
    destination: fieldText(fields, tripFieldAliases.destination, String(state?.basics?.destination || "")),
    dateRange: fieldText(fields, tripFieldAliases.dateRange, String(state?.basics?.dates || "")),
    state: state || createDefaultTripState(tripId)
  };
}

function parseVersionFields(fields = {}) {
  const version = parseJsonField(fields.dataJson ?? fields.fldvm0ujQK) || {};
  return {
    ...version,
    id: fieldText(fields, versionFieldAliases.versionId, String(version.id || "")),
    tripId: fieldText(fields, versionFieldAliases.tripId, String(version.tripId || "")),
    title: fieldText(fields, versionFieldAliases.title, String(version.title || "")),
    summary: fieldText(fields, versionFieldAliases.summary, String(version.summary || "")),
    createdAt: fieldText(fields, versionFieldAliases.createdAt, String(version.createdAt || "")),
    recordId: ""
  };
}

async function listLarkTripRecords() {
  if (!larkEnabled) return [];
  const data = await larkApi(`/base/v3/bases/${larkBaseToken}/tables/${larkTripsTableId}/records?limit=200&offset=0`);
  const items = getLarkRecordItems(data);
  return items.map(item => {
    const parsed = parseTripFields(item.fields || {});
    parsed.recordId = item.record_id || item.recordId || item.id || "";
    return parsed;
  });
}

async function readLarkTrip(tripId = defaultTripId) {
  if (!larkEnabled) return null;
  const filter = encodeURIComponent(JSON.stringify({
    logic: "and",
    conditions: [["tripId", "==", tripId]]
  }));
  const data = await larkApi(`/base/v3/bases/${larkBaseToken}/tables/${larkTripsTableId}/records?field_id=tripId&field_id=shareKey&field_id=title&field_id=destination&field_id=dateRange&field_id=dataJson&field_id=updatedAt&filter=${filter}&limit=20&offset=0`);
  const records = getLarkRecordItems(data).map(item => {
    const parsed = parseTripFields(item.fields || {});
    parsed.recordId = item.record_id || item.recordId || item.id || "";
    return parsed;
  });
  return records
    .filter(record => record.tripId === tripId)
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))[0] || null;
}

async function listLarkVersionRecords(tripId = defaultTripId) {
  if (!larkVersionsEnabled) return [];
  const filter = encodeURIComponent(JSON.stringify({
    logic: "and",
    conditions: [["tripId", "==", tripId]]
  }));
  const data = await larkApi(`/base/v3/bases/${larkBaseToken}/tables/${larkVersionsTableId}/records?field_id=versionId&field_id=tripId&field_id=title&field_id=summary&field_id=createdAt&field_id=dataJson&filter=${filter}&limit=200&offset=0`);
  const items = getLarkRecordItems(data);
  return items
    .map(item => {
      const parsed = parseVersionFields(item.fields || {});
      parsed.recordId = item.record_id || item.recordId || item.id || "";
      return parsed;
    })
    .filter(version => version.tripId === tripId && version.id)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

function getLarkRecordItems(data = {}) {
  if (Array.isArray(data?.data?.data) && Array.isArray(data?.data?.fields)) {
    const fieldNames = data.data.fields;
    const fieldIds = Array.isArray(data.data.field_id_list) ? data.data.field_id_list : [];
    const recordIds = Array.isArray(data.data.record_id_list) ? data.data.record_id_list : [];
    return data.data.data.map((row, rowIndex) => {
      const fields = {};
      if (Array.isArray(row)) {
        row.forEach((value, columnIndex) => {
          const fieldName = fieldNames[columnIndex];
          const fieldId = fieldIds[columnIndex];
          if (fieldName) fields[fieldName] = value;
          if (fieldId) fields[fieldId] = value;
        });
      }
      return {
        record_id: recordIds[rowIndex] || "",
        fields
      };
    });
  }
  return data?.data?.items
    || data?.data?.records
    || data?.items
    || data?.records
    || (Array.isArray(data?.data?.data) ? data.data.data : [])
    || [];
}

function ensureTripAccess(record, shareKey = "") {
  if (!record) return;
  // This is currently a private site, so tripId is enough to load/edit a trip.
  // Keep shareKey persisted for share links, but do not block cross-device access.
}

function normalizeTripState(raw = {}, tripId = defaultTripId, shareKey = "") {
  const nextTripId = String(raw.tripId || tripId || defaultTripId);
  const nextShareKey = String(raw.shareKey || shareKey || createShareKey());
  const basics = raw.basics && typeof raw.basics === "object" ? raw.basics : {};
  return {
    ...createDefaultTripState(nextTripId),
    ...raw,
    tripId: nextTripId,
    shareKey: nextShareKey,
    title: String(raw.title || basics.destination || "旅行计划"),
    ideas: Array.isArray(raw.ideas) ? raw.ideas : [],
    versions: Array.isArray(raw.versions) ? raw.versions : [],
    budgetRows: Array.isArray(raw.budgetRows) ? raw.budgetRows : [],
    generatedTrip: raw.generatedTrip || null,
    activeVersionId: raw.activeVersionId || null,
    updatedAt: new Date().toISOString()
  };
}

async function writeLarkTrip(rawState, tripId = defaultTripId, shareKey = "") {
  if (!larkEnabled) return null;
  const rawTripId = String(rawState?.tripId || tripId || defaultTripId);
  const existing = await readLarkTrip(rawTripId);
  ensureTripAccess(existing, shareKey || rawState?.shareKey || "");
  const preservedShareKey = String(rawState?.shareKey || shareKey || existing?.shareKey || createShareKey());
  const state = normalizeTripState(rawState, rawTripId, preservedShareKey);
  if (larkVersionsEnabled && Array.isArray(state.versions) && state.versions.length) {
    await Promise.all(state.versions.slice(0, 20).map(version => writeLarkVersion(version, state.tripId)));
  }
  const stateForTrip = {
    ...state,
    versions: []
  };
  const fields = {
    tripId: state.tripId,
    shareKey: state.shareKey,
    title: state.title,
    destination: String(state.basics?.destination || ""),
    dateRange: String(state.basics?.dates || ""),
    dataJson: JSON.stringify(stateForTrip),
    updatedAt: state.updatedAt
  };
  const path = existing?.recordId
    ? `/base/v3/bases/${larkBaseToken}/tables/${larkTripsTableId}/records/${existing.recordId}`
    : `/base/v3/bases/${larkBaseToken}/tables/${larkTripsTableId}/records`;
  await larkApi(path, {
    method: existing?.recordId ? "PATCH" : "POST",
    body: fields
  });
  return state;
}

async function writeLarkVersion(version, tripId = defaultTripId) {
  if (!larkVersionsEnabled || !version?.id) return null;
  const records = await listLarkVersionRecords(tripId);
  const existing = records.find(item => item.id === version.id);
  const fields = {
    versionId: String(version.id),
    tripId: String(tripId),
    title: String(version.title || ""),
    summary: String(version.summary || ""),
    createdAt: String(version.createdAt || new Date().toISOString()),
    dataJson: JSON.stringify({ ...version, tripId })
  };
  const path = existing?.recordId
    ? `/base/v3/bases/${larkBaseToken}/tables/${larkVersionsTableId}/records/${existing.recordId}`
    : `/base/v3/bases/${larkBaseToken}/tables/${larkVersionsTableId}/records`;
  await larkApi(path, {
    method: existing?.recordId ? "PATCH" : "POST",
    body: fields
  });
  return { ...version, tripId };
}

async function readTripState(tripId = defaultTripId, shareKey = "") {
  const cloudTrip = await readLarkTrip(tripId);
  if (cloudTrip) {
    ensureTripAccess(cloudTrip, shareKey);
    const state = normalizeTripState(cloudTrip.state, tripId, cloudTrip.shareKey || shareKey);
    if (larkVersionsEnabled) {
      state.versions = await listLarkVersionRecords(state.tripId);
    }
    return state;
  }
  if (tripId !== defaultTripId || larkEnabled) return null;
  return {
    ...createDefaultTripState(defaultTripId),
    ...(await readState())
  };
}

async function readState() {
  try {
    const text = await readFile(dataFile, "utf8");
    const state = JSON.parse(text);
    return {
      ...createDefaultState(),
      ...state,
      ideas: Array.isArray(state.ideas) ? state.ideas : [],
      generatedTrip: state.generatedTrip || null,
      versions: Array.isArray(state.versions) ? state.versions : [],
      activeVersionId: state.activeVersionId || null
    };
  } catch {
    return createDefaultState();
  }
}

async function writeState(state) {
  const nextState = {
    ...state,
    updatedAt: new Date().toISOString()
  };
  await mkdir(dirname(dataFile), { recursive: true });
  await writeFile(dataFile, JSON.stringify(nextState, null, 2), "utf8");
  return nextState;
}

function normalizeIdea(raw) {
  const priority = String(raw.priority || "nice");
  const priorityMap = {
    nice: "想要，可让步",
    important: "比较重要",
    must: "必须满足"
  };
  return {
    id: raw.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    templateId: String(raw.templateId || "australia"),
    name: String(raw.name || "").trim(),
    destination: String(raw.destination || "全程"),
    category: String(raw.category || "想加景点"),
    priority,
    priorityLabel: raw.priorityLabel || priorityMap[priority] || "想要，可让步",
    text: String(raw.text || "").trim(),
    createdAt: raw.createdAt || new Date().toLocaleString("zh-CN", { hour12: false })
  };
}

function getRequestTripId(url, payload = {}) {
  return String(
    payload.tripId
    || payload.trip?.tripId
    || url.searchParams.get("tripId")
    || defaultTripId
  );
}

function getRequestShareKey(url, payload = {}) {
  return String(
    payload.shareKey
    || payload.trip?.shareKey
    || url.searchParams.get("key")
    || url.searchParams.get("shareKey")
    || ""
  );
}

function buildMessages(payload) {
  const ideas = Array.isArray(payload.ideas) ? payload.ideas : [];
  const currentTrip = payload.trip || {};
  const prompt = payload.prompt || "";
  const allowNewPlaces = Boolean(currentTrip.allowNewPlaces || currentTrip.generationMode === "initial");
  const placeIds = Array.isArray(currentTrip.places)
    ? currentTrip.places.map(place => String(place?.id || "").trim()).filter(Boolean)
    : [];
  const placeIdInstruction = allowNewPlaces
    ? "这是初版行程生成，你可以根据目的地、日期和用户诉求自行拆分目的地模块。updatedPlaces 应输出最终建议的目的地列表，每个 id 要稳定、简短、英文或拼音小写，不能沿用无关旧示例城市。"
    : placeIds.length
    ? `updatedPlaces 只能包含当前行程目的地 id：${placeIds.join(", ")}。不要返回不在这个列表里的旧示例城市 id。`
    : "如果当前行程还没有目的地 id，请先基于硬约束中的地点生成稳定 id，并在 updatedPlaces 中使用这些 id。";
  const constraints = currentTrip.constraints && typeof currentTrip.constraints === "object" ? currentTrip.constraints : {};
  const destinationOrderWithNights = Array.isArray(constraints.destinations)
    ? constraints.destinations
        .map(destination => `${String(destination?.id || destination?.name || "").trim()}（${String(destination?.name || destination?.id || "").trim()}，${String(destination?.nights || "待定").trim()}）`)
        .filter(item => item && !item.startsWith("（"))
        .join(" -> ")
    : "";
  const fixedOrderInstruction = allowNewPlaces
    ? "这是初版生成，你需要先判断目的地应拆成几个模块，并给出合理顺序；如果用户只填了一个城市，就不要硬拆多个城市。"
    : constraints.orderMode === "fixed"
    ? `当前用户选择了固定顺序，这是不可改写的硬约束。你必须让 updatedPlaces 按这个顺序输出：${placeIds.join(" -> ")}。固定顺序对应的目的地和晚数是：${destinationOrderWithNights || "未填写晚数"}。你必须按这个顺序从抵达日期开始重新分配每个目的地 dates，不能沿用旧版本里某个城市的旧日期。如果交通、晚数或日期存在冲突，也必须先保留这个顺序，再在 conflicts/nextChecks 中说明需要人工核验或调整航班，不能自行改回其他顺序，也不能输出顺序和日期互相打架的计划。`
    : "当前用户没有固定路线顺序，你可以在不破坏往返和固定事项的前提下优化目的地顺序。";
  const systemPrompt = renderAgentPrompt(agentPromptTemplate, {
    fixedOrderInstruction,
    placeIdInstruction
  });

  return [
    {
      role: "system",
      content: systemPrompt
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "基于当前旅行计划和同行建议，生成新版旅行计划 JSON。必须保留硬约束，允许调整住宿、景点取舍、每日节奏和说明。",
        currentTrip,
        travelerIdeas: ideas,
        prompt
      }, null, 2)
    }
  ];
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => String(item || "").trim()).filter(Boolean);
}

function normalizeGeneratedTrip(plan, payload = {}) {
  if (!plan || typeof plan !== "object") return null;
  const agentReport = plan.agentReport && typeof plan.agentReport === "object" ? plan.agentReport : {};
  const templateId = String(plan.templateId || payload.trip?.templateId || "australia");
  return {
    templateId,
    constraintsFingerprint: String(payload.trip?.constraintsFingerprint || ""),
    summary: String(plan.summary || "已根据大家的建议生成新版行程。"),
    changes: normalizeStringList(plan.changes),
    agentReport: {
      adoptedIdeas: normalizeStringList(agentReport.adoptedIdeas),
      rejectedIdeas: normalizeStringList(agentReport.rejectedIdeas),
      conflicts: normalizeStringList(agentReport.conflicts),
      hardConstraintCheck: normalizeStringList(agentReport.hardConstraintCheck),
      nextChecks: normalizeStringList(agentReport.nextChecks)
    },
    updatedPlaces: Array.isArray(plan.updatedPlaces) ? plan.updatedPlaces : []
  };
}

function createVersionRecord(plan) {
  const createdAt = new Date().toISOString();
  return {
    id: `version-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    templateId: plan.templateId || "australia",
    title: `Agent 版本 ${new Date(createdAt).toLocaleString("zh-CN", { hour12: false })}`,
    createdAt,
    summary: plan.summary,
    changes: plan.changes,
    agentReport: plan.agentReport,
    updatedTrip: plan
  };
}

function parsePlanJson(content) {
  const text = String(content || "").trim();
  if (!text) return null;

  const direct = tryParseJson(text);
  if (direct) return direct;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const parsed = tryParseJson(fenced[1]);
    if (parsed) return parsed;
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return tryParseJson(text.slice(start, end + 1));
  }

  return null;
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function callArk(payload) {
  if (!apiKey) {
    const error = new Error("在线推演服务尚未配置，请联系行程维护者。");
    error.status = 400;
    throw error;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), arkTimeoutMs);
  let response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: buildMessages(payload),
        temperature: 0.35,
        max_tokens: 4000
      })
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error("模型生成超时，请减少约束内容或稍后重试。");
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const message = data?.error?.message || data?.message || text || `HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  const content = data?.choices?.[0]?.message?.content || data?.output_text || "";
  return {
    content,
    parsed: parsePlanJson(content)
  };
}

async function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const pathname = url.pathname === "/" ? "/australia-trip-planner.html" : url.pathname;
  const safePath = pathname.replace(/^\/+/, "").replace(/\.\./g, "");
  const filePath = join(__dirname, safePath);
  const ext = extname(filePath);

  try {
    const file = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream"
    });
    response.end(file);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "OPTIONS") {
    sendJson(response, 204, {});
    return;
  }

  if (url.pathname === "/api/health") {
    sendJson(response, 200, {
      ok: true,
      model,
      baseUrl,
      ready: Boolean(apiKey),
      larkStorage: Boolean(larkEnabled),
      larkVersions: Boolean(larkVersionsEnabled),
      storageVersion,
      defaultTripId
    });
    return;
  }

  if (url.pathname === "/api/state" && request.method === "GET") {
    try {
      const tripId = getRequestTripId(url);
      const shareKey = getRequestShareKey(url);
      const tripState = await readTripState(tripId, shareKey);
      sendJson(response, 200, tripState || createDefaultTripState(tripId));
    } catch (error) {
      sendJson(response, error.status || 500, { error: error.message || "读取行程失败" });
    }
    return;
  }

  if (url.pathname === "/api/trip" && request.method === "GET") {
    try {
      const tripId = getRequestTripId(url);
      const shareKey = getRequestShareKey(url);
      const tripState = await readTripState(tripId, shareKey);
      if (!tripState) {
        sendJson(response, 404, { error: "没有找到这个行程。", tripId });
        return;
      }
      sendJson(response, 200, tripState);
    } catch (error) {
      sendJson(response, error.status || 500, { error: error.message || "读取行程失败" });
    }
    return;
  }

  if (url.pathname === "/api/trip" && request.method === "POST") {
    try {
      const body = await readBody(request);
      const payload = body ? JSON.parse(body) : {};
      const tripId = getRequestTripId(url, payload);
      const shareKey = getRequestShareKey(url, payload);
      const state = await writeLarkTrip(payload.state || payload, tripId, shareKey);
      if (!state) {
        const nextState = await writeState(payload.state || payload);
        sendJson(response, 200, { ...nextState, tripId, shareKey });
        return;
      }
      sendJson(response, 200, state);
    } catch (error) {
      sendJson(response, error.status || 500, { error: error.message || "保存行程失败" });
    }
    return;
  }

  if (url.pathname === "/api/ideas" && request.method === "GET") {
    const tripId = getRequestTripId(url);
    const shareKey = getRequestShareKey(url);
    const state = await readTripState(tripId, shareKey) || await readState();
    sendJson(response, 200, {
      ideas: state.ideas,
      generatedTrip: state.generatedTrip,
      versions: state.versions,
      activeVersionId: state.activeVersionId
    });
    return;
  }

  if (url.pathname === "/api/ideas" && request.method === "POST") {
    try {
      const body = await readBody(request);
      const payload = body ? JSON.parse(body) : {};
      const idea = normalizeIdea(payload);
      if (!idea.text) {
        sendJson(response, 400, { error: "请先填写具体想法。" });
        return;
      }
      const tripId = getRequestTripId(url, payload);
      const shareKey = getRequestShareKey(url, payload);
      const state = await readTripState(tripId, shareKey) || createDefaultTripState(tripId);
      const nextState = larkEnabled ? await writeLarkTrip({
        ...state,
        ideas: [idea, ...state.ideas]
      }, tripId, shareKey) : await writeState({
        ...state,
        ideas: [idea, ...state.ideas]
      });
      sendJson(response, 200, {
        idea,
        ideas: nextState.ideas,
        generatedTrip: nextState.generatedTrip,
        versions: nextState.versions,
        activeVersionId: nextState.activeVersionId
      });
    } catch (error) {
      sendJson(response, 500, { error: error.message || "保存失败" });
    }
    return;
  }

  if (url.pathname === "/api/ideas" && request.method === "DELETE") {
    const tripId = getRequestTripId(url);
    const shareKey = getRequestShareKey(url);
    const state = await readTripState(tripId, shareKey) || await readState();
    const id = url.searchParams.get("id");
    const templateId = url.searchParams.get("templateId");
    const nextIdeas = id
      ? state.ideas.filter(idea => idea.id !== id)
      : templateId
        ? state.ideas.filter(idea => (idea.templateId || "australia") !== templateId)
        : [];
    const nextState = larkEnabled ? await writeLarkTrip({
      ...state,
      ideas: nextIdeas
    }, tripId, shareKey) : await writeState({
      ...state,
      ideas: nextIdeas
    });
    sendJson(response, 200, {
      ideas: nextState.ideas,
      generatedTrip: nextState.generatedTrip,
      versions: nextState.versions,
      activeVersionId: nextState.activeVersionId
    });
    return;
  }

  if (url.pathname === "/api/reset-plan" && request.method === "POST") {
    const body = await readBody(request);
    const payload = body ? JSON.parse(body) : {};
    const tripId = getRequestTripId(url, payload);
    const shareKey = getRequestShareKey(url, payload);
    const state = await readTripState(tripId, shareKey) || await readState();
    const nextState = larkEnabled ? await writeLarkTrip({
      ...state,
      generatedTrip: null,
      activeVersionId: "initial"
    }, tripId, shareKey) : await writeState({
      ...state,
      generatedTrip: null,
      activeVersionId: "initial"
    });
    sendJson(response, 200, nextState);
    return;
  }

  if (url.pathname === "/api/versions" && request.method === "GET") {
    const tripId = getRequestTripId(url);
    const shareKey = getRequestShareKey(url);
    const state = await readTripState(tripId, shareKey) || await readState();
    sendJson(response, 200, {
      versions: state.versions,
      generatedTrip: state.generatedTrip,
      activeVersionId: state.activeVersionId
    });
    return;
  }

  if (url.pathname === "/api/restore-version" && request.method === "POST") {
    try {
      const body = await readBody(request);
      const payload = body ? JSON.parse(body) : {};
      const tripId = getRequestTripId(url, payload);
      const shareKey = getRequestShareKey(url, payload);
      const state = await readTripState(tripId, shareKey) || await readState();
      const version = state.versions.find(item => item.id === payload.versionId);
      if (!version?.updatedTrip) {
        sendJson(response, 404, { error: "没有找到这个历史版本。" });
        return;
      }
      const nextState = larkEnabled ? await writeLarkTrip({
        ...state,
        generatedTrip: version.updatedTrip,
        activeVersionId: version.id
      }, tripId, shareKey) : await writeState({
        ...state,
        generatedTrip: version.updatedTrip,
        activeVersionId: version.id
      });
      sendJson(response, 200, nextState);
    } catch (error) {
      sendJson(response, 500, { error: error.message || "恢复版本失败" });
    }
    return;
  }

  if (url.pathname === "/api/plan" && request.method === "POST") {
    try {
      const body = await readBody(request);
      const payload = body ? JSON.parse(body) : {};
      const tripId = getRequestTripId(url, payload);
      const shareKey = getRequestShareKey(url, payload);
      const state = await readTripState(tripId, shareKey) || await readState();
      const templateId = String(payload.trip?.templateId || "australia");
      const requestPayload = {
        ...payload,
        ideas: state.ideas.filter(idea => (idea.templateId || "australia") === templateId)
      };
      const result = await callArk(requestPayload);
      const normalizedTrip = normalizeGeneratedTrip(result.parsed, requestPayload);
      const version = normalizedTrip ? createVersionRecord(normalizedTrip) : null;
      const nextState = normalizedTrip
        ? larkEnabled ? await writeLarkTrip({
            ...state,
            generatedTrip: normalizedTrip,
            versions: [version, ...state.versions].slice(0, 20),
            activeVersionId: version.id
          }, tripId, shareKey) : await writeState({
            ...state,
            generatedTrip: normalizedTrip,
            versions: [version, ...state.versions].slice(0, 20),
            activeVersionId: version.id
          })
        : state;
      sendJson(response, 200, {
        model,
        plan: result.content,
        updatedTrip: normalizedTrip,
        version,
        ideas: nextState.ideas,
        versions: nextState.versions,
        activeVersionId: nextState.activeVersionId
      });
    } catch (error) {
      sendJson(response, error.status || 500, {
        error: error.message || "生成失败"
      });
    }
    return;
  }

  await serveStatic(request, response);
});

server.listen(port, host, () => {
  console.log(`Trip planner server: http://${host}:${port}`);
  console.log(`Model: ${model}`);
  console.log(`Ark base URL: ${baseUrl}`);
  console.log(`API key loaded: ${apiKey ? "yes" : "no"}`);
  console.log(`Data file: ${dataFile}`);
});

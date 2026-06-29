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
const dataFile = process.env.DATA_FILE || join(__dirname, "trip-state.json");

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
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
  response.end(JSON.stringify(payload));
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

function buildMessages(payload) {
  const ideas = Array.isArray(payload.ideas) ? payload.ideas : [];
  const currentTrip = payload.trip || {};
  const prompt = payload.prompt || "";
  const placeIds = Array.isArray(currentTrip.places)
    ? currentTrip.places.map(place => String(place?.id || "").trim()).filter(Boolean)
    : [];
  const placeIdInstruction = placeIds.length
    ? `updatedPlaces 只能包含当前行程目的地 id：${placeIds.join(", ")}。不要返回不在这个列表里的旧示例城市 id。`
    : "如果当前行程还没有目的地 id，请先基于硬约束中的地点生成稳定 id，并在 updatedPlaces 中使用这些 id。";

  return [
    {
      role: "system",
      content: [
        "你是一个严谨的旅行计划 Agent，不是简单文案生成器。",
        "必须用中文回答。",
        "你要按 Agent 工作流完成：1) 理解硬约束；2) 判断同行建议的优先级和冲突；3) 更新行程；4) 自检日期、城市顺序、住宿偏好和交通时间；5) 给出下一步人工核验事项。",
        "必须优先保证往返日期、城市顺序、航班/交通时间锚点不被随意改动。",
        "用户是三人同行，其中一对情侣，住宿偏好是一套房内两个真实卧室。",
        "输出要具体到每个城市的上午、下午、晚上，并说明采纳/不采纳同行建议的原因。",
        "如果建议会破坏硬约束，明确指出冲突，并给替代方案。",
        "只返回 JSON，不要返回 Markdown，不要使用代码块。",
        "JSON 格式必须是：{ summary: string, agentReport: AgentReport, changes: string[], updatedPlaces: Place[] }。",
        "AgentReport 字段必须包含 adoptedIdeas, rejectedIdeas, conflicts, hardConstraintCheck, nextChecks。",
        "adoptedIdeas/rejectedIdeas/conflicts/hardConstraintCheck/nextChecks 都是字符串数组。",
        "Place 字段必须包含 id, name, dates, thesis, hotels, transport, advice, days。",
        "hotels 是二维数组，每项为 [名称, 建议]。",
        "transport 和 advice 是字符串数组。",
        "days 是二维数组，每项为 [日期标题, 上午, 下午, 晚上]。",
        placeIdInstruction,
        "如果这是新的旅行计划，绝对不要沿用澳洲示例中的 Perth/Melbourne/Whitsundays/Sydney，除非这些地点确实在当前行程目的地列表里。"
      ].join("\n")
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

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
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
      ready: Boolean(apiKey)
    });
    return;
  }

  if (url.pathname === "/api/state" && request.method === "GET") {
    sendJson(response, 200, await readState());
    return;
  }

  if (url.pathname === "/api/ideas" && request.method === "GET") {
    const state = await readState();
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
      const state = await readState();
      const nextState = await writeState({
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
    const state = await readState();
    const id = url.searchParams.get("id");
    const templateId = url.searchParams.get("templateId");
    const nextIdeas = id
      ? state.ideas.filter(idea => idea.id !== id)
      : templateId
        ? state.ideas.filter(idea => (idea.templateId || "australia") !== templateId)
        : [];
    const nextState = await writeState({
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
    const state = await readState();
    const nextState = await writeState({
      ...state,
      generatedTrip: null,
      activeVersionId: null
    });
    sendJson(response, 200, nextState);
    return;
  }

  if (url.pathname === "/api/versions" && request.method === "GET") {
    const state = await readState();
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
      const state = await readState();
      const version = state.versions.find(item => item.id === payload.versionId);
      if (!version?.updatedTrip) {
        sendJson(response, 404, { error: "没有找到这个历史版本。" });
        return;
      }
      const nextState = await writeState({
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
      const state = await readState();
      const templateId = String(payload.trip?.templateId || "australia");
      const requestPayload = {
        ...payload,
        ideas: state.ideas.filter(idea => (idea.templateId || "australia") === templateId)
      };
      const result = await callArk(requestPayload);
      const normalizedTrip = normalizeGeneratedTrip(result.parsed, requestPayload);
      const version = normalizedTrip ? createVersionRecord(normalizedTrip) : null;
      const nextState = normalizedTrip
        ? await writeState({
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

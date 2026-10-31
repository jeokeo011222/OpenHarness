/* OntoRAG 调试面板 · 前端逻辑。
 *
 * 只做三件事：调 /v1/debug/trace、把中间态按"链路顺序"铺开、把差异讲清楚。
 * 所有文本一律经 esc() 转义——分块原文来自租户文档，直接拼 HTML 会被
 * 文档里的尖括号打断结构（更别说注入）。
 */

const $ = (id) => document.getElementById(id);

const TIER_META = {
  graph: { no: "①", name: "本体图谱", store: "SPARQL 事实链", note: "权重最高，先收窄候选空间" },
  keyword: { no: "②", name: "关键词", store: "ES / pg tsvector", note: "匹配条款原话" },
  vector: { no: "③", name: "向量", store: "余弦相似度", note: "仅在上一级不足时触发" },
};

const STATUS_META = {
  final: { text: "进入证据", cls: "ok" },
  cut: { text: "被 top-k 截断", cls: "muted" },
  dropped: { text: "已剔除", cls: "bad" },
};

const state = { running: false, data: null, weights: {} };

/* ------------------------------ 工具 ------------------------------ */

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

function local(iri) {
  if (!iri) return "";
  const hash = iri.lastIndexOf("#");
  if (hash >= 0) return iri.slice(hash + 1);
  const slash = iri.lastIndexOf("/");
  return slash >= 0 ? iri.slice(slash + 1) : iri;
}

function num(value, digits = 3) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : "—";
}

function pct(value, digits = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${(parsed * 100).toFixed(digits)}%` : "—";
}

function chip(text, cls = "", title = "") {
  const t = title ? ` title="${esc(title)}"` : "";
  return `<span class="chip ${cls}"${t}>${esc(text)}</span>`;
}

function monoChip(text, cls = "") {
  return `<span class="chip mono ${cls}">${esc(text)}</span>`;
}

/* ------------------------------ 配置 ------------------------------ */

function loadSettings() {
  const params = new URLSearchParams(location.search);
  const saved = JSON.parse(localStorage.getItem("ontorag-debug") || "{}");
  $("in-tenant").value = params.get("tenant") || saved.tenant || "demo";
  $("in-key").value = params.get("key") || saved.key || "";
  $("in-topk").value = params.get("topk") || saved.topk || "5";
  $("in-domain").value = saved.domain || "";
  $("in-baseline").checked = saved.baseline !== false;
}

function saveSettings() {
  localStorage.setItem("ontorag-debug", JSON.stringify({
    tenant: $("in-tenant").value.trim(),
    key: $("in-key").value,
    topk: $("in-topk").value,
    domain: $("in-domain").value,
    baseline: $("in-baseline").checked,
  }));
}

function headers() {
  const out = { "Content-Type": "application/json" };
  const tenant = $("in-tenant").value.trim();
  const key = $("in-key").value;
  if (tenant) out["X-Tenant-Id"] = tenant;
  if (key) out["X-API-Key"] = key;
  return out;
}

/* ------------------------------ 顶栏与示例 ------------------------------ */

async function loadOntology() {
  try {
    const response = await fetch("/v1/debug/ontology", { headers: headers() });
    if (!response.ok) throw new Error(String(response.status));
    const data = await response.json();
    $("onto-chips").innerHTML = [
      chip(`类 ${data.classes}`, "accent"),
      chip(`属性 ${data.properties}`, "accent"),
      chip(`结论形状 ${data.claim_shapes}`, ""),
      chip(`SHACL ${data.shacl_engine}`, "muted"),
    ].join("");
  } catch (error) {
    $("onto-chips").innerHTML = chip("本体信息不可用", "warn", String(error));
  }
}

async function loadExamples() {
  try {
    const response = await fetch("/v1/debug/examples");
    const data = await response.json();
    $("examples").innerHTML = data.items
      .map((item) => `<span class="chip" data-q="${esc(item.question)}" data-d="${esc(item.domain || "")}" title="${esc(item.note)}">${esc(item.question)}</span>`)
      .join("");
    $("examples").querySelectorAll(".chip").forEach((node) => {
      node.addEventListener("click", () => {
        $("in-question").value = node.dataset.q;
        $("in-domain").value = node.dataset.d;
        $("in-question").focus();
      });
    });
  } catch {
    /* 示例只是便利功能，取不到就不显示 */
  }
}

/* ------------------------------ 运行 ------------------------------ */

async function run(event) {
  if (event) event.preventDefault();
  if (state.running) return;

  const question = $("in-question").value.trim();
  if (question.length < 2) {
    renderBanner({ title: "参数有误", error: "请输入至少 2 个字符的问题", stages: [] }, "error");
    return;
  }
  saveSettings();

  state.running = true;
  const button = $("run");
  button.disabled = true;
  button.innerHTML = '<span class="spinner"></span>运行中';

  try {
    const response = await fetch("/v1/debug/trace", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        question,
        domain: $("in-domain").value || null,
        top_k: Number($("in-topk").value) || 5,
        compare_baseline: $("in-baseline").checked,
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      const title = payload.code === "tenant_forbidden" ? "鉴权失败"
        : payload.code === "invalid_request" ? "参数有误"
        : `请求被拒绝（HTTP ${response.status}）`;
      renderBanner({ title, error: payload.message || "未知错误", stages: [] }, "error");
      return;
    }
    state.data = payload;
    state.weights = payload.weights || {};
    render(payload);
  } catch (error) {
    renderBanner({ title: "请求失败", error: `${error}`, stages: [] }, "error");
  } finally {
    state.running = false;
    button.disabled = false;
    button.innerHTML = '运行链路 <kbd>⌘↵</kbd>';
  }
}

function render(data) {
  renderBanner(data);
  renderStages(data);
  renderStats(data);
  renderIntent(data);
  renderTiers(data);
  renderGuard(data);
  renderAnswer(data);
  renderBaseline(data);
  $("trace-foot").textContent = data.trace_id ? `trace ${data.trace_id}` : "";
}

/* ------------------------------ 判定横幅 ------------------------------ */

function renderBanner(data, forced) {
  const banner = $("banner");
  banner.classList.remove("hidden", "pass", "block", "error");

  if (forced === "error" || (data.error && !data.guard)) {
    banner.classList.add("error");
    banner.innerHTML = `
      <span class="title">${esc(data.title || "链路中断")}</span>
      <span class="detail">${esc(data.error || "未知错误")}</span>
      <span class="spacer"></span>
      ${failedStageChip(data.stages)}`;
    return;
  }

  const violations = data.guard?.counts?.Violation || 0;
  if (data.blocked || (data.guard && !data.guard.conforms)) {
    banner.classList.add("block");
    banner.innerHTML = `
      <span class="title">已阻断</span>
      <span class="detail">${esc(data.block_reason || "SHACL 校验未通过")}</span>
      <span class="spacer"></span>
      ${chip(`${violations} 条 Violation`, "bad")}
      ${chip(`耗时 ${Math.round(data.total_ms)}ms`, "muted")}`;
    return;
  }

  banner.classList.add("pass");
  banner.innerHTML = `
    <span class="title">通过</span>
    <span class="detail">${data.citations.length} 条溯源 · 答案经 SHACL 校验后输出</span>
    <span class="spacer"></span>
    ${chip(`模型 ${data.provider}`, data.provider === "offline" ? "warn" : "")}
    ${chip(`耗时 ${Math.round(data.total_ms)}ms`, "muted")}
    ${chip(`trace ${data.trace_id.slice(0, 8)}`, "mono muted", data.trace_id)}`;
}

function failedStageChip(stages) {
  const failed = (stages || []).find((stage) => stage.ok === false);
  return failed ? chip(`失败于「${failed.label}」`, "bad", failed.note) : "";
}

/* ------------------------------ 阶段耗时 ------------------------------ */

function renderStages(data) {
  const stages = data.stages || [];
  if (!stages.length) {
    $("stages-body").innerHTML = '<p class="placeholder">—</p>';
    $("stage-total").textContent = "";
    return;
  }
  const max = Math.max(...stages.map((stage) => stage.elapsed_ms), 1);
  $("stages-body").innerHTML = `<div class="stages">${stages.map((stage) => `
    <div class="stage-row ${stage.ok ? "" : "fail"}">
      <span class="lbl" title="${esc(stage.note)}">${esc(stage.label)}</span>
      <span class="bar"><i style="width:${Math.max((stage.elapsed_ms / max) * 100, 3).toFixed(1)}%"></i></span>
      <span class="ms">${num(stage.elapsed_ms, 1)}</span>
    </div>`).join("")}</div>`;
  $("stage-total").textContent = `总 ${Math.round(data.total_ms)}ms`;
}

/* ------------------------------ 检索统计 ------------------------------ */

function renderStats(data) {
  const recall = data.recall;
  if (!recall) {
    $("stats-body").innerHTML = '<p class="placeholder">—</p>';
    return;
  }
  const dirty = Number(recall.dirty_recall_rate || 0);
  const items = [
    ["融合候选", recall.fused, ""],
    ["过滤后", recall.after_filter, ""],
    ["脏召回率", pct(dirty), dirty > 0 ? "alert" : "good"],
    // 向量在融合前被本体预过滤掉的条数：它不计入脏召回率（口径见 README），
    // 但演示时必须看得见，否则"脏召回 0%"会被误读成"一条脏的都没有"
    ["向量预过滤", recall.prefiltered_vector, recall.prefiltered_vector > 0 ? "alert" : ""],
    ["图谱种子", recall.graph_seeds, ""],
    ["向量触发", recall.vector_triggered ? "是" : "否", ""],
    ["最高分", num(recall.best_score, 3), ""],
  ];
  $("stats-body").innerHTML = `<div class="stats">${items.map(([key, value, cls]) => `
    <div class="stat ${cls}"><div class="v">${esc(value)}</div><div class="k">${esc(key)}</div></div>`).join("")}</div>`;
}

/* ------------------------------ 本体解析 ------------------------------ */

function renderIntent(data) {
  const intent = data.parsed;
  if (!intent) {
    $("intent-body").innerHTML = '<p class="placeholder">解析阶段未完成。</p>';
    $("intent-meta").textContent = "";
    return;
  }
  $("intent-meta").textContent = `${intent.complexity} · ${intent.entities.length} 个实体`;

  const rows = [];
  const push = (key, html) => rows.push(`<dt>${esc(key)}</dt><dd>${html || '<span class="hint">—</span>'}</dd>`);

  push("领域", chip(intent.domain || "自动", "accent"));
  push("识别类", chipsOrEmpty(intent.classes.map(local), "accent"));
  push("识别属性", chipsOrEmpty(intent.properties.map(local)));
  push("业务约束", chipsOrEmpty(intent.constraints, "warn"));
  push("过滤器", Object.entries(intent.filters || {}).length
    ? Object.entries(intent.filters)
        .map(([key, value]) => `<span class="chip mono" title="${esc(String(value))}">${esc(`${key}=${shortFilter(value)}`)}</span>`)
        .join("")
    : "");
  push("归一化问句", intent.normalized_query ? `<span class="mono hint">${esc(intent.normalized_query)}</span>` : "");

  const entityRows = (intent.entities || []).map((entity) => `
    <tr>
      <td>${esc(entity.surface)}</td>
      <td class="mono">${esc(local(entity.iri) || "—")}</td>
      <td>${chip(entity.kind, entity.kind === "unknown" ? "muted" : "accent")}</td>
      <td>${num(entity.confidence, 2)}</td>
      <td>${chip(entity.source, entity.source === "llm" ? "warn" : "muted")}</td>
    </tr>`).join("");

  $("intent-body").innerHTML = `
    <dl class="kv">${rows.join("")}</dl>
    ${entityRows ? `<table class="entities">
      <thead><tr><th>表面形式</th><th>本体 IRI</th><th>类型</th><th>置信</th><th>来源</th></tr></thead>
      <tbody>${entityRows}</tbody>
    </table>` : '<p class="placeholder">未识别出实体：检索将退回属性域与约束目标类。</p>'}`;
}

function shortFilter(value) {
  const one = (item) => {
    const text = String(item).trim();
    return text.startsWith("http") ? local(text) : text;
  };
  if (Array.isArray(value)) return value.map(one).join(",");
  return String(value).split(",").map(one).join(",");
}

function chipsOrEmpty(list, cls = "") {
  const clean = (list || []).filter(Boolean);
  return clean.length ? clean.map((item) => chip(item, cls)).join("") : "";
}

/* ------------------------------ 三级召回 ------------------------------ */

function renderTiers(data) {
  const tiers = data.tiers || [];
  if (!tiers.length) {
    $("tiers-body").innerHTML = '<p class="placeholder">检索未执行。</p>';
    return;
  }
  $("tiers-body").innerHTML = tiers.map(renderTier).join("");
}

function renderTier(tier) {
  const meta = TIER_META[tier.tier] || { no: "", name: tier.tier, store: "", note: "" };
  const reason = String(tier.reason || "");
  const skipped = !tier.executed;
  const reasonCls = skipped
    ? (reason.startsWith("skipped:sufficient") ? "ok" : "muted")
    : (reason.startsWith("failed") ? "bad" : "muted");

  const head = `
    <div class="tier-head">
      <span class="name">${meta.no} ${esc(meta.name)}</span>
      <span class="store">${esc(meta.store)} · 权重 ${num(tier.weight, 2)}</span>
      ${chip(reason, reasonCls, meta.note)}
      <span class="spacer"></span>
      <span class="hint">取回 ${tier.fetched} · 入融合 ${tier.kept} · 存活 ${tier.survived} · ${num(tier.elapsed_ms, 1)}ms</span>
    </div>`;

  const body = skipped
    ? `<div class="tier-body"><p class="placeholder">${esc(skipExplanation(reason, meta))}</p></div>`
    : `<div class="tier-body">${
        tier.chunks.length
          ? tier.chunks.map(renderEvidence).join("")
          : '<p class="placeholder">本通道没有候选进入融合。</p>'
      }</div>`;

  return `<div class="tier ${skipped ? "off" : ""}">${head}${body}</div>`;
}

function skipExplanation(reason, meta) {
  if (reason.startsWith("skipped:sufficient")) {
    return `未触发——上一级证据已充足（${reason.split("skipped:")[1]}）。这是判定，不是漏跑。`;
  }
  if (reason.startsWith("skipped:no-entity-space")) {
    return "未执行——没有可用的实体空间，无法生成本体查询。";
  }
  return `未执行：${reason || meta.note}`;
}

function renderEvidence(chunk) {
  const status = STATUS_META[chunk.status] || STATUS_META.final;
  const scoreWidth = Math.min(Math.max(Number(chunk.score) * 100, 2), 100);
  // matched_on 里混着两类东西：通道名（graph/keyword）与关键词命中词。
  // 不拆开就会渲染出 "图谱+付款+款申+申请" 这种读不懂的串。
  const hits = chunk.matched_on || [];
  const tiers = hits.filter((tag) => TIER_META[tag]);
  const terms = hits.filter((tag) => !TIER_META[tag] && tag !== "sparql");
  const cross = tiers.length > 1;

  const tags = [];
  if (chunk.status === "dropped") tags.push(chip(chunk.drop_reason || "已剔除", "bad", "该分块没有进入最终证据"));
  if (cross) tags.push(chip(`交叉命中 ${tiers.map(shortTier).join(" + ")}`, "accent", "被两条以上通道同时命中"));
  if (terms.length) tags.push(chip(`命中词 ${terms.slice(0, 4).join("/")}`, "muted", terms.join(" / ")));
  if (chunk.seed) tags.push(chip(`${chunk.depth} 跳 · ${local(chunk.seed)}`, "muted", "该分块由哪个实体顺关系找到"));
  if (chunk.priority) tags.push(chip(`优先级 ${chunk.priority}`, "muted"));
  (chunk.classes || []).slice(0, 4).forEach((iri) => tags.push(chip(local(iri), "accent")));
  (chunk.properties || []).slice(0, 4).forEach((iri) => tags.push(chip(local(iri))));
  if (chunk.verdict) tags.push(monoChip(`判定 ${chunk.verdict}`, "muted"));

  const breakdown = Object.entries(chunk.breakdown || {})
    .map(([key, value]) => monoChip(`${key} ${num(value, 2)}`))
    .join("");

  const finalPart = chunk.final_score
    ? `<span class="hint"> → 最终 ${num(chunk.final_score, 3)}</span>`
    : "";

  return `
    <div class="evidence ${chunk.status === "dropped" ? "is-dropped" : ""}">
      <div class="evidence-top">
        <span class="chip ${status.cls} dot">${esc(status.text)}</span>
        <span class="evidence-id">${esc(chunk.chunk_id)}</span>
        <span class="evidence-title">${esc(chunk.doc_title)} · ${esc(chunk.clause_no)}</span>
        <span class="evidence-score">${num(chunk.score, 3)}${finalPart}</span>
      </div>
      <div class="evidence-bar"><i style="width:${scoreWidth.toFixed(1)}%"></i></div>
      <div class="evidence-meta">${tags.join("")}</div>
      <details><summary>原文</summary><p class="quote">${esc(chunk.text)}</p></details>
      ${breakdown ? `<details><summary>打分构成</summary><div class="evidence-meta">${breakdown}</div></details>` : ""}
    </div>`;
}

function shortTier(tier) {
  return { graph: "图谱", keyword: "关键词", vector: "向量" }[tier] || tier;
}

/* ------------------------------ 闸门 ------------------------------ */

function renderGuard(data) {
  const guard = data.guard;
  if (!guard) {
    $("guard-body").innerHTML = '<p class="placeholder">未执行——生成阶段没有产出可校验的断言。</p>';
    $("guard-meta").textContent = "";
    return;
  }
  $("guard-meta").textContent = `${guard.engine} · ${num(guard.elapsed_ms, 1)}ms`;

  const violations = guard.violations || [];
  const blocking = violations.filter((item) => item.severity === "Violation");
  const warnings = violations.filter((item) => item.severity !== "Violation");

  const head = `
    <div class="guard-top">
      <span class="guard-state ${guard.conforms ? "pass" : "block"}">${guard.conforms ? "conforms" : "blocked"}</span>
      ${chip(`校验 ${guard.checked_triples} 条三元组`, "muted")}
      ${chip(`策略 ${guard.policy}`, "muted")}
      ${monoChip(`引擎 ${guard.engine}`, "muted")}
      ${(guard.shapes_checked || []).slice(0, 6).map((shape) => monoChip(shape, "muted")).join("")}
    </div>`;

  const table = (rows, title) => {
    if (!rows.length) return "";
    return `
      <div class="subhead">${esc(title)} · ${rows.length} 条</div>
      <table class="violations">
        <thead><tr><th>级别</th><th>规则</th><th>说明</th><th>焦点节点</th></tr></thead>
        <tbody>${rows.map((item) => `
          <tr>
            <td><span class="sev ${esc(item.severity)}">${esc(item.severity)}</span></td>
            <td class="mono">${esc(item.rule)}</td>
            <td>${esc(item.message)}</td>
            <td class="mono">${esc(local(item.focus_node) || "—")}</td>
          </tr>`).join("")}</tbody>
      </table>`;
  };

  const none = violations.length
    ? ""
    : '<p class="placeholder">没有 Violation / Warning —— 断言与租户事实、业务约束均一致。</p>';

  $("guard-body").innerHTML = head + table(blocking, "Violation（阻断）") + table(warnings, "Warning（不阻断）") + none;
}

/* ------------------------------ 答案与链路 ------------------------------ */

function renderAnswer(data) {
  const body = [];

  const blockedByGuard = Boolean(data.blocked && data.guard && !data.guard.conforms);
  if (blockedByGuard) {
    body.push(`<div class="guard-top">${chip("答案已被拦截，正文不对外返回", "bad")}</div>`);
    if (data.answer) {
      body.push(`<details><summary class="hint" style="cursor:pointer;margin:6px 0 8px">查看被阻断的初稿（仅调试可见）</summary>
        <p class="answer-text">${esc(data.answer)}</p></details>`);
    }
  } else if (!data.answer) {
    const failed = (data.stages || []).find((stage) => stage.ok === false);
    body.push(`<p class="placeholder">未产出答案${failed ? `——链路中断于「${esc(failed.label)}」` : ""}。</p>`);
  } else if (data.answer) {
    body.push(`<p class="answer-text">${esc(data.answer)}</p>`);
  } else {
    body.push('<p class="placeholder">没有产出答案。</p>');
  }

  const citations = data.citations || [];
  if (citations.length) {
    body.push(`<div class="subhead">溯源 · ${citations.length} 条</div>`);
    body.push(`<div class="chips">${citations.map((item) =>
      chip(`${item.chunk_id} · ${item.doc_title} ${item.clause_no}`, "mono", item.quote)).join("")}</div>`);
  }

  const claims = data.claims || [];
  if (claims.length) {
    body.push(`<div class="subhead">结论断言 · ${claims.length} 条（闸门校验对象）</div>`);
    body.push(`<table class="entities">
      <thead><tr><th>主语</th><th>谓词</th><th>宾语</th></tr></thead>
      <tbody>${claims.map((claim) => `
        <tr>
          <td class="mono">${esc(local(claim.subject) || claim.subject)}</td>
          <td class="mono">${esc(local(claim.predicate) || claim.predicate)}</td>
          <td class="mono">${esc(claim.object)}</td>
        </tr>`).join("")}</tbody>
    </table>`);
  }

  const chain = data.chain || [];
  if (chain.length) {
    body.push('<div class="subhead">溯源链路</div>');
    body.push(`<ol class="chain">${chain.map((step) => `
      <li class="k-${esc(step.kind)}">
        <div class="c-title">${esc(step.title)}</div>
        ${step.detail ? `<div class="c-detail">${esc(step.detail)}</div>` : ""}
        ${(step.refs || []).length ? `<div class="chips">${step.refs.slice(0, 4).map((ref) => monoChip(local(ref))).join("")}</div>` : ""}
      </li>`).join("")}</ol>`);
  }

  $("answer-meta").textContent = data.model ? `模型 ${data.model}` : "";
  $("answer-body").innerHTML = body.join("");
}

/* ------------------------------ 对照 ------------------------------ */

function renderBaseline(data) {
  const baseline = data.baseline || {};
  if (!baseline.enabled) {
    $("baseline-body").innerHTML = `<p class="placeholder">${esc(baseline.reason || "未启用对照")}</p>`;
    return;
  }
  const ontologyTotal = (data.citations || []).length;

  const naiveList = (baseline.chunks || []).map((chunk) => {
    const dirty = chunk.drop_reason === "incompatible";
    return chip(chunk.chunk_id, dirty ? "bad" : "muted", dirty ? `本体不兼容：${chunk.verdict}` : `与本题兼容：${chunk.verdict}`);
  }).join("");

  const verdict = baseline.dirty > 0
    ? `普通 RAG 的 ${baseline.total} 条证据里有 <b>${baseline.dirty}</b> 条与本题本体不兼容——它们会被原样写进答案依据。本体制导在排序前就把这些剔除了。`
    : `本例普通 RAG 恰好都落在同域，差异不在召回纯度，而在「结论可被 SHACL 校验」与「证据由 SPARQL 事实链支撑」。`;

  $("baseline-body").innerHTML = `
    <div class="compare">
      <div class="compare-row naive">
        <h3>普通 RAG（纯向量 top-k）</h3>
        <div class="metric">${baseline.dirty} / ${baseline.total}</div>
        <div class="metric-label">条证据与本题本体不兼容</div>
        <div class="chips">${naiveList || '<span class="hint">无召回</span>'}</div>
      </div>
      <div class="compare-row onto">
        <h3>本体制导</h3>
        <div class="metric">${ontologyTotal}</div>
        <div class="metric-label">条证据全部通过本体兼容性判定</div>
        <div class="chips">
          ${chip(`与普通 RAG 重合 ${(baseline.overlap || []).length}`, "muted")}
          ${chip(`本体制导独有 ${(baseline.only_ontology || []).length}`, "accent")}
          ${chip(`普通 RAG 独有 ${(baseline.only_naive || []).length}`, "warn")}
        </div>
      </div>
      <div class="compare-verdict">${verdict}</div>
    </div>`;
}

/* ------------------------------ 启动 ------------------------------ */

$("ask-form").addEventListener("submit", run);
$("settings-toggle").addEventListener("click", () => $("settings").classList.toggle("hidden"));
$("in-question").addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") run(event);
});

loadSettings();
loadOntology();
loadExamples();

// `?q=…&domain=…&key=…` 直接跑一次：演示时可以把链接直接丢给对方，
// 省掉"先粘贴问题再点运行"的来回，也便于截图存档。
const bootParams = new URLSearchParams(location.search);
if (bootParams.get("domain")) $("in-domain").value = bootParams.get("domain");
if (bootParams.get("q")) {
  $("in-question").value = bootParams.get("q");
  saveSettings();
  run();
}

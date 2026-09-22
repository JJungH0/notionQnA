// 노션 공개 위키(고정) -> 주제별 Q&A 퀴즈 서버 (의존성 없음, Node 18+)
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const NOTION_API = "https://www.notion.so/api/v3";

// 고정 노션 페이지 (Programming 위키)
const ROOT_URL = "https://app.notion.com/p/1b95c23e942f80a08134c3672cc7603e";
const MAX_CHILD_DEPTH = 2;      // 주제 페이지 -> 하위 페이지 -> 하위의 하위 페이지
const CONCURRENCY = 3;          // 하위 페이지 동시 로드 수 (높이면 노션이 429 반환)
const TOPIC_TTL = 10 * 60 * 1000;
const QUIZ_TTL = 6 * 60 * 60 * 1000;   // 생성된 퀴즈는 6시간 캐시 (디스크에도 저장)
const CACHE_FILE = path.join(__dirname, ".cache.json");
const RULES_VERSION = 4;        // 문제 생성 규칙이 바뀌면 올려서 옛 캐시를 무효화

// ---------- 유틸 ----------
function extractPageId(url) {
  const m = String(url).replace(/-/g, "").match(/([0-9a-f]{32})(?![0-9a-f])/i);
  if (!m) return null;
  const id = m[1].toLowerCase();
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 429/5xx 는 지수 백오프로 재시도
async function notionPost(endpoint, body) {
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${NOTION_API}/${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // User-Agent 가 없으면 queryCollection 이 403 을 반환함
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) NotionQuiz/1.0",
      },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();
    const text = await res.text().catch(() => "");
    lastErr = new Error(`Notion API ${endpoint} 실패 (${res.status}): ${text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 120)}`);
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get("retry-after")) * 1000;
      await sleep(retryAfter > 0 ? retryAfter : 1200 * 2 ** attempt + Math.random() * 400);
      continue;
    }
    throw lastErr;
  }
  throw lastErr;
}

function unwrap(rec) {
  if (!rec) return null;
  const v = rec.value;
  if (v && v.value && typeof v.value === "object" && v.value.id) return v.value;
  return v || null;
}

function richText(arr) {
  if (!Array.isArray(arr)) return "";
  return arr
    .map((seg) => {
      if (!Array.isArray(seg)) return "";
      const [text, decos] = seg;
      if (text === "‣" && Array.isArray(decos)) {
        const d = decos.find((x) => x[0] === "d");
        if (d && d[1] && d[1].start_date) return d[1].start_date;
        return "";
      }
      return text || "";
    })
    .join("")
    .replace(/[ \t]+/g, " ")
    .trim();
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------- 노션 데이터 로드 ----------
async function loadPage(pageId) {
  const blocks = {};
  const collections = {};
  const collectionViews = {};
  let cursor = { stack: [] };
  let chunk = 0;

  for (let i = 0; i < 30; i++) {
    const data = await notionPost("loadPageChunk", {
      pageId, limit: 100, cursor, chunkNumber: chunk++, verticalColumns: false,
    });
    const rm = data.recordMap || {};
    for (const [id, rec] of Object.entries(rm.block || {})) { const v = unwrap(rec); if (v) blocks[id] = v; }
    for (const [id, rec] of Object.entries(rm.collection || {})) { const v = unwrap(rec); if (v) collections[id] = v; }
    for (const [id, rec] of Object.entries(rm.collection_view || {})) { const v = unwrap(rec); if (v) collectionViews[id] = v; }
    if (!data.cursor || !data.cursor.stack || data.cursor.stack.length === 0) break;
    cursor = data.cursor;
  }

  // 누락된 자식 블록 보충 (페이지 블록은 별도 로드하므로 제외)
  for (let round = 0; round < 5; round++) {
    const missing = new Set();
    for (const b of Object.values(blocks)) {
      if (b.type === "page" && b.id !== pageId) continue;
      for (const cid of b.content || []) if (!blocks[cid]) missing.add(cid);
    }
    if (missing.size === 0) break;
    const ids = [...missing].slice(0, 200);
    const data = await notionPost("syncRecordValues", {
      requests: ids.map((id) => ({ pointer: { table: "block", id }, version: -1 })),
    });
    let added = 0;
    for (const [id, rec] of Object.entries((data.recordMap || {}).block || {})) {
      const v = unwrap(rec);
      if (v) { blocks[id] = v; added++; }
    }
    if (added === 0) break;
  }
  return { blocks, collections, collectionViews };
}

async function loadCollectionRows(collectionId, viewId, spaceId) {
  const data = await notionPost("queryCollection", {
    collection: { id: collectionId, spaceId },
    collectionView: { id: viewId, spaceId },
    loader: {
      type: "reducer",
      reducers: { collection_group_results: { type: "results", limit: 500 } },
      searchQuery: "",
      userTimeZone: "Asia/Seoul",
    },
  });
  const rm = data.recordMap || {};
  const rows = [];
  for (const rec of Object.values(rm.block || {})) {
    const v = unwrap(rec);
    if (v && v.type === "page" && v.parent_id === collectionId) rows.push(v);
  }
  const order = ((data.result || {}).reducerResults || {}).collection_group_results;
  if (order && Array.isArray(order.blockIds)) {
    const idx = new Map(order.blockIds.map((id, i) => [id, i]));
    rows.sort((a, b) => (idx.get(a.id) ?? 1e9) - (idx.get(b.id) ?? 1e9));
  }
  return rows;
}

// ---------- 주제(항목) 목록 ----------
let topicCache = { at: 0, data: null };

async function getTopics(force = false) {
  if (!force && topicCache.data && Date.now() - topicCache.at < TOPIC_TTL) return topicCache.data;

  const rootId = extractPageId(ROOT_URL);
  const { blocks, collections } = await loadPage(rootId);
  const root = blocks[rootId];
  if (!root) throw new Error("노션 페이지를 불러오지 못했습니다. 공개 설정을 확인해 주세요.");

  // 루트 자체 + 인라인 데이터베이스 모두 조회해서 행이 있는 것만 사용
  const dbBlocks = Object.values(blocks).filter((b) => ["collection_view_page", "collection_view"].includes(b.type));
  const topics = [];
  const seen = new Set();
  for (const db of dbBlocks) {
    const pointer = db.format && db.format.collection_pointer;
    const collectionId = db.collection_id || (pointer && pointer.id);
    const viewId = (db.view_ids || [])[0];
    const spaceId = db.space_id || (pointer && pointer.spaceId) || root.space_id;
    if (!collectionId || !viewId) continue;
    let rows = [];
    try { rows = await loadCollectionRows(collectionId, viewId, spaceId); }
    catch (e) { console.warn("데이터베이스 조회 실패:", e.message); continue; }
    const schema = (collections[collectionId] || {}).schema || {};
    const statusKey = Object.keys(schema).find((k) => schema[k].type === "status");
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      const title = richText(r.properties && r.properties.title);
      if (!title) continue;
      topics.push({
        id: r.id,
        title,
        status: statusKey ? richText(r.properties && r.properties[statusKey]) : "",
        childCount: (r.content || []).length,
      });
    }
  }
  if (!topics.length) throw new Error("주제 목록을 찾지 못했습니다.");
  const data = { title: richText(root.properties && root.properties.title) || "노션 퀴즈", topics };
  topicCache = { at: Date.now(), data };
  return data;
}

// ---------- 퀴즈 생성 ----------
const SKIP_TYPES = new Set(["code", "image", "video", "file", "pdf", "bookmark", "embed", "table", "table_row",
  "collection_view", "collection_view_page", "alias", "table_of_contents", "breadcrumb", "equation", "audio"]);
const CONTAINER_TYPES = new Set(["column_list", "column", "callout", "transclusion_container", "transclusion_reference"]);

function blockText(b) { return richText(b && b.properties && b.properties.title); }

// 페이지 최상위를 순서대로 나열. 컬럼/콜아웃은 내용물을 풀어서 같은 층으로 올림.
function sequence(rootId, blocks) {
  const out = [];
  const walk = (id, depth) => {
    const b = blocks[id];
    if (!b || depth > 8) return;
    for (const cid of b.content || []) {
      const c = blocks[cid];
      if (!c) continue;
      if (CONTAINER_TYPES.has(c.type)) {
        const t = blockText(c);
        if (t) out.push({ ...c, type: "text", content: [] });
        walk(cid, depth + 1);
      } else {
        out.push(c);
      }
    }
  };
  walk(rootId, 0);
  return out;
}

// 블록과 자식들의 텍스트를 줄 단위로 (코드/이미지/하위 페이지 제외)
function collectLines(b, blocks, depth = 0, includeSelf = true) {
  const lines = [];
  if (!b || depth > 6 || SKIP_TYPES.has(b.type) || b.type === "page") return lines;
  const t = blockText(b);
  if (includeSelf && t) lines.push(t);
  for (const cid of b.content || []) lines.push(...collectLines(blocks[cid], blocks, depth + 1, true));
  return lines;
}

const clean = (s) => String(s || "").replace(/^\s*(→|->|▶|•|\-|\*)\s*/, "").replace(/\s*[:：]\s*$/, "").trim();
const isQuestion = (s) => /[?？]\s*$/.test(s) || /(란|이란|대해서|대하여|무엇인가|어떻게|왜|차이)\s*$/.test(s);
const hasJong = (s) => { const c = s.charCodeAt(s.length - 1); return c >= 0xac00 && c <= 0xd7a3 ? (c - 0xac00) % 28 !== 0 : null; };
const eunNeun = (s) => { const j = hasJong(s); return j === null ? "은(는)" : j ? "은" : "는"; };
const eulReul = (s) => { const j = hasJong(s); return j === null ? "을(를)" : j ? "을" : "를"; };
const iran = (s) => { const j = hasJong(s); return j === null ? "(이)란" : j ? "이란" : "란"; };
const isLatin = (s) => /^[A-Za-z][A-Za-z0-9 .\-/&+#]*$/.test(s);
// 소제목/항목 표시용: "UDP 프로토콜 (= 사용자 데이터그램 프로토콜)" -> "UDP 프로토콜"
const stripDef = (s) => s.replace(/\s*\(\s*=[^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
// 용어처럼 짧고 서술어/부사어로 끝나지 않는 라벨인지
const isTermLike = (s) => s.length <= 20 && !/(다|요|음|함|됨|임|기|능|가능|없이|없는|있는|후|전|시|때|하기|하면|경우)\s*$/.test(s) && !isQuestion(s) && !/\s\d+$/.test(s);

// "용어 (= 풀이)" 파싱. "A (= a) && B (= b)" 처럼 여러 개도 지원
function parseTermDefs(s) {
  const out = [];
  for (const part of s.split(/\s*(?:&&|\|\|)\s*/)) {
    const m = part.match(/^(.+?)\s*\(\s*=\s*(.+?)\s*\)\s*$/);
    if (m && m[1].length <= 40 && m[2].length <= 80) out.push({ term: m[1].trim(), def: m[2].trim() });
  }
  return out;
}

// "→ 항목 - 설명" 한 줄 파싱
function parseItemDesc(line) {
  const s = clean(line);
  let m = s.match(/^(.{1,25}?)\s+[-–—]\s+(.{2,})$/);
  // 항목에 쉼표가 있거나("S는 단일, O는 개방 - 폐쇄"), 두 글자 이하 한글("개방 - 폐쇄 원칙")이면 복합어로 보고 제외
  if (m && isTermLike(m[1].trim()) && !/,/.test(m[1]) && !(/^[가-힣]{1,2}$/.test(m[1].trim())))
    return { item: m[1].trim(), desc: m[2].trim() };
  m = s.match(/^(.{1,20}?)\s*\(\s*=\s*(.{2,}?)\s*\)\s*$/);
  // "(= ...)" 형태는 항목이 3단어 이하일 때만 (긴 설명문 + 예시 괄호는 제외)
  if (m && isTermLike(m[1].trim()) && m[1].trim().split(/\s+/).length <= 3) return { item: m[1].trim(), desc: m[2].trim() };
  return null;
}

function makeItem(type, q, a, ctx) {
  a = String(a).trim();
  q = String(q).trim();
  if (!q || !a || a.length < 1) return null;
  if (type === "short" && a.length > 60) type = "long";
  return { type, q, a, ctx };
}

// 한 페이지에서 퀴즈 항목 추출
function extractFromPage(pageId, blocks, ctxPrefix) {
  const seq = sequence(pageId, blocks);
  const items = [];
  const push = (it) => { if (it) items.push(it); };

  // 섹션: quote(주제) + 다음 quote/divider 전까지의 블록
  const sections = [];
  let cur = null;
  for (const b of seq) {
    if (b.type === "page") continue;
    if (b.type === "quote" || ["header", "sub_header", "sub_sub_header"].includes(b.type)) {
      cur = { title: blockText(b), body: [] };
      sections.push(cur);
    } else if (b.type === "divider") {
      cur = null;
    } else if (cur) {
      cur.body.push(b);
    }
  }

  for (const sec of sections) {
    const topicRaw = sec.title;
    if (!topicRaw) continue;
    const topicIsQuestion = isQuestion(topicRaw);
    const defs = topicIsQuestion ? [] : parseTermDefs(topicRaw);
    // 주제 표시용 이름: "DNS (= Domain Name System)" -> "DNS"
    const topic = defs.length ? defs.map((d) => d.term).join(" / ") : stripDef(topicRaw.replace(/\s*[:：]\s*$/, ""));
    // 질문문 주제는 문맥 표시에서 제외 (문제 자체가 질문이므로)
    const ctx = topicIsQuestion ? ctxPrefix : (ctxPrefix ? `${ctxPrefix} › ${topic}` : topic);
    const bodyLines = sec.body.flatMap((b) => collectLines(b, blocks));

    // 규칙 1: 주제가 질문문이면 그대로 문제, 본문이 정답
    if (topicIsQuestion && bodyLines.length) {
      push(makeItem("long", topicRaw, bodyLines.join("\n"), ctxPrefix));
    }

    // 이 섹션에 "정의 :" 소제목이 있는지 (있으면 정의가 곧 "X란?"의 정답)
    const hasDefinition = sec.body.some((b) => /^(정의|개념|뜻|의미|설명)$/.test(stripDef(clean(blockText(b)))) && (b.content || []).length);

    // 규칙 2: "용어 (= 풀이)" 단답
    //  - 약어 (= 원어)      : DNS (= Domain Name System)  -> 풀네임 문제 (양방향)
    //  - 용어 (= 한글 설명) : TCP (= 기본 통신 규약)        -> "TCP란?" + "…을 가리키는 용어는?"
    //  - 한글 용어 (= 영어 번역) : 싱글톤 패턴 (= Singleton Pattern) -> 단순 번역이므로 문제로 만들지 않음
    for (const { term, def } of defs) {
      if (isQuestion(def) || isQuestion(term)) continue;
      const defLatin = isLatin(def), termLatin = isLatin(term);
      if (defLatin && termLatin) {
        push(makeItem("short", `${term}의 풀네임(원어)은?`, def, ctx));
        push(makeItem("short", `"${def}"${eulReul(def)} 줄여서 부르는 용어는?`, term, ctx));
      } else if (!defLatin && !isQuestion(def)) {
        // "IP (= 인터넷 프로토콜)" 처럼 풀이가 짧은 이름이면 설명 문제로 부적합 -> 설명문(12자 이상)일 때만 "X란?" 생성
        const descriptive = def.length >= 12 && def.split(/\s+/).length >= 3;
        if (descriptive && !hasDefinition) push(makeItem("short", `${term}${iran(term)}? (한 줄로 설명)`, def, ctx));
        if (def.length >= 8 && def.length <= 60) push(makeItem("short", `"${def}"${eulReul(def)} 가리키는 용어는?`, term, ctx));
      }
    }

    // 규칙 3~5: 소제목(토글/글머리) -> 내용
    for (const b of sec.body) {
      if (SKIP_TYPES.has(b.type)) continue;
      const labelRaw = clean(blockText(b));
      const label = clean(stripDef(labelRaw));   // "리스코프 치환 원칙 : (= LSP)" -> "리스코프 치환 원칙"
      const labelDefs = parseTermDefs(labelRaw);          // "클래스 (= Class)" -> [{term:클래스, def:Class}]
      const childLines = (b.content || []).flatMap((cid) => collectLines(blocks[cid], blocks));

      if (label && childLines.length) {
        // 소제목에 붙은 영어 표기는 정답 앞에 참고로 덧붙임 (정답은 항상 아래 설명)
        const alias = labelDefs.filter((d) => isLatin(d.def)).map((d) => d.def).join(", ");
        const answer = (alias ? `(${alias})\n` : "") + childLines.join("\n");
        if (/^(정의|개념|뜻|의미|설명)$/.test(label)) {
          push(makeItem("long", `'${topic}'의 정의${eunNeun("정의")}?`, childLines.join("\n"), ctx));
        } else if (isQuestion(label)) {
          push(makeItem("long", label, childLines.join("\n"), ctx));
        } else if (label.length > 40) {
          // 긴 문장은 소제목이 아니라 본문 -> 건너뜀 (규칙 1이 이미 포함)
        } else if (isTermLike(label) && childLines.length === 1 && childLines[0].length <= 70) {
          // "Commit" -> "→ 파일의 변경 사항을 저장하는 명령" : 용어 -> 짧은 설명
          push(makeItem("short", `[${topic}] ${label}${iran(label)}?`, clean(childLines[0]), ctx));
        } else if (isTermLike(label)) {
          push(makeItem("long", `[${topic}] ${label}${iran(label)}? (설명해 보세요)`, answer, ctx));
        } else {
          push(makeItem("long", `[${topic}] "${label}" 에 대해 설명해 보세요.`, answer, ctx));
        }
        // 규칙 4: 소제목 아래 "→ 항목 - 설명" 줄들
        if (label.length <= 40) {
          for (const line of childLines) {
            const pd = parseItemDesc(line);
            // "즉시 로딩 (= EAGER)" 처럼 한글 항목의 영어 표기만 있는 줄은 문제로 만들지 않음
            if (pd && !/^\d+$/.test(pd.item) && !(isLatin(pd.desc) && !isLatin(pd.item))) {
              push(makeItem("short", `[${topic} · ${label}] ${pd.item}${eunNeun(pd.item)}?`, pd.desc, ctx));
            }
          }
        }
        // 소제목이 "약어 (= 원어)" 형태면 풀네임 문제만 추가 (한글 용어의 영어 번역은 제외)
        for (const { term, def } of labelDefs) {
          if (isLatin(term) && isLatin(def) && term.length <= 12) push(makeItem("short", `[${topic}] ${term}의 풀네임(원어)은?`, def, ctx));
        }
      } else if (labelRaw && !childLines.length && b.type !== "text") {
        // 자식 없는 글머리 한 줄: "→ 항목 - 설명" 또는 "용어 (= 한글 설명)"
        const pd = parseItemDesc(labelRaw);
        if (pd && !(isLatin(pd.desc) && !isLatin(pd.item))) {
          push(makeItem("short", `[${topic}] ${pd.item}${eunNeun(pd.item)}?`, pd.desc, ctx));
        } else if (!pd) {
          for (const { term, def } of labelDefs) {
            if (isLatin(term) && isLatin(def)) push(makeItem("short", `[${topic}] ${term}의 풀네임(원어)은?`, def, ctx));
          }
        }
      }
    }
  }

  // 섹션이 하나도 없는 페이지(제목만 있는 목차 페이지 등)는 항목 없음
  return items;
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((it) => {
    const k = it.q.toLowerCase().replace(/\s+/g, "") + "|" + it.a.toLowerCase().replace(/\s+/g, "");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// 퀴즈 캐시 (메모리 + 디스크). 노션 요청이 많아 재시작 후에도 재사용
const quizCache = new Map(); // topicId -> {at, data}
try {
  const saved = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  for (const [k, v] of Object.entries(saved)) if (v && v.version === RULES_VERSION) quizCache.set(k, v);
} catch { /* 캐시 없음 */ }
function persistCache() {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(quizCache))); }
  catch (e) { console.warn("캐시 저장 실패:", e.message); }
}

const inflight = new Map(); // 동일 주제 동시 요청 합치기

async function buildTopicQuiz(topicId, force = false) {
  const cached = quizCache.get(topicId);
  if (!force && cached && Date.now() - cached.at < QUIZ_TTL) return cached.data;
  if (inflight.has(topicId)) return inflight.get(topicId);

  const job = (async () => {
    const items = [];
    const visited = new Set();
    const pagesLoaded = [];
    const failed = [];

    async function visit(pageId, depth, parentCtx) {
      if (visited.has(pageId) || depth > MAX_CHILD_DEPTH) return;
      visited.add(pageId);
      const { blocks } = await loadPage(pageId);
      const page = blocks[pageId];
      if (!page) return;
      const title = blockText(page);
      pagesLoaded.push(title);
      // 문맥: 주제 페이지 자체는 생략, 하위 페이지는 "상위 › 하위" 제목
      const myCtx = depth === 0 ? "" : (parentCtx ? `${parentCtx} › ${title}` : title);
      items.push(...extractFromPage(pageId, blocks, myCtx));

      // 하위 페이지 (본문에 포함된 page 블록만)
      const childIds = sequence(pageId, blocks).filter((b) => b.type === "page" && b.parent_id === pageId).map((b) => b.id);
      await mapLimit(childIds, CONCURRENCY, (cid) =>
        visit(cid, depth + 1, myCtx).catch((e) => { failed.push(cid); console.warn("하위 페이지 실패:", cid, e.message); }));
    }

    await visit(topicId, 0, "");
    const data = {
      id: topicId,
      title: pagesLoaded[0] || "",
      pages: pagesLoaded.length,
      failedPages: failed.length,
      items: dedupe(items),
    };
    // 일부 실패했더라도 결과는 돌려주되, 캐시는 완전한 경우에만 길게 보관
    quizCache.set(topicId, { version: RULES_VERSION, at: failed.length ? Date.now() - QUIZ_TTL + 60 * 1000 : Date.now(), data });
    persistCache();
    return data;
  })();

  inflight.set(topicId, job);
  try { return await job; }
  catch (e) {
    // 노션 오류 시 만료된 캐시라도 있으면 그것을 사용
    if (cached) return cached.data;
    throw e;
  }
  finally { inflight.delete(topicId); }
}

// ---------- HTTP 서버 ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ico": "image/x-icon",
};

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (u.pathname === "/api/topics") {
      return sendJson(res, 200, await getTopics(u.searchParams.has("refresh")));
    }
    const m = u.pathname.match(/^\/api\/quiz\/([0-9a-f-]{36})$/);
    if (m) {
      return sendJson(res, 200, await buildTopicQuiz(m[1], u.searchParams.has("refresh")));
    }
  } catch (e) {
    console.error(e);
    return sendJson(res, 500, { error: e.message });
  }

  const file = u.pathname === "/" ? "/index.html" : u.pathname;
  const fp = path.join(__dirname, "public", path.normalize(file).replace(/^(\.\.[/\\])+/, ""));
  fs.readFile(fp, (err, data) => {
    if (err) { res.statusCode = 404; res.end("Not found"); return; }
    res.setHeader("Content-Type", MIME[path.extname(fp)] || "application/octet-stream");
    res.end(data);
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`노션 퀴즈 서버 실행 중: http://localhost:${PORT}`);
    console.log(`노션 페이지: ${ROOT_URL}`);
  });
}

module.exports = { getTopics, buildTopicQuiz, extractFromPage, loadPage, richText };

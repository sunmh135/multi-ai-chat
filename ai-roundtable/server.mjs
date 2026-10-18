import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const INSTANCE_ID = createHash('sha256').update(process.platform === 'win32' ? ROOT.toLowerCase() : ROOT).digest('hex');
const PUBLIC = path.join(ROOT, 'public');
const DATA = process.env.AI_ROUNDTABLE_DATA_DIR || path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 8765);
const HOST = process.env.HOST || '127.0.0.1';
const AUTO_EXIT = process.env.AI_ROUNDTABLE_AUTO_EXIT === '1';
const AUTH_USER = process.env.APP_USER || '';
const AUTH_PASSWORD = process.env.APP_PASSWORD || '';
const isLoopback = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
if (Boolean(AUTH_USER) !== Boolean(AUTH_PASSWORD)) {
  throw new Error('APP_USER 和 APP_PASSWORD 必须同时设置');
}
if (!isLoopback && (!AUTH_USER || !AUTH_PASSWORD)) {
  throw new Error('公网监听必须设置 APP_USER 和 APP_PASSWORD');
}
const DEFAULT_ROUNDS = 5;
const MAX_ROUNDS = 10;
const TYPES = {
  deepseek: { label: 'DeepSeek', model: 'deepseek-flash', url: 'https://api.deepseek.com/chat/completions', role: '逻辑分析师' },
  qwen: { label: '通义千问', model: 'qwen-plus', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', role: '综合研究员' },
  glm: { label: '智谱 GLM', model: 'glm-4-flash', url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', role: '批评者' },
  volcengine: { label: '豆包', model: 'doubao-seed-2-1-lite-260915', url: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions', role: '讨论成员' },
  custom: { label: '自定义', model: '', url: '', role: '讨论成员' },
};
const active = new Map();
const deletedIds = new Set();
const browserClients = new Set();
let browserExitTimer = null;
let shuttingDown = false;
fs.mkdirSync(DATA, { recursive: true });

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temp, file);
}
function connectionType(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return 'custom'; }
  return host === 'api.deepseek.com' ? 'deepseek'
    : host === 'dashscope.aliyuncs.com' || host.endsWith('.maas.aliyuncs.com') ? 'qwen'
    : host === 'open.bigmodel.cn' ? 'glm'
    : host === 'ark.cn-beijing.volces.com' ? 'volcengine' : 'custom';
}
function readConnections() {
  const value = readJson(path.join(DATA, 'connections.json'), []);
  return Array.isArray(value) ? value.map(item => ({ ...item, type: connectionType(item.url) })) : [];
}
function readAgents() {
  return readConnections().map(connection => ({
    id: connection.id, type: connection.type, name: connection.name,
    role: TYPES[connection.type]?.role || TYPES.custom.role, connectionId: connection.id,
  }));
}
function readKeys() { return readJson(path.join(DATA, 'keys.json'), {}); }
function publicSetup() {
  const keys = readKeys();
  return { instanceId: INSTANCE_ID, autoExit: AUTO_EXIT, types: TYPES, rounds: DEFAULT_ROUNDS, maxRounds: MAX_ROUNDS, connections: readConnections().map(item => ({ ...item, hasKey: Boolean(keys[item.id]) })), agents: readAgents() };
}
function scheduleBrowserExit(delay = 10_000) {
  clearTimeout(browserExitTimer);
  if (!AUTO_EXIT || browserClients.size || shuttingDown) return;
  browserExitTimer = setTimeout(() => {
    void shutdownDesktop().catch(error => { console.error('退出时保存失败：', error.message); process.exit(1); });
  }, delay);
  browserExitTimer.unref();
}
async function shutdownDesktop() {
  if (browserClients.size || shuttingDown) return;
  shuttingDown = true;
  const runs = [...active.values()];
  for (const run of runs) {
    run.item.status = 'stopped'; run.item.current = null;
    run.controller.abort(); saveDiscussion(run.item);
  }
  server.close();
  server.closeAllConnections();
  await Promise.race([
    Promise.all(runs.map(run => run.done)),
    new Promise(resolve => setTimeout(resolve, 4000).unref()),
  ]);
  process.exit(0);
}
function attachBrowser(req, res) {
  if (!AUTO_EXIT) { res.writeHead(204); return res.end(); }
  if (shuttingDown) return fail(res, 503, '程序正在退出，请重新启动');
  if (req.headers.origin) {
    try { if (new URL(req.headers.origin).host !== req.headers.host) return fail(res, 403, '请求来源无效'); }
    catch { return fail(res, 403, '请求来源无效'); }
  }
  clearTimeout(browserExitTimer);
  browserClients.add(res);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 1000\n\n: connected\n\n');
  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
  keepAlive.unref();
  res.on('close', () => {
    clearInterval(keepAlive);
    browserClients.delete(res);
    scheduleBrowserExit();
  });
}
function cleanText(value, label, max = 80) {
  const text = String(value || '').trim();
  if (!text || text.length > max) throw new Error(`${label}需填写 1～${max} 个字符`);
  return text;
}
function normalizeConnection(input, existing = {}) {
  const name = cleanText(input.name ?? existing.name, '成员名称', 60);
  const model = cleanText(input.model ?? existing.model, '模型名称', 80);
  if (!/^[\w./:-]{2,80}$/.test(model)) throw new Error('模型名称格式无效');
  const url = String(input.url ?? existing.url ?? '').trim();
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('请输入完整的 API 地址'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('API 地址必须以 https:// 开头，且不能包含用户名或密码');
  const type = connectionType(parsed.toString());
  return { id: existing.id || randomUUID(), type, name, model, url: parsed.toString() };
}
function discussionFile(id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('无效的讨论编号');
  return path.join(DATA, `${id}.json`);
}
function getDiscussion(id) { return readJson(discussionFile(id), null); }
function saveDiscussion(item) {
  if (deletedIds.has(item.id)) return;
  item.updatedAt = new Date().toISOString();
  writeJson(discussionFile(item.id), item);
}
function listDiscussions() {
  return fs.readdirSync(DATA).filter(name => /^[0-9a-f-]{36}\.json$/.test(name))
    .map(name => readJson(path.join(DATA, name), null)).filter(Boolean)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
function respond(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}
function fail(res, status, message) { respond(res, status, { error: message }); }
async function bodyJson(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new Error('请求数据格式不正确');
  let raw = '';
  for await (const part of req) { raw += part; if (raw.length > 100_000) throw new Error('请求过大'); }
  return JSON.parse(raw || '{}');
}
function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function isAuthenticated(req) {
  if (isLoopback && !AUTH_USER && !AUTH_PASSWORD) return true;
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Basic ')) return false;
  let supplied;
  try { supplied = Buffer.from(header.slice(6), 'base64').toString('utf8'); } catch { return false; }
  const separator = supplied.indexOf(':');
  if (separator < 0) return false;
  return safeEqual(supplied.slice(0, separator), AUTH_USER) && safeEqual(supplied.slice(separator + 1), AUTH_PASSWORD);
}
function isSameOriginMutation(req) {
  if (!['POST', 'PUT', 'DELETE'].includes(req.method)) return true;
  const origin = String(req.headers.origin || '');
  const host = String(req.headers.host || '');
  try { return Boolean(origin && host && new URL(origin).host === host); }
  catch { return false; }
}

function legacyAgents() {
  const connections = readConnections();
  return ['deepseek', 'qwen', 'glm'].map(type => ({ id: `legacy-${type}`, type, name: TYPES[type].label, role: TYPES[type].role, connectionId: connections.find(item => item.type === type)?.id || null }));
}
function runAgents(item) { return item.agents || legacyAgents(); }
function displayName(item, message) {
  return message.name || runAgents(item).find(agent => agent.id === message.agentId || agent.type === message.provider)?.name || TYPES[message.provider]?.label || '智能助手';
}
function promptFor(agent, round, count, totalRounds) {
  const guidance = totalRounds === 1 ? '请给出核心观点、理由和保留意见。'
    : round === 1 ? '提出核心观点。'
    : round === totalRounds ? '回应前述观点，给出最终判断和保留意见。'
    : '回应其他 AI 的具体观点并推进讨论。';
  return `你是圆桌成员“${agent.name}”，讨论角色：${agent.role}。这是第 ${round}/${totalRounds} 轮，共 ${count} 位 AI 轮流发言。请直接用中文发言，避免重复，控制在 250 字左右。不要假称已联网查证，不要编造来源。${guidance}`;
}
function conversationInput(item, round) {
  const history = item.messages.slice(-12).map(m => `第${m.round}轮 ${displayName(item, m)}：${m.content.slice(0, 1500)}`).join('\n\n');
  const followUp = item.followUps?.at(-1);
  const latest = followUp ? `用户最新追加要求（请以此为本阶段讨论重点）：\n${followUp.text}\n\n` : '';
  return `原讨论问题：${item.question}\n\n${history ? `已有发言：\n${history}\n\n` : ''}${latest}请发表你在第 ${round} 轮的观点，明确回应用户最新要求和有价值的前述论点。`;
}
async function streamCompletion(agent, messages, onText, controller) {
  const connection = readConnections().find(item => item.id === agent.connectionId);
  const key = readKeys()[agent.connectionId];
  if (!connection || !key) throw new Error(`${agent.name} 未配置可用的接口，请在“成员列表”中检查密钥`);
  const timeout = AbortSignal.timeout(120_000);
  const signal = AbortSignal.any([controller.signal, timeout]);
  let response;
  try { response = await fetch(connection.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: connection.model, messages, stream: true }),
    signal,
  }); } catch (error) {
    if (timeout.aborted && !controller.signal.aborted) throw new Error(`${connection.name} 请求超过 2 分钟仍未响应，请稍后点击“继续”`);
    throw error;
  }
  if (!response.ok) {
    let detail = '', code = '';
    try {
      const error = await response.json();
      code = String(error.error?.code || error.code || '').slice(0, 20);
      detail = String(error.error?.message || error.message || '').slice(0, 160).replaceAll(key, '[密钥已隐藏]');
    } catch {}
    if (response.status === 429) throw new Error(`${connection.name} 暂时无法调用（状态码 429${code ? `，错误码 ${code}` : ''}）${detail ? `：${detail}` : '。请稍后重试或查看平台额度与限流设置'}`);
    if (response.status === 402) throw new Error(`${agent.name} 使用的 ${connection.name} 余额不足（状态码 402）。补足后点击“继续”`);
    if (response.status === 401 || response.status === 403) throw new Error(`${connection.name} 的密钥未通过验证（状态码 ${response.status}）${detail ? `：${detail}` : ''}`);
    throw new Error(`${connection.name} 请求失败（状态码 ${response.status}）${detail ? `：${detail}` : ''}`);
  }
  if (!response.body) throw new Error(`${connection.name} 未返回内容`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', output = '', reasoningSeen = false, finishReason = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const chunk = JSON.parse(data);
          const choice = chunk.choices?.[0];
          const text = choice?.delta?.content;
          if (choice?.delta?.reasoning_content) reasoningSeen = true;
          if (choice?.finish_reason) finishReason = String(choice.finish_reason);
          if (typeof text === 'string' && text) { output += text; onText(output); }
        } catch {}
      }
    }
  } catch (error) {
    if (timeout.aborted && !controller.signal.aborted) throw new Error(`${connection.name} 等待模型输出超过 2 分钟，请稍后点击“继续”`);
    throw error;
  }
  if (controller.signal.aborted) throw new Error('已停止');
  if (!output.trim()) throw new Error(reasoningSeen
    ? `${connection.name} 只返回了思考过程，没有生成正文${finishReason ? `（${finishReason}）` : ''}；请稍后重试或更换模型`
    : `${connection.name} 返回了空内容${finishReason ? `（${finishReason}）` : ''}，请检查模型状态`);
  return output.trim();
}
async function waitForResume(item, controller) {
  while (item.status === 'paused' && !controller.signal.aborted) await new Promise(resolve => setTimeout(resolve, 200));
  if (controller.signal.aborted) throw new Error('已停止');
}
async function runDiscussion(item) {
  if (active.has(item.id) || deletedIds.has(item.id)) return;
  if (!item.agents || item.agents.every(agent => agent.id.startsWith('legacy-'))) {
    const available = legacyAgents();
    item.agents = (item.agents || available).map(agent => ({
      ...agent,
      connectionId: readConnections().some(connection => connection.id === agent.connectionId)
        ? agent.connectionId
        : available.find(candidate => candidate.type === agent.type)?.connectionId || null,
    }));
    saveDiscussion(item);
  }
  const controller = new AbortController();
  const activeRun = { controller, item };
  activeRun.done = new Promise(resolve => { activeRun.resolveDone = resolve; });
  active.set(item.id, activeRun);
  item.status = 'running'; item.error = null; saveDiscussion(item);
  try {
    const phase = item.phase || { startMessageCount: 0, startRound: 1, rounds: Number.isInteger(item.rounds) && item.rounds >= 1 ? item.rounds : DEFAULT_ROUNDS };
    phase.agents ||= structuredClone(runAgents(item));
    item.phase = phase; saveDiscussion(item);
    const agents = phase.agents;
    for (let step = item.messages.length - phase.startMessageCount; step < agents.length * phase.rounds; step++) {
      await waitForResume(item, controller);
      const agent = agents[step % agents.length];
      const phaseRound = Math.floor(step / agents.length) + 1;
      const round = phase.startRound + phaseRound - 1;
      item.current = { agentId: agent.id, provider: agent.type, name: agent.name, role: agent.role, round, content: '' };
      saveDiscussion(item);
      let lastSave = 0;
      const content = await streamCompletion(agent, [
        { role: 'system', content: promptFor(agent, phaseRound, agents.length, phase.rounds) },
        { role: 'user', content: conversationInput(item, round) },
      ], value => { item.current.content = value; if (Date.now() - lastSave > 120) { saveDiscussion(item); lastSave = Date.now(); } }, controller);
      if (controller.signal.aborted) throw new Error('已停止');
      item.messages.push({ agentId: agent.id, provider: agent.type, name: agent.name, role: agent.role, round, content, createdAt: new Date().toISOString() });
      item.current = null; saveDiscussion(item);
    }
    await waitForResume(item, controller);
    item.current = null; item.status = 'completed'; saveDiscussion(item);
  } catch (error) {
    item.current = null;
    if (controller.signal.aborted && item.status !== 'running') item.status = 'stopped';
    else if (!controller.signal.aborted) { item.status = 'error'; item.error = String(error.message || error); }
    saveDiscussion(item);
  } finally {
    active.delete(item.id);
    activeRun.resolveDone();
    if (item.status === 'running' && controller.signal.aborted && !deletedIds.has(item.id)) void runDiscussion(item);
  }
}
function serveStatic(res, pathname) {
  const file = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!['index.html', 'style.css', 'app.js', 'api-catalog.js', 'vendor/marked.esm.js', 'vendor/purify.es.mjs', 'icons/deepseek.svg', 'icons/qwen.svg', 'icons/zhipu.svg', 'icons/deepseek-app.jpg', 'icons/qwen-app.jpg', 'icons/zhipu-app.jpg', 'icons/doubao-avatar.jpg', 'icons/custom.svg'].includes(file)) return fail(res, 404, '页面不存在');
  const types = { html: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', svg: 'image/svg+xml', jpg: 'image/jpeg' };
  const content = fs.readFileSync(path.join(PUBLIC, file));
  res.writeHead(200, { 'Content-Type': `${types[file.split('.').pop()]}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(content);
}

const server = http.createServer(async (req, res) => {
  if (!isAuthenticated(req)) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Multi AI Chat", charset="UTF-8"');
    return fail(res, 401, '请先登录');
  }
  if (!isSameOriginMutation(req)) return fail(res, 403, '请求来源无效');
  const pathname = new URL(req.url, `http://${HOST}:${PORT}`).pathname;
  try {
    if (req.method === 'GET' && pathname === '/api/browser-presence') return attachBrowser(req, res);
    if (req.method === 'GET' && pathname === '/api/setup') return respond(res, 200, publicSetup());
    if (req.method === 'POST' && pathname === '/api/connections') {
      const input = await bodyJson(req);
      const connections = readConnections();
      if (connections.length >= 40) throw new Error('最多添加 40 位成员');
      const connection = normalizeConnection(input);
      connections.push(connection); writeJson(path.join(DATA, 'connections.json'), connections);
      if (String(input.key || '').trim()) { const keys = readKeys(); keys[connection.id] = input.key.trim(); writeJson(path.join(DATA, 'keys.json'), keys); }
      return respond(res, 201, { ...connection, hasKey: Boolean(readKeys()[connection.id]) });
    }
    const connectionMatch = pathname.match(/^\/api\/connections\/([0-9a-f-]{36})$/);
    if (connectionMatch && ['PUT', 'DELETE'].includes(req.method)) {
      const connections = readConnections();
      const index = connections.findIndex(item => item.id === connectionMatch[1]);
      if (index < 0) return fail(res, 404, '成员不存在');
      if (req.method === 'DELETE') {
        connections.splice(index, 1); writeJson(path.join(DATA, 'connections.json'), connections);
        const keys = readKeys(); delete keys[connectionMatch[1]]; writeJson(path.join(DATA, 'keys.json'), keys);
        return respond(res, 200, { deleted: true });
      }
      const input = await bodyJson(req);
      const connection = normalizeConnection(input, connections[index]);
      connections[index] = connection; writeJson(path.join(DATA, 'connections.json'), connections);
      const keys = readKeys();
      if (input.clearKey === true) delete keys[connection.id];
      else if (String(input.key || '').trim()) keys[connection.id] = input.key.trim();
      writeJson(path.join(DATA, 'keys.json'), keys);
      return respond(res, 200, { ...connection, hasKey: Boolean(keys[connection.id]) });
    }
    if (req.method === 'GET' && pathname === '/api/discussions') {
      return respond(res, 200, listDiscussions().map(({ id, question, status, updatedAt, messages }) => ({ id, question, status, updatedAt, count: messages.length })));
    }
    if (req.method === 'POST' && pathname === '/api/discussions') {
      const input = await bodyJson(req);
      const question = String(input.question || '').trim();
      if (question.length < 3 || question.length > 2000) throw new Error('请输入 3～2000 字的问题');
      const rounds = input.rounds === undefined ? DEFAULT_ROUNDS : input.rounds;
      if (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_ROUNDS) throw new Error(`讨论轮数需为 1～${MAX_ROUNDS} 的整数`);
      const connectionIds = input.connectionIds;
      if (!Array.isArray(connectionIds) || connectionIds.length < 2 || connectionIds.length > 40 || new Set(connectionIds).size !== connectionIds.length || connectionIds.some(id => typeof id !== 'string')) {
        throw new Error('请在讨论组中选择 2～40 位不同的成员');
      }
      const keys = readKeys();
      const available = new Map(readAgents().map(agent => [agent.connectionId, agent]));
      const agents = connectionIds.map(id => available.get(id));
      if (agents.some(agent => !agent)) throw new Error('讨论组中有成员已不存在，请刷新页面后重试');
      if (agents.some(agent => !keys[agent.connectionId])) throw new Error('请先为讨论组中的所有成员配置 API Key');
      const item = { id: randomUUID(), question, agents: structuredClone(agents), rounds, phase: { startMessageCount: 0, startRound: 1, rounds, agents: structuredClone(agents) }, followUps: [], status: 'new', messages: [], current: null, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      saveDiscussion(item); void runDiscussion(item); return respond(res, 201, item);
    }
    const match = pathname.match(/^\/api\/discussions\/([0-9a-f-]{36})(?:\/(pause|resume|stop|followup|agents))?$/);
    if (match) {
      const activeRun = active.get(match[1]);
      const item = activeRun?.item || getDiscussion(match[1]);
      if (!item) return fail(res, 404, '讨论不存在');
      if (req.method === 'GET' && !match[2]) return respond(res, 200, item);
      if (req.method === 'DELETE' && !match[2]) {
        deletedIds.add(item.id);
        activeRun?.controller.abort();
        fs.unlinkSync(discussionFile(item.id));
        return respond(res, 200, { deleted: true });
      }
      if (req.method === 'PUT' && match[2] === 'agents') {
        const input = await bodyJson(req);
        if (!['add', 'replace', 'remove'].includes(input.action)) return fail(res, 400, '无效的成员操作');
        const agents = [...runAgents(item)];
        const index = input.index;
        if (input.action !== 'add' && (!Number.isInteger(index) || index < 0 || index >= agents.length)) return fail(res, 400, '成员不存在');
        if (input.action === 'remove') {
          if (agents.length <= 2) return fail(res, 400, '讨论至少需要 2 位成员；请先添加新成员');
          agents.splice(index, 1);
        } else {
          const connection = readConnections().find(entry => entry.id === input.connectionId);
          if (!connection || !readKeys()[connection.id]) return fail(res, 400, '请选择已配置密钥的成员');
          if (agents.some((agent, position) => agent.connectionId === connection.id && (input.action === 'add' || position !== index))) return fail(res, 400, '该成员已在讨论中');
          const agent = { id: connection.id, type: connection.type, name: connection.name, role: TYPES[connection.type]?.role || TYPES.custom.role, connectionId: connection.id };
          if (input.action === 'add') {
            if (agents.length >= 40) return fail(res, 400, '最多添加 40 位成员');
            agents.push(agent);
          } else agents[index] = agent;
        }
        item.agents = agents; saveDiscussion(item);
        return respond(res, 200, item);
      }
      if (req.method === 'POST' && match[2] === 'followup') {
        if (!['completed', 'stopped'].includes(item.status) || active.has(item.id)) return fail(res, 409, '请等本阶段讨论完成或停止后再发送新消息');
        const input = await bodyJson(req);
        const text = cleanText(input.message, '追加消息', 2000);
        const rounds = input.rounds === undefined ? 1 : input.rounds;
        if (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_ROUNDS) return fail(res, 400, `追加轮数需为 1～${MAX_ROUNDS} 的整数`);
        const connections = readConnections();
        const keys = readKeys();
        if (runAgents(item).length < 2 || runAgents(item).some(agent => !connections.some(connection => connection.id === agent.connectionId) || !keys[agent.connectionId])) {
          return fail(res, 409, '原讨论成员的接口或密钥已缺失，请先恢复对应成员');
        }
        item.followUps ||= [];
        item.followUps.push({ text, rounds, afterMessageCount: item.messages.length, createdAt: new Date().toISOString() });
        const lastRound = item.messages.at(-1)?.round || 0;
        const startRound = lastRound + 1;
        item.phase = { startMessageCount: item.messages.length, startRound, rounds, agents: structuredClone(runAgents(item)) };
        item.rounds = startRound + rounds - 1;
        item.current = null; item.error = null; item.status = 'new';
        saveDiscussion(item); void runDiscussion(item);
        return respond(res, 201, item);
      }
      if (req.method === 'POST' && match[2] === 'pause' && item.status === 'running') { item.status = 'paused'; saveDiscussion(item); return respond(res, 200, item); }
      if (req.method === 'POST' && match[2] === 'resume' && ['paused', 'error'].includes(item.status)) {
        item.error = null; item.status = 'running'; saveDiscussion(item);
        if (!active.has(item.id)) void runDiscussion(item);
        return respond(res, 200, item);
      }
      if (req.method === 'POST' && match[2] === 'stop' && ['running', 'paused'].includes(item.status)) {
        item.status = 'stopped'; item.current = null; activeRun?.controller.abort(); saveDiscussion(item);
        if (activeRun) await activeRun.done;
        return respond(res, 200, item);
      }
      return fail(res, 409, '当前状态不支持此操作');
    }
    if (req.method === 'GET' && !pathname.startsWith('/api/')) return serveStatic(res, pathname);
    return fail(res, 404, '接口不存在');
  } catch (error) { return fail(res, 400, String(error.message || error)); }
});

for (const item of listDiscussions()) {
  if (['running', 'paused'].includes(item.status)) { item.status = 'stopped'; item.current = null; saveDiscussion(item); }
}
server.once('close', () => clearTimeout(browserExitTimer));
server.listen(PORT, HOST, () => {
  console.log(`多AI聊天平台已启动：http://${HOST}:${PORT}`);
  scheduleBrowserExit(120_000);
});
export { server };

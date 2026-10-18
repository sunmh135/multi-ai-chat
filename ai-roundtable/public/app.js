import { marked } from './vendor/marked.esm.js';
import DOMPurify from './vendor/purify.es.mjs';
import { API_PRESETS } from './api-catalog.js';

const $ = id => document.getElementById(id);
let setup = { types: {}, connections: [], agents: [], rounds: 5, maxRounds: 10 };
let currentId = null;
let currentItem = null;
let editingId = null;
let toastTimer = null;
let followupPending = false;
let historyMenuItem = null;
let participantEditIndex = null;
let browserPresence = null;
function connectBrowserPresence() {
  if (setup.autoExit && !browserPresence) browserPresence = new EventSource('/api/browser-presence');
}
window.addEventListener('pagehide', () => { browserPresence?.close(); browserPresence = null; });
window.addEventListener('pageshow', connectBrowserPresence);
let groupIds = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem('ai-roundtable-group') || '[]');
    return Array.isArray(saved) ? saved.filter(id => typeof id === 'string') : [];
  } catch { return []; }
})();

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: options.body ? { 'Content-Type': 'application/json' } : {} });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `请求失败（${response.status}）`);
  return result;
}
function toast(message) {
  const box = $('toast'); box.textContent = message; box.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => box.classList.remove('show'), 3500);
}
function dateLabel(iso) { return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)); }
function statusLabel(status) { return { new: '待开始', running: '讨论中', paused: '已暂停', stopped: '已停止', error: '需要处理', completed: '已完成' }[status] || status; }
function connectionFor(agent) { return setup.connections.find(item => item.id === agent.connectionId); }
function connected(agent) { return Boolean(connectionFor(agent)?.hasKey); }
function typeLabel(type) { return setup.types[type]?.label || type || '智能助手'; }
function messageName(message) { return message.name || typeLabel(message.provider); }
function messageRole(message) { return message.role || setup.types[message.provider]?.role || '讨论成员'; }
function textElement(tag, className, text) { const el = document.createElement(tag); el.className = className; el.textContent = text; return el; }
function avatarElement(type, className, connectionId = null) {
  const avatar = document.createElement('div'); avatar.className = className;
  const resolvedType = type === 'custom' && connectionId
    ? setup.connections.find(item => item.id === connectionId)?.type || type : type;
  const iconFile = ({ deepseek: 'deepseek-app.jpg', qwen: 'qwen-app.jpg', glm: 'zhipu-app.jpg', volcengine: 'doubao-avatar.jpg' })[resolvedType];
  if (iconFile) avatar.classList.add('app-icon-avatar');
  const icon = document.createElement('img');
  icon.src = `/icons/${iconFile || 'custom.svg'}`;
  icon.alt = ''; icon.setAttribute('aria-hidden', 'true');
  avatar.append(icon);
  return avatar;
}
function renderMarkdown(element, source) {
  const html = marked.parse(source, { gfm: true, breaks: true });
  element.innerHTML = DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ['img'], FORBID_ATTR: ['style'] });
  for (const link of element.querySelectorAll('a')) {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }
}

async function refreshSetup() { setup = await api('/api/setup'); connectBrowserPresence(); renderAgents(); }
function selectedAgents() {
  return groupIds.map(id => setup.agents.find(agent => agent.connectionId === id)).filter(Boolean);
}
function saveGroup() { localStorage.setItem('ai-roundtable-group', JSON.stringify(groupIds)); }
function addToGroup(id) {
  if (!setup.agents.some(agent => agent.connectionId === id)) return;
  if (groupIds.includes(id)) return toast('该成员已在讨论组中');
  groupIds.push(id); saveGroup(); renderAgents();
}
function removeFromGroup(id) {
  groupIds = groupIds.filter(item => item !== id); saveGroup(); renderAgents();
}
function renderAgents() {
  const row = $('agentRow'); row.replaceChildren();
  const group = $('groupMembers'); group.replaceChildren();
  const knownIds = new Set(setup.agents.map(agent => agent.connectionId));
  const validIds = [...new Set(groupIds.filter(id => knownIds.has(id)))];
  if (validIds.length !== groupIds.length) { groupIds = validIds; saveGroup(); }
  for (const agent of setup.agents) {
    const card = document.createElement('button'); card.type = 'button';
    card.className = `member-card ${agent.type}${groupIds.includes(agent.connectionId) ? ' in-group' : ''}`;
    card.draggable = true; card.dataset.hint = '点击编辑';
    card.setAttribute('aria-label', `编辑成员 ${agent.name}，可拖入讨论组`);
    const avatar = avatarElement(agent.type, 'agent-avatar');
    card.append(avatar, textElement('strong', '', agent.name));
    card.addEventListener('click', () => {
      const connection = connectionFor(agent);
      if (connection) openManage(connection);
    });
    card.addEventListener('dragstart', event => {
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData('text/plain', agent.connectionId);
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => { card.classList.remove('dragging'); $('groupDropZone').classList.remove('drop-active'); });
    row.append(card);
  }
  if (!setup.agents.length) row.append(textElement('p', 'panel-empty', '还没有成员，点击右上角添加。'));
  for (const agent of selectedAgents()) {
    const card = document.createElement('div'); card.className = `group-member-card ${agent.type}`;
    const avatar = avatarElement(agent.type, 'agent-avatar');
    const remove = textElement('button', 'group-member-remove', '×'); remove.type = 'button';
    remove.setAttribute('aria-label', `从讨论组移除 ${agent.name}`);
    remove.addEventListener('click', () => removeFromGroup(agent.connectionId));
    card.append(avatar, textElement('strong', '', agent.name), remove); group.append(card);
  }
  $('groupCount').textContent = `${groupIds.length} 位成员`;
  $('groupHint').classList.toggle('hidden', groupIds.length > 0);
  const missing = selectedAgents().filter(agent => !connected(agent)).length;
  $('setupHint').textContent = groupIds.length < 2
    ? `请向讨论组拖入至少 2 位成员${groupIds.length ? `，还差 ${2 - groupIds.length} 位` : ''}。`
    : missing ? `讨论组中有 ${missing} 位成员未配置密钥，请点击左侧成员编辑。` : `${groupIds.length} 位成员将按顺序参与讨论。`;
  updateRequestHint();
}
function updateRequestHint() {
  const ready = selectedAgents().length;
  const rounds = Number($('rounds').value) || setup.rounds;
  $('requestHint').textContent = `真实调用接口 · ${rounds} 轮约 ${ready * rounds} 次请求 · 会消耗额度 · 自动保存`;
}
async function refreshHistory() {
  closeHistoryMenu();
  const items = await api('/api/discussions');
  $('historyCount').textContent = items.length;
  const container = $('history'); container.replaceChildren();
  if (!items.length) container.append(textElement('div', 'history-empty', '还没有讨论，开始第一场吧。'));
  for (const item of items) {
    const entry = document.createElement('div'); entry.className = 'history-entry';
    const button = document.createElement('button'); button.type = 'button'; button.className = `history-item${item.id === currentId ? ' active' : ''}`;
    const title = textElement('strong', '', item.question);
    const meta = document.createElement('small'); meta.append(textElement('span', '', dateLabel(item.updatedAt)), textElement('span', '', statusLabel(item.status)));
    button.append(title, meta);
    button.addEventListener('click', () => openDiscussion(item.id));
    button.addEventListener('contextmenu', event => { event.preventDefault(); openHistoryMenu(item, event.clientX, event.clientY); });
    button.addEventListener('keydown', event => {
      if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
        event.preventDefault();
        const box = button.getBoundingClientRect();
        openHistoryMenu(item, box.left + 12, box.bottom - 4);
      }
    });
    entry.append(button); container.append(entry);
  }
}
function closeHistoryMenu() {
  historyMenuItem = null;
  $('historyMenu').classList.add('hidden');
}
function openHistoryMenu(item, x, y) {
  historyMenuItem = item;
  const menu = $('historyMenu');
  menu.classList.remove('hidden');
  const width = menu.offsetWidth, height = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - height - 8))}px`;
  $('deleteHistoryItem').focus();
}
async function deleteSelectedHistoryItem() {
  const item = historyMenuItem;
  closeHistoryMenu();
  if (!item) return;
  if (!window.confirm(`确定删除讨论记录“${item.question.slice(0, 60)}”吗？\n删除后无法恢复。`)) return;
  try {
    await api(`/api/discussions/${item.id}`, { method: 'DELETE' });
    if (currentId === item.id) showHero();
    else await refreshHistory();
    toast('讨论记录已删除');
  } catch (error) { toast(error.message); }
}
function showHero() {
  currentId = null; currentItem = null; localStorage.removeItem('ai-roundtable-current');
  $('hero').classList.remove('hidden'); $('discussion').classList.add('hidden'); $('discussionExport').classList.add('hidden');
  document.querySelector('.sidebar').classList.remove('open');
  refreshHistory().catch(error => toast(error.message));
}
function createNewDiscussion() {
  groupIds = []; saveGroup(); renderAgents();
  $('question').value = '';
  $('followupMessage').value = '';
  showHero();
}
function addRoundDivider(parent, round) {
  const divider = textElement('div', 'round-divider', `第 ${round} 轮`); parent.append(divider);
}
function addMessage(parent, message, streaming = false) {
  const card = document.createElement('article'); card.className = `message ${message.provider || 'custom'}${streaming ? ' streaming' : ''}`;
  const avatar = avatarElement(message.provider, 'message-avatar', message.agentId);
  const body = document.createElement('div'); body.className = 'message-body';
  const meta = document.createElement('div'); meta.className = 'message-meta';
  meta.append(textElement('strong', '', messageName(message)));
  const content = document.createElement('div'); content.className = 'message-content markdown-content';
  if (message.content) renderMarkdown(content, message.content);
  else content.textContent = '正在思考…';
  if (streaming) content.append(textElement('span', 'cursor', ''));
  body.append(meta, content); card.append(avatar, body); parent.append(card);
}
function addFollowUp(parent, followUp) {
  const card = document.createElement('article'); card.className = 'followup-message';
  card.append(textElement('strong', '', '你 · 继续讨论'));
  const content = document.createElement('div'); content.className = 'markdown-content';
  renderMarkdown(content, followUp.text); card.append(content); parent.append(card);
}
function renderParticipants(item) {
  const row = $('participantAvatars'); row.replaceChildren();
  const agents = item.agents || [];
  for (const [index, agent] of agents.entries()) {
    const unit = document.createElement('div'); unit.className = 'participant-unit';
    unit.dataset.name = agent.name;
    unit.tabIndex = 0;
    unit.setAttribute('aria-label', agent.name);
    const avatar = avatarElement(agent.type, `participant-avatar ${agent.type || 'custom'}`, agent.connectionId);
    avatar.setAttribute('aria-hidden', 'true');
    const remove = textElement('button', 'participant-remove', '×'); remove.type = 'button';
    remove.title = agents.length <= 2 ? '至少保留 2 位成员' : `从本讨论移除 ${agent.name}`;
    remove.setAttribute('aria-label', `移除 ${agent.name}`);
    remove.disabled = agents.length <= 2;
    remove.addEventListener('click', () => updateDiscussionAgents({ action: 'remove', index }));
    unit.append(avatar, remove); row.append(unit);
  }
  const addUnit = document.createElement('div'); addUnit.className = 'participant-unit participant-add-unit';
  addUnit.dataset.name = '添加讨论成员';
  const add = textElement('button', 'participant-add', ''); add.type = 'button';
  add.setAttribute('aria-label', '添加讨论成员');
  add.addEventListener('click', () => openParticipantDialog()); addUnit.append(add); row.append(addUnit);
}
function openParticipantDialog(index = null) {
  participantEditIndex = index;
  $('participantDialogTitle').textContent = index === null ? '添加讨论成员' : '更换讨论成员';
  $('participantEditConnection').classList.toggle('hidden', index === null);
  const select = $('participantSelect'); select.replaceChildren();
  const used = new Set((currentItem?.agents || []).filter((_, position) => position !== index).map(agent => agent.connectionId));
  for (const connection of setup.connections.filter(connection => connection.hasKey && !used.has(connection.id))) {
    addOption(select, connection.id, `${connection.name} · ${connection.model}`);
  }
  if (!select.options.length) addOption(select, '', '暂无可选成员，请先新增成员');
  if (index !== null) select.value = currentItem.agents[index].connectionId;
  $('participantSave').disabled = !select.value;
  select.onchange = () => { $('participantSave').disabled = !select.value; };
  $('participantDialog').showModal();
}
async function updateDiscussionAgents(change) {
  if (!currentId) return;
  try {
    const item = await api(`/api/discussions/${currentId}/agents`, { method: 'PUT', body: JSON.stringify(change) });
    renderDiscussion(item);
    toast(['running', 'paused', 'stopped', 'error'].includes(item.status) ? '成员已调整，将从下一阶段生效' : '讨论成员已更新');
  } catch (error) { toast(error.message); }
}
function renderDiscussion(item) {
  currentItem = item;
  $('hero').classList.add('hidden'); $('discussion').classList.remove('hidden');
  $('discussionExport').classList.remove('hidden');
  $('discussionQuestion').textContent = item.question;
  $('discussionSub').textContent = `创建于 ${dateLabel(item.createdAt)} · ${statusLabel(item.status)} · 自动保存`;
  const phase = item.phase || { startMessageCount: 0, rounds: item.rounds || 5 };
  renderParticipants(item);
  const messages = $('messages');
  const stream = $('discussionStream');
  const previousScrollTop = stream.scrollTop;
  const atBottom = stream.scrollTop + stream.clientHeight >= stream.scrollHeight - 180;
  messages.replaceChildren(); let lastRound = 0;
  const followUps = item.followUps || [];
  for (let index = 0; index <= item.messages.length; index++) {
    for (const followUp of followUps.filter(entry => entry.afterMessageCount === index)) addFollowUp(messages, followUp);
    if (index === item.messages.length) break;
    const message = item.messages[index];
    if (message.round !== lastRound) addRoundDivider(messages, message.round);
    addMessage(messages, message); lastRound = message.round;
  }
  if (item.current && !item.current.summary) { if (item.current.round !== lastRound) addRoundDivider(messages, item.current.round); addMessage(messages, item.current, true); }
  $('pauseButton').classList.toggle('hidden', ['completed', 'stopped'].includes(item.status));
  $('pauseButton').disabled = !['running', 'paused', 'error'].includes(item.status);
  $('pauseButton').textContent = item.status === 'running' ? '暂停' : '继续';
  $('stopButton').disabled = !['running', 'paused'].includes(item.status);
  const panel = $('statusPanel'); panel.className = 'status-panel';
  if (item.status === 'error') { panel.textContent = `讨论已暂停：${item.error || '未知错误'}。检查后点击“继续”，将从上次完整发言恢复。`; panel.classList.add('error'); }
  else if (item.status === 'stopped') panel.textContent = '讨论已停止。可发送新要求，开始新的讨论阶段。';
  else if (item.status === 'paused') panel.textContent = '当前发言完成后会暂停下一位，点击“继续”恢复。';
  else if (item.status === 'completed') panel.textContent = `本阶段 ${phase.rounds} 轮讨论已完成，记录已自动保存在本机。`;
  else panel.classList.add('hidden');
  $('followupButton').disabled = !['completed', 'stopped'].includes(item.status) || followupPending;
  $('followupHint').textContent = ['completed', 'stopped'].includes(item.status)
    ? `${item.agents?.length || setup.agents.length} 位成员将按原顺序继续`
    : '本轮讨论完成后可发送追加要求';
  if (atBottom && ['running', 'completed'].includes(item.status)) stream.scrollTo({ top: stream.scrollHeight, behavior: 'smooth' });
  else stream.scrollTop = previousScrollTop;
}
async function openDiscussion(id) {
  const item = await api(`/api/discussions/${id}`);
  currentId = id; localStorage.setItem('ai-roundtable-current', id);
  document.querySelector('.sidebar').classList.remove('open');
  renderDiscussion(item); $('discussionStream').scrollTop = 0; refreshHistory().catch(() => {}); window.scrollTo({ top: 0, behavior: 'smooth' });
}
async function startDiscussion() {
  const question = $('question').value.trim();
  if (question.length < 3) return toast('请先输入一个具体问题');
  if (groupIds.length < 2) return toast('请先向讨论组拖入至少 2 位成员');
  if (selectedAgents().some(agent => !connected(agent))) return toast('请先为讨论组中的所有成员配置 API Key');
  $('startButton').disabled = true;
  try {
    const item = await api('/api/discussions', { method: 'POST', body: JSON.stringify({ question, rounds: Number($('rounds').value), connectionIds: groupIds }) });
    currentId = item.id; localStorage.setItem('ai-roundtable-current', item.id);
    renderDiscussion(item); await refreshHistory();
  } catch (error) { toast(error.message); }
  finally { $('startButton').disabled = false; }
}
async function sendFollowUp() {
  if (!currentId || !['completed', 'stopped'].includes(currentItem?.status) || followupPending) return;
  const message = $('followupMessage').value.trim();
  if (!message) return toast('请先输入想让成员继续讨论的内容');
  const button = $('followupButton'); followupPending = true; button.disabled = true;
  try {
    const item = await api(`/api/discussions/${currentId}/followup`, { method: 'POST', body: JSON.stringify({ message, rounds: Number($('followupRounds').value) }) });
    $('followupMessage').value = '';
    renderDiscussion(item); await refreshHistory();
  } catch (error) { toast(error.message); }
  finally { followupPending = false; button.disabled = !['completed', 'stopped'].includes(currentItem?.status); }
}
function makeField(label, id, value = '', type = 'text', placeholder = '') {
  const wrapper = document.createElement('label'); wrapper.className = `setting-field${label === 'API 地址' ? ' wide' : ''}`;
  const caption = textElement('span', '', label); const input = document.createElement('input');
  input.id = id; input.type = type; input.value = value; input.placeholder = placeholder; input.autocomplete = 'off';
  wrapper.append(caption, input); return wrapper;
}
function makeSelectField(label, id, wide = false) {
  const wrapper = document.createElement('label'); wrapper.className = `setting-field${wide ? ' wide' : ''}`;
  const select = document.createElement('select'); select.id = id;
  wrapper.append(textElement('span', '', label), select); return wrapper;
}
function makeApiKeyField(hasKey = false) {
  const field = document.createElement('div'); field.className = 'setting-field wide';
  const caption = textElement('label', 'setting-label', 'API Key'); caption.htmlFor = 'editKey';
  const row = document.createElement('div'); row.className = 'api-key-input-row';
  const input = document.createElement('input');
  input.id = 'editKey'; input.type = 'password'; input.autocomplete = 'off';
  input.placeholder = hasKey ? '已保存，留空保持不变' : '填写你的 API Key';
  const link = textElement('a', 'api-key-link', '获取API');
  link.id = 'getApiKey'; link.target = '_blank'; link.rel = 'noopener noreferrer';
  row.append(input, link); field.append(caption, row); return field;
}
function addOption(select, value, label) {
  const option = document.createElement('option'); option.value = value; option.textContent = label; select.append(option);
}
function closeEditor() { editingId = null; if ($('manageDialog').open) $('manageDialog').close(); }
function openManage(item = null) {
  openEditor(item);
  if (!$('manageDialog').open) $('manageDialog').showModal();
}
function openEditor(item = null) {
  editingId = item?.id || null;
  $('manageTitle').textContent = `${item ? '编辑' : '新增'}成员`;
  $('deleteEditor').classList.toggle('hidden', !item);
  $('deleteEditor').onclick = item ? () => deleteManagedItem(item) : null;
  const fields = $('editorFields'); fields.replaceChildren();
  const urlField = makeSelectField('API 地址', 'editUrl', true);
  const customUrlField = makeField('自定义 API 地址', 'editUrlCustom', item?.url || '', 'url', '输入完整的 API 地址');
  const modelField = makeSelectField('模型名称', 'editModel');
  const customModelField = makeField('自定义模型名称', 'editModelCustom', item?.model || '', 'text', '输入平台提供的模型标识');
  fields.append(makeField('成员名称', 'editName', item?.name || '', 'text', '例如：我的助手'), urlField, customUrlField,
    makeApiKeyField(item?.hasKey), modelField, customModelField);
  const urlSelect = $('editUrl');
  addOption(urlSelect, '', '请选择 API 地址');
  for (const preset of API_PRESETS) addOption(urlSelect, preset.id, `${preset.name} · ${preset.url}`);
  addOption(urlSelect, 'custom', '自定义 API 地址…');
  const selectedPreset = API_PRESETS.find(preset => preset.url === item?.url);
  urlSelect.value = item ? (selectedPreset?.id || 'custom') : '';
  function updateModelOptions(preserveModel = '') {
    const preset = API_PRESETS.find(option => option.id === urlSelect.value);
    const keyLink = $('getApiKey');
    if (preset?.apiKeyUrl) {
      keyLink.href = preset.apiKeyUrl; keyLink.tabIndex = 0;
      keyLink.setAttribute('aria-disabled', 'false');
      keyLink.setAttribute('aria-label', `获取API：${preset.name}（在新标签页打开）`);
      keyLink.title = `前往${preset.name}官方 API Key 页面`;
    } else {
      keyLink.removeAttribute('href'); keyLink.tabIndex = -1;
      keyLink.setAttribute('aria-disabled', 'true');
      keyLink.setAttribute('aria-label', '获取API：请先选择平台');
      keyLink.title = preset ? '该平台暂未配置获取地址' : '请先选择平台；自定义接口需到对应平台获取 API Key';
    }
    customUrlField.classList.toggle('hidden', urlSelect.value !== 'custom');
    modelField.classList.toggle('hidden', !preset);
    const modelSelect = $('editModel'); modelSelect.replaceChildren();
    if (preset) {
      for (const model of preset.models) addOption(modelSelect, model.id, model.label || model.id);
      addOption(modelSelect, 'custom', '其他模型标识…');
      modelSelect.value = preset.models.some(model => model.id === preserveModel) ? preserveModel
        : preserveModel ? 'custom' : preset.models[0].id;
    }
    customModelField.classList.toggle('hidden', !urlSelect.value || (Boolean(preset) && modelSelect.value !== 'custom'));
  }
  urlSelect.addEventListener('change', () => updateModelOptions());
  $('editModel').addEventListener('change', () => updateModelOptionsForCustom());
  function updateModelOptionsForCustom() {
    customModelField.classList.toggle('hidden', $('editModel').value !== 'custom');
  }
  updateModelOptions(item?.model || '');
}
async function saveEditor() {
  const savedConnectionId = editingId;
  const preset = API_PRESETS.find(item => item.id === $('editUrl').value);
  const body = {
    name: $('editName').value.trim(),
    model: preset && $('editModel').value !== 'custom' ? $('editModel').value : $('editModelCustom').value.trim(),
    url: preset?.url || $('editUrlCustom').value.trim(),
    key: $('editKey').value,
  };
  try {
    await api(`/api/connections${editingId ? `/${editingId}` : ''}`, { method: editingId ? 'PUT' : 'POST', body: JSON.stringify(body) });
    await refreshSetup();
    if (savedConnectionId && currentId) {
      const index = currentItem?.agents?.findIndex(agent => agent.connectionId === savedConnectionId) ?? -1;
      if (index >= 0) await updateDiscussionAgents({ action: 'replace', index, connectionId: savedConnectionId });
    }
    closeEditor(); toast('已保存');
  } catch (error) { toast(error.message); }
}
async function deleteManagedItem(item) {
  if (!window.confirm(`确定删除成员“${item.name}”吗？\n该成员将从主页移除，已有讨论记录保留。`)) return;
  try {
    await api(`/api/connections/${item.id}`, { method: 'DELETE' });
    await refreshSetup(); closeEditor(); toast('成员已删除');
  } catch (error) { toast(error.message); }
}
async function action(name) {
  if (!currentId) return;
  try { const item = await api(`/api/discussions/${currentId}/${name}`, { method: 'POST' }); renderDiscussion(item); await refreshHistory(); }
  catch (error) { toast(error.message); }
}
function transcript() {
  if (!currentItem) return '';
  let text = `# ${currentItem.question}\n\n创建时间：${new Date(currentItem.createdAt).toLocaleString('zh-CN')}\n\n`;
  let lastRound = 0;
  const followUps = currentItem.followUps || [];
  for (let index = 0; index <= currentItem.messages.length; index++) {
    for (const followUp of followUps.filter(entry => entry.afterMessageCount === index)) {
      text += `## 用户追加要求\n\n${followUp.text}\n\n`;
    }
    if (index === currentItem.messages.length) break;
    const message = currentItem.messages[index];
    if (message.round !== lastRound) text += `## 第 ${message.round} 轮\n\n`;
    text += `### ${messageName(message)} · ${messageRole(message)}\n\n${message.content}\n\n`;
    lastRound = message.round;
  }
  return text;
}
function downloadMarkdown() {
  if (!currentItem) return;
  const url = URL.createObjectURL(new Blob([transcript()], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `多AI聊天平台-${currentItem.id.slice(0, 8)}.md`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportPdf() {
  if (!currentItem) return;
  renderMarkdown($('printReport'), transcript());
  const previousTitle = document.title;
  document.title = `多AI聊天平台-${currentItem.id.slice(0, 8)}`;
  window.addEventListener('afterprint', () => { document.title = previousTitle; }, { once: true });
  toast('请在打印窗口选择保存为文件');
  window.print();
}

$('newButton').addEventListener('click', createNewDiscussion);
$('addHomeMember').addEventListener('click', () => openManage());
const groupDropZone = $('groupDropZone');
groupDropZone.addEventListener('dragover', event => {
  if (!Array.from(event.dataTransfer.types).includes('text/plain')) return;
  event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
  groupDropZone.classList.add('drop-active');
});
groupDropZone.addEventListener('dragleave', event => {
  if (!groupDropZone.contains(event.relatedTarget)) groupDropZone.classList.remove('drop-active');
});
groupDropZone.addEventListener('drop', event => {
  event.preventDefault(); groupDropZone.classList.remove('drop-active');
  addToGroup(event.dataTransfer.getData('text/plain'));
});
$('historyButton').addEventListener('click', () => document.querySelector('.sidebar').classList.toggle('open'));
$('closeManage').addEventListener('click', closeEditor);
$('cancelEditor').addEventListener('click', closeEditor);
$('saveEditor').addEventListener('click', saveEditor);
$('participantCancel').addEventListener('click', () => $('participantDialog').close());
$('participantNewConnection').addEventListener('click', () => { $('participantDialog').close(); openManage(); });
$('participantEditConnection').addEventListener('click', () => {
  const connection = setup.connections.find(item => item.id === currentItem?.agents?.[participantEditIndex]?.connectionId);
  $('participantDialog').close();
  if (!connection) return toast('该成员已不存在');
  openManage(connection);
});
$('participantSave').addEventListener('click', async () => {
  const connectionId = $('participantSelect').value;
  if (!connectionId) return;
  $('participantDialog').close();
  await updateDiscussionAgents({ action: participantEditIndex === null ? 'add' : 'replace', index: participantEditIndex, connectionId });
});
$('deleteHistoryItem').addEventListener('click', deleteSelectedHistoryItem);
document.addEventListener('pointerdown', event => { if (!$('historyMenu').contains(event.target)) closeHistoryMenu(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeHistoryMenu(); });
window.addEventListener('scroll', closeHistoryMenu, true);
$('startButton').addEventListener('click', startDiscussion);
$('rounds').addEventListener('change', updateRequestHint);
$('followupButton').addEventListener('click', sendFollowUp);
$('followupMessage').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) sendFollowUp(); });
$('pauseButton').addEventListener('click', () => action(currentItem?.status === 'running' ? 'pause' : 'resume'));
$('stopButton').addEventListener('click', () => action('stop'));
$('exportButton').addEventListener('click', downloadMarkdown);
$('exportPdfButton').addEventListener('click', exportPdf);
$('question').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) startDiscussion(); });

try {
  await refreshSetup(); await refreshHistory();
  const savedId = localStorage.getItem('ai-roundtable-current');
  if (savedId) { try { await openDiscussion(savedId); } catch { localStorage.removeItem('ai-roundtable-current'); } }
  setInterval(async () => {
    if (!currentId) return;
    try {
      const item = await api(`/api/discussions/${currentId}`);
      if (JSON.stringify(item) !== JSON.stringify(currentItem)) { const oldStatus = currentItem?.status; renderDiscussion(item); if (oldStatus !== item.status) refreshHistory().catch(() => {}); }
    } catch (error) { if (currentId) toast(error.message); }
  }, 700);
} catch (error) { toast(`启动失败：${error.message}`); }

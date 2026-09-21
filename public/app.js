'use strict';

const U_H = 26; // altura de 1U em px (igual a --u no CSS)
const $ = (sel, root = document) => root.querySelector(sel);
const fmt = (n) => Number(n).toLocaleString('pt-BR');
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.erro || `Erro ${res.status}`);
  return data;
}

let toastTimer;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 4500);
}

/* ------------------------------------------------------------------ estado */
const state = {
  view: 'dash', loaded: false,
  datacenters: [], racks: [], equip: [], tipos: [],
  dcId: null, rackId: null,
  hosts: [], hostsTruncated: false, hostsError: null,
  hostMap: new Map(),
  zbx: null, // { ok, total, found:Set } | { ok:false, error }
  search: '', groupId: '',
};
const HOSTS_LIMIT = 300;

function saveSelection() {
  try { localStorage.setItem('bayface.sel', JSON.stringify({ dcId: state.dcId, rackId: state.rackId })); } catch { /* ignora */ }
}
function loadSelection() {
  try {
    const s = JSON.parse(localStorage.getItem('bayface.sel') || '{}');
    state.dcId = s.dcId ?? null; state.rackId = s.rackId ?? null;
  } catch { /* ignora */ }
}

const racksDoDc = (dcId = state.dcId) => state.racks.filter((r) => r.datacenter_id === dcId);
const rackAtual = () => state.racks.find((r) => r.id === state.rackId) || null;
const equipDoRack = (rackId) => state.equip.filter((e) => e.rack_id === rackId);
const topoU = (e) => e.u_inicio + e.altura_u - 1;

function usedU(rack) {
  const set = new Set();
  for (const e of equipDoRack(rack.id)) for (let u = e.u_inicio; u <= topoU(e); u++) set.add(u);
  return set.size;
}

async function loadAll() {
  [state.datacenters, state.racks, state.equip, state.tipos] = await Promise.all([
    api('GET', '/api/datacenters'), api('GET', '/api/racks'), api('GET', '/api/equipamentos'), api('GET', '/api/tipos'),
  ]);
  state.loaded = true;
  if (!state.datacenters.some((d) => d.id === state.dcId)) state.dcId = state.datacenters[0]?.id ?? null;
  if (!racksDoDc().some((r) => r.id === state.rackId)) state.rackId = racksDoDc()[0]?.id ?? null;
  saveSelection();
  renderAll();
  refreshStatus();
}

function setView(v) {
  state.view = v;
  $('#view-dash').hidden = v !== 'dash';
  $('#view-racks').hidden = v !== 'racks';
  $('#view-whats').hidden = v !== 'whats';
  $('#tab-dash').setAttribute('aria-current', String(v === 'dash'));
  $('#tab-racks').setAttribute('aria-current', String(v === 'racks'));
  $('#tab-whats').setAttribute('aria-current', String(v === 'whats'));
  if (v === 'dash') { renderDashboard(); loadZbxDash(); }
  else if (v === 'whats') loadWhats();
  else { renderAll(); refreshStatus(); }
}

/* ---------------------------------------------------------- regra de posição */
// Mesma regra do servidor: conflita se compartilha alguma U e (algum é full_depth ou mesma face).
function checarPosicao(rack, p, ignoreId) {
  if (!Number.isInteger(p.u_inicio) || p.u_inicio < 1) return 'a U inicial deve ser 1 ou mais';
  if (!Number.isInteger(p.altura_u) || p.altura_u < 1) return 'a altura deve ser de pelo menos 1U';
  const topo = p.u_inicio + p.altura_u - 1;
  if (topo > rack.altura_u) return `não cabe: o rack ${rack.nome} tem ${rack.altura_u}U`;
  const choque = equipDoRack(rack.id).find((o) => {
    if (o.id === ignoreId) return false;
    const sobrepoe = p.u_inicio <= topoU(o) && o.u_inicio <= topo;
    return sobrepoe && (p.full_depth || o.full_depth || o.face === p.face);
  });
  if (choque) return `conflita com ${choque.nome} (U${choque.u_inicio} a U${topoU(choque)})`;
  return null;
}

/* ------------------------------------------------------------ dados do Zabbix */
// 'up' | 'down' | 'off' | 'unknown' | null (host ainda não carregado)
function hostState(hostid) {
  const h = state.hostMap.get(hostid);
  if (!h) return null;
  if (h.status === '1') return 'off';
  const i = (h.interfaces || []).find((x) => x.main === '1') || (h.interfaces || [])[0];
  if (i?.available === '1') return 'up';
  if (i?.available === '2') return 'down';
  return 'unknown';
}
function ledClass(hostid) {
  if (!hostid) return 'manual';
  const s = hostState(hostid);
  return s === 'up' || s === 'down' || s === 'off' ? s : '';
}
const hostIp = (hostid) => {
  const h = state.hostMap.get(hostid);
  return (h?.interfaces || []).find((x) => x.main === '1')?.ip || h?.interfaces?.[0]?.ip || '';
};
const hostHw = (hostid) => state.hostMap.get(hostid)?.inventory?.hardware || '';

// IP e hardware exibidos: do Zabbix quando há host; dos campos do item quando não há.
function infoDe(e) {
  return e.hostid ? { ip: hostIp(e.hostid), hw: hostHw(e.hostid) } : { ip: e.ip || '', hw: e.modelo || '' };
}

/* ------------------------------------------------------------------ render */
function renderAll() {
  renderDatacenters();
  renderRackList();
  renderRack();
  renderHosts();
  if (state.view === 'dash') renderDashboard();
}

const rotuloDc = (d) => (d.sigla ? `${d.nome} (${d.sigla})` : d.nome);

function renderDatacenters() {
  const sel = $('#dc-select');
  sel.innerHTML = '';
  if (!state.datacenters.length) sel.append(new Option('Nenhum datacenter cadastrado', ''));
  for (const d of state.datacenters) sel.append(new Option(rotuloDc(d), d.id, false, d.id === state.dcId));
  sel.disabled = !state.datacenters.length;
  $('#dc-edit').disabled = !state.datacenters.length;
  $('#rack-new').disabled = !state.datacenters.length;
}

function renderRackList() {
  const box = $('#rack-list');
  box.innerHTML = '';
  const racks = racksDoDc();
  if (!racks.length) {
    box.append(el('p', 'note', state.datacenters.length ? 'Este datacenter ainda não tem racks.' : ''));
    return;
  }
  const porCage = new Map();
  for (const r of racks) {
    const k = r.cage || 'Sem cage';
    if (!porCage.has(k)) porCage.set(k, []);
    porCage.get(k).push(r);
  }
  for (const [cage, lista] of porCage) {
    box.append(el('div', 'cage-name', cage === 'Sem cage' ? cage : `Cage ${cage}`));
    for (const r of lista) {
      const used = usedU(r);
      const b = el('button', 'rack-item');
      b.type = 'button';
      b.setAttribute('aria-current', String(r.id === state.rackId));
      const line = el('div', 'line');
      line.append(el('span', 'name', r.nome), el('span', 'use', `${used} de ${r.altura_u}U`));
      const bar = el('div', 'bar');
      const fill = el('span');
      fill.style.width = `${Math.min(100, (used / r.altura_u) * 100)}%`;
      bar.append(fill);
      b.append(line, bar);
      b.addEventListener('click', () => { state.rackId = r.id; saveSelection(); renderAll(); refreshStatus(); });
      box.append(b);
    }
  }
}

function renderRack() {
  const stage = $('#stage');
  stage.innerHTML = '';
  const rack = rackAtual();

  if (!state.datacenters.length) {
    const box = el('div', 'empty');
    box.append(el('p', '', 'Cadastre o primeiro datacenter para começar.'));
    const b = el('button', 'btn primary', 'Novo datacenter');
    b.type = 'button'; b.addEventListener('click', () => openDatacenter());
    box.append(b); stage.append(box);
    return;
  }
  if (!rack) {
    const box = el('div', 'empty');
    box.append(el('p', '', 'Cadastre um rack neste datacenter para montar o bayface.'));
    const b = el('button', 'btn primary', 'Novo rack');
    b.type = 'button'; b.addEventListener('click', () => openRack());
    box.append(b); stage.append(box);
    return;
  }

  const used = usedU(rack);
  const head = el('div', 'stage-head');
  const info = el('div');
  info.append(el('h2', '', rack.nome));
  info.append(el('div', 'meta',
    `${rack.cage ? `Cage ${rack.cage}, ` : ''}${rack.altura_u}U, ${used}U ocupadas, ${rack.altura_u - used}U livres`));
  const actions = el('div', 'row');
  actions.style.margin = '0';
  const bManual = el('button', 'btn', 'Adicionar item sem host');
  bManual.type = 'button'; bManual.addEventListener('click', () => openEquip({ rack }));
  const bEdit = el('button', 'btn', 'Editar rack');
  bEdit.type = 'button'; bEdit.addEventListener('click', () => openRack(rack));
  const bImg = el('a', 'btn', 'Baixar imagem');
  bImg.href = `/api/racks/${rack.id}/imagem.png`;
  bImg.download = `bayface-${rack.nome}.png`;
  actions.append(bManual, bEdit, bImg);
  head.append(info, actions);

  const faces = el('div', 'faces');
  faces.append(buildFace(rack, 'frente'), buildFace(rack, 'traseira'));
  stage.append(head, faces);
}

function buildFace(rack, face) {
  const wrap = el('div', 'face');
  wrap.append(el('h3', '', face === 'frente' ? 'Frente' : 'Traseira'));
  const frame = el('div', 'frame');
  const inner = el('div', 'frame-in');

  const mkNums = () => {
    const n = el('div', 'nums');
    for (let u = rack.altura_u; u >= 1; u--) n.append(el('div', '', String(u)));
    return n;
  };
  const bay = el('div', 'bay');
  bay.style.setProperty('--rows', rack.altura_u);
  bay.dataset.face = face;

  // Um equipamento full_depth aparece nas duas faces; os demais só na sua.
  for (const e of equipDoRack(rack.id)) {
    if (e.face === face || e.full_depth) bay.append(buildDevice(rack, e, face));
  }

  bay.addEventListener('dragover', (ev) => onDragOver(ev, bay, rack, face));
  bay.addEventListener('dragleave', (ev) => { if (!bay.contains(ev.relatedTarget)) clearGhosts(); });
  bay.addEventListener('drop', (ev) => onDrop(ev, rack));

  inner.append(mkNums(), bay, mkNums());
  frame.append(inner);
  wrap.append(frame);
  return wrap;
}

const rotuloU = (e) => `U${e.u_inicio}${e.altura_u > 1 ? `-${topoU(e)}` : ''}`;
const metaDe = (e, ip) => ip || (e.tem_portas ? `${e.portas_total} portas` : rotuloU(e));

function buildDevice(rack, e, face) {
  const d = el('div', 'device');
  if (e.face !== face) d.classList.add('back');
  const tall = e.altura_u >= 2;
  if (tall) d.classList.add('tall');
  d.style.top = `${(rack.altura_u - topoU(e)) * U_H}px`;
  d.style.height = `${e.altura_u * U_H}px`;
  d.tabIndex = 0;
  d.draggable = true;
  d.dataset.id = e.id;
  if (e.hostid) d.dataset.hostid = e.hostid;

  const { ip, hw } = infoDe(e);
  const row = el('div', 'dev-row');
  row.append(el('span', `led ${ledClass(e.hostid)}`), el('span', 'dev-name', e.nome));
  if (!tall) row.append(el('span', 'dev-hw', hw));
  row.append(el('span', 'dev-meta', metaDe(e, ip)));
  d.append(row);
  if (tall) { d.append(el('span', 'dev-hw', hw)); d.append(el('span', 'vents')); }

  d.title = [
    e.nome,
    e.tipo_nome ? `Tipo: ${e.tipo_nome}` : '',
    hw ? `Hardware: ${hw}` : '',
    ip ? `IP: ${ip}` : '',
    `${rotuloU(e)}, ${e.face}${e.full_depth ? '' : ', meia profundidade'}`,
    e.tem_portas ? `${e.portas_total} portas, ${e.portas_com_destino} com destino` : '',
    e.observacao || '',
    e.foto ? 'Foto anexada (clique para ver)' : '',
  ].filter(Boolean).join('\n');

  d.addEventListener('click', () => openEquip({ rack, eq: e }));
  d.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') openEquip({ rack, eq: e }); });
  d.addEventListener('dragstart', (ev) => {
    const offsetRows = Math.floor((ev.clientY - d.getBoundingClientRect().top) / U_H);
    drag = { type: 'equip', eq: e, offsetRows: Math.max(0, Math.min(e.altura_u - 1, offsetRows)) };
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', e.nome);
  });
  d.addEventListener('dragend', () => { drag = null; clearGhosts(); });
  return d;
}

/* --------------------------------------------------------------- drag & drop */
let drag = null;

function clearGhosts() { document.querySelectorAll('.ghost').forEach((g) => g.remove()); }

function onDragOver(ev, bay, rack, face) {
  if (!drag) return;
  ev.preventDefault();

  const rect = bay.getBoundingClientRect();
  const row = Math.min(Math.max(Math.floor((ev.clientY - rect.top) / U_H), 0), rack.altura_u - 1);
  const hoverU = rack.altura_u - row;

  let altura = 1, top = hoverU, fullDepth = false, ignoreId, useFace = face;
  if (drag.type === 'equip') {
    const e = drag.eq;
    altura = e.altura_u; top = hoverU + drag.offsetRows; fullDepth = !!e.full_depth; ignoreId = e.id;
    if (fullDepth) useFace = e.face; // full_depth só muda de face pelo formulário
  }
  const u0 = top - altura + 1;
  const err = checarPosicao(rack, { u_inicio: u0, altura_u: altura, face: useFace, full_depth: fullDepth }, ignoreId);

  let ghost = bay.querySelector('.ghost');
  if (!ghost) { clearGhosts(); ghost = el('div', 'ghost'); bay.append(ghost); }
  ghost.classList.toggle('bad', !!err);
  ghost.style.top = `${(rack.altura_u - Math.min(top, rack.altura_u)) * U_H}px`;
  ghost.style.height = `${altura * U_H}px`;

  drag.pending = { u0, top, face: useFace, err };
  // Mantém 'move' mesmo quando inválido: com 'none' o navegador nem dispara o drop e o motivo não seria exibido.
  ev.dataTransfer.dropEffect = 'move';
}

async function onDrop(ev, rack) {
  ev.preventDefault();
  clearGhosts();
  const d = drag;
  drag = null;
  if (!d || !d.pending) return;
  const p = d.pending;
  if (p.err) { toast(`Não foi possível soltar aqui: ${p.err}.`, 'error'); return; }

  if (d.type === 'host') {
    openEquip({ rack, host: d.host, topU: p.top, face: p.face });
    return;
  }
  try {
    await salvarEquip(d.eq.id, { ...payloadDe(d.eq), u_inicio: p.u0, face: p.face });
    await recarregarEquip();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ---------------------------------------------------------------- equipamentos */
const payloadDe = (e) => ({
  rack_id: e.rack_id, hostid: e.hostid, nome: e.nome, u_inicio: e.u_inicio,
  altura_u: e.altura_u, face: e.face, full_depth: !!e.full_depth,
  tipo_id: e.tipo_id, ip: e.ip, modelo: e.modelo, observacao: e.observacao,
});
const salvarEquip = (id, body) => (id ? api('PUT', `/api/equipamentos/${id}`, body) : api('POST', '/api/equipamentos', body));

async function recarregarEquip() {
  state.equip = await api('GET', '/api/equipamentos');
  renderRackList(); renderRack(); renderHosts();
  if (state.view === 'dash') renderDashboard();
  refreshStatus();
}

const tiposOpts = () => [{ value: '', label: 'Sem tipo' }, ...state.tipos.map((t) => ({ value: String(t.id), label: t.nome }))];

function openEquip({ rack, eq, host, topU, face }) {
  const novo = !eq;
  const hostid = eq ? eq.hostid : host ? host.hostid : null;
  const semHost = !hostid;
  const altura0 = eq ? eq.altura_u : 1;
  const u0 = eq ? eq.u_inicio : (topU ? topU - altura0 + 1 : 1);

  const fields = [];
  if (!novo) fields.push({ type: 'custom', node: () => fotoBloco(eq) });
  if (!semHost) {
    const h = host || state.hostMap.get(hostid);
    fields.push({ type: 'note', text: `Host do Zabbix: ${h ? h.name : `ID ${hostid}`}` });
  }
  fields.push({ name: 'nome', label: 'Nome no rack', type: 'text', value: eq ? eq.nome : host ? host.name : '', required: true, maxlength: 100 });
  if (semHost) {
    fields.push(
      { name: 'tipo_id', label: 'Tipo', type: 'select', value: eq?.tipo_id ? String(eq.tipo_id) : '', options: tiposOpts() },
      { type: 'button', label: 'Gerenciar tipos', onClick: (form) => openTipos(() => fillSelect(form.elements.tipo_id, tiposOpts(), form.elements.tipo_id.value)) },
      { name: 'modelo', label: 'Modelo', type: 'text', value: eq?.modelo || '', maxlength: 120, row: 'mi' },
      { name: 'ip', label: 'IP (opcional)', type: 'text', value: eq?.ip || '', maxlength: 45, row: 'mi' },
    );
  }
  fields.push(
    { name: 'altura_u', label: 'Altura (U)', type: 'number', value: altura0, min: 1, max: rack.altura_u, row: 'pos' },
    { name: 'u_inicio', label: 'U inicial (a mais baixa)', type: 'number', value: u0, min: 1, max: rack.altura_u, row: 'pos' },
    { name: 'face', label: 'Face', type: 'select', value: eq ? eq.face : face || 'frente',
      options: [{ value: 'frente', label: 'Frente' }, { value: 'traseira', label: 'Traseira' }] },
    { name: 'full_depth', label: 'Ocupa a profundidade inteira do rack (aparece na frente e na traseira)', type: 'checkbox', value: eq ? !!eq.full_depth : true },
  );
  if (semHost) fields.push({ name: 'observacao', label: 'Observação', type: 'textarea', value: eq?.observacao || '', maxlength: 500 });

  let uTocado = !topU || !novo;
  const extra = [];
  if (!novo && eq.tem_portas) {
    extra.push({ label: `Portas (${eq.portas_total})`, onClick: async () => openPortas(eq) });
  }
  if (!novo) {
    extra.push({
      label: 'Remover do rack', danger: true,
      async onClick(close) {
        if (!confirm(`Remover ${eq.nome} do rack?`)) return;
        await api('DELETE', `/api/equipamentos/${eq.id}`);
        close();
        await recarregarEquip();
      },
    });
  }

  openForm({
    title: novo ? 'Adicionar ao rack' : 'Editar equipamento',
    fields,
    extra,
    onOpen(form) {
      form.elements.u_inicio.addEventListener('input', () => { uTocado = true; });
      form.elements.altura_u.addEventListener('input', () => {
        if (uTocado) return;
        const h = Number(form.elements.altura_u.value);
        if (Number.isInteger(h) && h > 0) form.elements.u_inicio.value = topU - h + 1;
      });
    },
    async onSubmit(v) {
      const body = {
        rack_id: rack.id, hostid, nome: v.nome.trim(), u_inicio: v.u_inicio, altura_u: v.altura_u,
        face: v.face, full_depth: v.full_depth,
      };
      if (semHost) {
        body.tipo_id = v.tipo_id ? Number(v.tipo_id) : null;
        body.ip = v.ip.trim() || null;
        body.modelo = v.modelo.trim() || null;
        body.observacao = v.observacao.trim() || null;
      }
      if (!body.nome) throw new Error('Informe o nome do equipamento.');
      const err = checarPosicao(rack, body, eq?.id);
      if (err) throw new Error(err[0].toUpperCase() + err.slice(1) + '.');
      const salvo = await salvarEquip(eq?.id, body);
      await recarregarEquip();
      const tipo = state.tipos.find((t) => t.id === body.tipo_id);
      if (novo && tipo?.tem_portas) {
        // patch panel recém-criado: já abre o cadastro de portas
        setTimeout(() => openPortas(state.equip.find((e) => e.id === salvo.id)), 0);
      }
    },
  });
}

/* ----------------------------------------------------------- foto do equipamento */
// Reduz a foto no navegador (lado maior 1600 px, JPEG) antes de enviar: fotos de celular chegam a vários MB.
async function reduzirImagem(file) {
  try {
    const bmp = await createImageBitmap(file);
    const esc = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * esc); c.height = Math.round(bmp.height * esc);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85));
    return blob || file;
  } catch { return file; }
}

function fotoBloco(eq) {
  const box = el('div', 'foto-box');
  const render = () => {
    box.innerHTML = '';
    const atual = state.equip.find((e) => e.id === eq.id) || eq;
    if (atual.foto) {
      const src = `/api/equipamentos/${eq.id}/foto?v=${encodeURIComponent(atual.foto)}`;
      const link = el('a'); link.href = src; link.target = '_blank'; link.rel = 'noopener'; link.title = 'Abrir em tamanho real';
      const img = el('img'); img.src = src; img.alt = `Foto de ${eq.nome}`;
      link.append(img); box.append(link);
    } else {
      box.append(el('p', 'note', 'Sem foto. Você pode enviar uma aqui ou pelo WhatsApp (opção 4 do /dcim).'));
    }
    const row = el('div', 'foto-acoes');
    const input = el('input'); input.type = 'file'; input.accept = 'image/*'; input.hidden = true;
    const enviar = el('button', 'btn small', atual.foto ? 'Trocar foto' : 'Enviar foto'); enviar.type = 'button';
    enviar.addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
      const f = input.files[0];
      if (!f) return;
      try {
        const blob = await reduzirImagem(f);
        const res = await fetch(`/api/equipamentos/${eq.id}/foto`, { method: 'PUT', headers: { 'Content-Type': blob.type || f.type }, body: blob });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).erro || `Erro ${res.status}`);
        await recarregarEquip();
        render();
      } catch (err) { toast(err.message, 'error'); }
    });
    row.append(enviar, input);
    if (atual.foto) {
      const rem = el('button', 'btn small danger', 'Remover foto'); rem.type = 'button';
      rem.addEventListener('click', async () => {
        try { await api('DELETE', `/api/equipamentos/${eq.id}/foto`); await recarregarEquip(); render(); } catch (err) { toast(err.message, 'error'); }
      });
      row.append(rem);
    }
    box.append(row);
  };
  render();
  return box;
}

/* ------------------------------------------------------- datacenters e racks */
function openDatacenter(dc) {
  openForm({
    title: dc ? 'Editar datacenter' : 'Novo datacenter',
    fields: [
      { name: 'nome', label: 'Nome', type: 'text', value: dc?.nome || '', required: true, maxlength: 100 },
      { name: 'sigla', label: 'Sigla (3)', type: 'text', value: dc?.sigla || '', required: true, maxlength: 3, pattern: '[A-Za-z0-9]{3}', hint: 'Use 3 letras ou números', placeholder: 'DC1', upper: true, row: 'loc' },
      { name: 'pais', label: 'País (2)', type: 'text', value: dc?.pais || '', required: true, maxlength: 2, pattern: '[A-Za-z]{2}', hint: 'Use 2 letras, ex.: BR', placeholder: 'BR', upper: true, row: 'loc' },
      { name: 'uf', label: 'UF (2)', type: 'text', value: dc?.uf || '', required: true, maxlength: 2, pattern: '[A-Za-z]{2}', hint: 'Use 2 letras, ex.: SP', placeholder: 'SP', upper: true, row: 'loc' },
      { name: 'municipio', label: 'Município (3)', type: 'text', value: dc?.municipio || '', required: true, maxlength: 3, pattern: '[A-Za-z]{3}', hint: 'Use 3 letras, ex.: RPO', placeholder: 'RPO', upper: true, row: 'loc' },
      { name: 'localizacao', label: 'Endereço (opcional)', type: 'text', value: dc?.localizacao || '', maxlength: 200 },
    ],
    async onSubmit(v) {
      const body = {
        nome: v.nome.trim(), sigla: v.sigla.trim().toUpperCase(), pais: v.pais.trim().toUpperCase(),
        uf: v.uf.trim().toUpperCase(), municipio: v.municipio.trim().toUpperCase(), localizacao: v.localizacao.trim() || null,
      };
      const salvo = dc ? await api('PUT', `/api/datacenters/${dc.id}`, body) : await api('POST', '/api/datacenters', body);
      state.dcId = salvo.id; state.rackId = null;
      await loadAll();
    },
    extra: dc ? [{
      label: 'Excluir datacenter', danger: true,
      async onClick(close) {
        const n = state.racks.filter((r) => r.datacenter_id === dc.id).length;
        if (!confirm(`Excluir ${dc.nome}? Os ${n} racks e todos os equipamentos cadastrados nele também serão excluídos.`)) return;
        await api('DELETE', `/api/datacenters/${dc.id}`);
        close();
        state.dcId = null; state.rackId = null;
        await loadAll();
      },
    }] : [],
  });
}

function openRack(rack) {
  openForm({
    title: rack ? 'Editar rack' : 'Novo rack',
    fields: [
      { name: 'nome', label: 'Nome', type: 'text', value: rack?.nome || '', required: true },
      { name: 'cage', label: 'Cage', type: 'text', value: rack?.cage || '' },
      { name: 'altura_u', label: 'Altura (U)', type: 'number', value: rack?.altura_u || 42, min: 1, max: 100 },
      { name: 'datacenter_id', label: 'Datacenter', type: 'select', value: String(rack?.datacenter_id || state.dcId),
        options: state.datacenters.map((d) => ({ value: String(d.id), label: rotuloDc(d) })) },
    ],
    async onSubmit(v) {
      const body = { nome: v.nome.trim(), cage: v.cage.trim() || null, altura_u: v.altura_u, datacenter_id: Number(v.datacenter_id) };
      const salvo = rack ? await api('PUT', `/api/racks/${rack.id}`, body) : await api('POST', '/api/racks', body);
      state.dcId = salvo.datacenter_id; state.rackId = salvo.id;
      await loadAll();
    },
    extra: rack ? [{
      label: 'Excluir rack', danger: true,
      async onClick(close) {
        const n = equipDoRack(rack.id).length;
        if (!confirm(`Excluir o rack ${rack.nome}? ${n ? `Os ${n} equipamentos posicionados nele serão removidos do cadastro.` : ''}`)) return;
        await api('DELETE', `/api/racks/${rack.id}`);
        close();
        state.rackId = null;
        await loadAll();
      },
    }] : [],
  });
}

/* ------------------------------------------------------- construtor de formulário */
function fillSelect(select, options, value) {
  select.innerHTML = '';
  for (const o of options) select.append(new Option(o.label, o.value, false, o.value === value));
}

function openForm({ title, fields, submitLabel = 'Salvar', onSubmit, onOpen, extra = [] }) {
  const dlg = $('#dlg');
  dlg.innerHTML = '';
  const form = el('form', 'form');
  form.append(el('h2', '', title));

  let rowKey = null, rowEl = null;
  for (const f of fields) {
    if (f.type === 'note') { form.append(el('p', 'note', f.text)); rowKey = null; continue; }
    if (f.type === 'custom') { form.append(f.node()); rowKey = null; continue; }
    if (f.type === 'button') {
      const b = el('button', 'btn small', f.label);
      b.type = 'button';
      b.addEventListener('click', () => f.onClick(form));
      form.append(b); rowKey = null;
      continue;
    }
    const wrap = el('label', f.type === 'checkbox' ? 'field check' : 'field');
    let input;
    if (f.type === 'select') {
      input = el('select');
      fillSelect(input, f.options, f.value);
    } else if (f.type === 'textarea') {
      input = el('textarea');
      input.value = f.value ?? '';
    } else {
      input = el('input');
      input.type = f.type;
      if (f.type === 'checkbox') input.checked = !!f.value; else input.value = f.value ?? '';
      if (f.min != null) input.min = f.min;
      if (f.max != null) input.max = f.max;
      if (f.pattern) { input.pattern = f.pattern; if (f.hint) input.title = f.hint; }
      if (f.upper) input.addEventListener('input', () => { input.value = input.value.toUpperCase(); });
    }
    if (f.maxlength) input.maxLength = f.maxlength;
    if (f.placeholder) input.placeholder = f.placeholder;
    if (f.required) input.required = true;
    input.name = f.name;
    if (f.type === 'checkbox') wrap.append(input, document.createTextNode(f.label));
    else wrap.append(document.createTextNode(f.label), input);

    if (f.row) {
      if (rowKey !== f.row) { rowEl = el('div', 'field-row'); form.append(rowEl); rowKey = f.row; }
      rowEl.append(wrap);
    } else {
      form.append(wrap); rowKey = null;
    }
  }

  const errBox = el('p', 'form-error');
  errBox.setAttribute('role', 'alert');
  form.append(errBox);

  const foot = el('div', 'form-foot');
  for (const x of extra) {
    const b = el('button', `btn ${x.danger ? 'danger' : ''}`, x.label);
    b.type = 'button';
    b.addEventListener('click', async () => {
      try { await x.onClick(() => dlg.close()); } catch (err) { errBox.textContent = err.message; }
    });
    foot.append(b);
  }
  if (extra.length) foot.lastElementChild.classList.add('spacer');
  const cancel = el('button', 'btn', 'Cancelar');
  cancel.type = 'button';
  cancel.addEventListener('click', () => dlg.close());
  const ok = el('button', 'btn primary', submitLabel);
  ok.type = 'submit';
  foot.append(cancel, ok);
  form.append(foot);

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    errBox.textContent = '';
    const v = {};
    for (const f of fields) {
      if (f.type === 'note' || f.type === 'button' || f.type === 'custom') continue;
      const i = form.elements[f.name];
      v[f.name] = f.type === 'checkbox' ? i.checked : f.type === 'number' ? Number(i.value) : i.value;
    }
    ok.disabled = true;
    try { await onSubmit(v); dlg.close(); } catch (err) { errBox.textContent = err.message; } finally { ok.disabled = false; }
  });

  dlg.append(form);
  dlg.showModal();
  if (onOpen) onOpen(form);
  const first = form.querySelector('input:not([type="checkbox"]), select');
  if (first) first.focus();
}

/* ------------------------------------------- painéis auxiliares (tipos e portas) */
// Abre o segundo diálogo, por cima do formulário; onClose roda ao fechar.
function openPanel(title, { onClose } = {}) {
  const dlg = $('#dlg2');
  dlg.innerHTML = '';
  dlg.classList.add('wide');
  const box = el('div', 'form');
  box.append(el('h2', '', title));
  const err = el('p', 'form-error');
  err.setAttribute('role', 'alert');
  const foot = el('div', 'form-foot');
  const close = el('button', 'btn primary', 'Fechar');
  close.type = 'button';
  close.addEventListener('click', () => dlg.close());
  foot.append(close);
  dlg.append(box);
  const finish = () => { box.append(err, foot); dlg.showModal(); };
  dlg.addEventListener('close', () => { if (onClose) onClose(); }, { once: true });
  return { box, err, finish };
}

function tableOf(headers) {
  const wrap = el('div', 'tbl-scroll');
  const t = el('table', 'tbl');
  const thead = el('thead');
  const tr = el('tr');
  for (const h of headers) tr.append(el('th', '', h));
  thead.append(tr);
  const tbody = el('tbody');
  t.append(thead, tbody);
  wrap.append(t);
  return { wrap, tbody };
}

function textInput(value, label, maxlength) {
  const i = el('input');
  i.type = 'text'; i.value = value || ''; i.maxLength = maxlength; i.setAttribute('aria-label', label);
  return i;
}

function openTipos(onChange) {
  const { box, err, finish } = openPanel('Tipos de equipamento', { onClose: onChange });
  box.append(el('p', 'note', 'Tipos disponíveis ao adicionar itens sem host. Marque "Tem portas" para tipos como patch panel.'));
  const { wrap, tbody } = tableOf(['Nome', 'Tem portas', '']);
  box.append(wrap);

  async function recarregar() {
    state.tipos = await api('GET', '/api/tipos');
    tbody.innerHTML = '';

    // linha de inclusão
    const add = el('tr', 'add');
    const nome = textInput('', 'Nome do novo tipo', 60);
    nome.placeholder = 'Novo tipo';
    const tp = el('input'); tp.type = 'checkbox'; tp.setAttribute('aria-label', 'Tem portas');
    const bAdd = el('button', 'btn', 'Adicionar'); bAdd.type = 'button';
    const enviar = async () => {
      err.textContent = '';
      try {
        await api('POST', '/api/tipos', { nome: nome.value, tem_portas: tp.checked });
        await recarregar();
        $('#dlg2 input[type="text"]').focus();
      } catch (e) { err.textContent = e.message; }
    };
    bAdd.addEventListener('click', enviar);
    nome.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); enviar(); } });
    for (const c of [nome, tp, bAdd]) { const td = el('td'); td.append(c); add.append(td); }
    tbody.append(add);

    for (const t of state.tipos) {
      const tr = el('tr');
      const n = textInput(t.nome, `Nome do tipo ${t.nome}`, 60);
      const c = el('input'); c.type = 'checkbox'; c.checked = !!t.tem_portas; c.setAttribute('aria-label', `${t.nome} tem portas`);
      const salvar = async () => {
        err.textContent = '';
        try { await api('PUT', `/api/tipos/${t.id}`, { nome: n.value, tem_portas: c.checked }); await recarregar(); }
        catch (e) { err.textContent = e.message; await recarregar(); }
      };
      n.addEventListener('change', salvar); c.addEventListener('change', salvar);
      const del = el('button', 'btn danger', 'Excluir'); del.type = 'button';
      del.addEventListener('click', async () => {
        if (!confirm(`Excluir o tipo ${t.nome}?`)) return;
        err.textContent = '';
        try { await api('DELETE', `/api/tipos/${t.id}`); await recarregar(); } catch (e) { err.textContent = e.message; }
      });
      for (const x of [n, c, del]) { const td = el('td'); td.append(x); tr.append(td); }
      tbody.append(tr);
    }
  }
  recarregar().then(finish).catch((e) => toast(e.message, 'error'));
}

function openPortas(eq) {
  const { box, err, finish } = openPanel(`Portas de ${eq.nome}`, { onClose: () => recarregarEquip() });
  const resumo = el('p', 'note');
  box.append(resumo);
  const { wrap, tbody } = tableOf(['ID', 'Destino', 'Observação', '']);
  box.append(wrap);
  let portas = [];

  const natural = (a, b) => a.porta_id.localeCompare(b.porta_id, 'pt-BR', { numeric: true });

  async function recarregar() {
    portas = (await api('GET', `/api/equipamentos/${eq.id}/portas`)).sort(natural);
    const comDestino = portas.filter((p) => (p.destino || '').trim()).length;
    resumo.textContent = `${portas.length} portas cadastradas, ${comDestino} com destino. Cada alteração é salva ao sair do campo.`;
    tbody.innerHTML = '';

    const add = el('tr', 'add');
    const id = textInput('', 'ID da nova porta', 30); id.placeholder = 'ID';
    const dest = textInput('', 'Destino da nova porta', 200); dest.placeholder = 'Destino';
    const obs = textInput('', 'Observação da nova porta', 500); obs.placeholder = 'Observação';
    const bAdd = el('button', 'btn primary', 'Adicionar'); bAdd.type = 'button';
    const enviar = async () => {
      err.textContent = '';
      try {
        await api('POST', `/api/equipamentos/${eq.id}/portas`, { porta_id: id.value, destino: dest.value, observacao: obs.value });
        await recarregar();
        const novoId = $('#dlg2 tr.add input');
        novoId.focus();
      } catch (e) { err.textContent = e.message; }
    };
    bAdd.addEventListener('click', enviar);
    for (const i of [id, dest, obs]) i.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); enviar(); } });
    for (const c of [id, dest, obs, bAdd]) { const td = el('td'); td.append(c); add.append(td); }
    tbody.append(add);

    for (const p of portas) {
      const tr = el('tr');
      const i1 = textInput(p.porta_id, `ID da porta ${p.porta_id}`, 30);
      const i2 = textInput(p.destino, `Destino da porta ${p.porta_id}`, 200);
      const i3 = textInput(p.observacao, `Observação da porta ${p.porta_id}`, 500);
      const salvar = async () => {
        err.textContent = '';
        try {
          await api('PUT', `/api/portas/${p.id}`, { porta_id: i1.value, destino: i2.value, observacao: i3.value });
          await recarregar();
        } catch (e) { err.textContent = e.message; await recarregar(); }
      };
      for (const i of [i1, i2, i3]) i.addEventListener('change', salvar);
      const del = el('button', 'btn danger', 'Excluir'); del.type = 'button';
      del.addEventListener('click', async () => {
        if (!confirm(`Excluir a porta ${p.porta_id}?`)) return;
        err.textContent = '';
        try { await api('DELETE', `/api/portas/${p.id}`); await recarregar(); } catch (e) { err.textContent = e.message; }
      });
      for (const c of [i1, i2, i3, del]) { const td = el('td'); td.append(c); tr.append(td); }
      tbody.append(tr);
    }
  }
  recarregar().then(() => { finish(); $('#dlg2 tr.add input').focus(); }).catch((e) => toast(e.message, 'error'));
}

/* ------------------------------------------------------------- hosts do Zabbix */
async function loadHosts() {
  const q = new URLSearchParams();
  if (state.search) q.set('search', state.search);
  if (state.groupId) q.set('groupid', state.groupId);
  try {
    state.hosts = await api('GET', `/api/zabbix/hosts?${q}`);
    state.hostsError = null;
    state.hostsTruncated = state.hosts.length >= HOSTS_LIMIT;
    for (const h of state.hosts) state.hostMap.set(h.hostid, h);
  } catch (err) {
    state.hosts = []; state.hostsError = err.message;
  }
  renderHosts();
  paintDevices();
}

async function loadGroups() {
  try {
    const groups = await api('GET', '/api/zabbix/hostgroups');
    const sel = $('#group-select');
    for (const g of groups) sel.append(new Option(g.name, g.groupid));
  } catch { /* o erro aparece na lista de hosts */ }
}

function renderHosts() {
  const list = $('#hosts');
  const note = $('#host-note');
  list.innerHTML = '';
  note.className = 'note';
  if (state.hostsError) {
    note.className = 'note error';
    note.textContent = `${state.hostsError}. Confira ZABBIX_URL, ZABBIX_USER e ZABBIX_PASSWORD no arquivo .env.`;
    return;
  }
  note.textContent = state.hostsTruncated
    ? `Mostrando os primeiros ${HOSTS_LIMIT} hosts. Refine a busca para ver outros.`
    : state.hosts.length ? 'Arraste um host até a U desejada no rack.' : 'Nenhum host encontrado.';

  const colocados = new Map(state.equip.filter((e) => e.hostid).map((e) => [e.hostid, e]));
  for (const h of state.hosts) {
    const li = el('li', 'host');
    li.tabIndex = 0;
    const onde = colocados.get(h.hostid);
    li.append(el('span', `led ${ledClass(h.hostid)}`));
    const txt = el('div', 'txt');
    txt.append(el('div', 'n', h.name));
    const sub = el('div', 'ip');
    const ip = hostIp(h.hostid);
    if (ip) sub.append(el('span', '', ip));
    if (h.host && h.host !== h.name) sub.append(el('span', '', h.host)); // nome técnico do Zabbix
    if (sub.children.length) txt.append(sub);
    li.append(txt);
    li.title = [h.name, h.host !== h.name ? h.host : '', ip, h.inventory?.hardware || ''].filter(Boolean).join('\n');

    if (onde) {
      li.classList.add('placed');
      li.append(el('span', 'where', `${onde.rack_nome}, U${onde.u_inicio}`));
      li.title += `\nJá está em ${onde.rack_nome}. Clique para ir até o rack.`;
      li.addEventListener('click', () => {
        state.dcId = onde.datacenter_id; state.rackId = onde.rack_id; saveSelection();
        renderAll(); refreshStatus();
      });
    } else {
      li.draggable = true;
      li.addEventListener('dragstart', (ev) => {
        drag = { type: 'host', host: h };
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', h.name);
      });
      li.addEventListener('dragend', () => { drag = null; clearGhosts(); });
    }
    list.append(li);
  }
}

// Atualiza luzes de status, IP e hardware dos equipamentos com host do rack aberto.
function paintDevices() {
  document.querySelectorAll('.device[data-hostid]').forEach((d) => {
    const id = d.dataset.hostid;
    d.querySelector('.led').className = `led ${ledClass(id)}`;
    const ip = hostIp(id);
    if (ip) d.querySelector('.dev-meta').textContent = ip;
    d.querySelector('.dev-hw').textContent = hostHw(id);
  });
}

async function refreshStatus() {
  const ids = [...new Set(equipDoRack(state.rackId).filter((e) => e.hostid).map((e) => e.hostid))];
  if (!ids.length) return;
  try {
    const hosts = await api('GET', `/api/zabbix/hosts?hostids=${ids.join(',')}`);
    for (const h of hosts) state.hostMap.set(h.hostid, h);
    paintDevices();
  } catch { /* sem Zabbix: os equipamentos continuam visíveis, sem status */ }
}

/* ------------------------------------------------------------------- dashboard */
async function loadZbxDash() {
  const ids = [...new Set(state.equip.filter((e) => e.hostid).map((e) => e.hostid))];
  try {
    const lotes = [];
    for (let i = 0; i < ids.length; i += 150) lotes.push(ids.slice(i, i + 150));
    const [resumo, ...respostas] = await Promise.all([
      api('GET', '/api/zabbix/resumo'),
      ...lotes.map((l) => api('GET', `/api/zabbix/hosts?hostids=${l.join(',')}`)),
    ]);
    const hosts = respostas.flat();
    for (const h of hosts) state.hostMap.set(h.hostid, h);
    state.zbx = { ok: true, total: resumo.total, found: new Set(hosts.map((h) => h.hostid)) };
  } catch (err) {
    state.zbx = { ok: false, error: err.message };
  }
  if (state.view === 'dash') renderDashboard();
}

function dcStats() {
  return state.datacenters.map((dc) => {
    const racks = racksDoDc(dc.id);
    const total = racks.reduce((s, r) => s + r.altura_u, 0);
    const used = racks.reduce((s, r) => s + usedU(r), 0);
    return { dc, racks: racks.length, total, used, free: total - used };
  });
}

function meterRow({ name, value, fraction, onClick }) {
  const row = el(onClick ? 'button' : 'div', 'meter-row');
  if (onClick) { row.type = 'button'; row.addEventListener('click', onClick); }
  const top = el('div', 'mr-top');
  top.append(el('span', 'mr-name', name), el('span', 'mr-val', value));
  const meter = el('div', 'meter');
  const fill = el('span', fraction >= 0.95 ? 'full' : fraction >= 0.8 ? 'warn' : '');
  fill.style.width = `${Math.min(100, fraction * 100)}%`;
  meter.append(fill);
  row.append(top, meter);
  return row;
}

function panel(title) {
  const p = el('section', 'panel');
  p.append(el('h3', '', title));
  return p;
}

function renderDashboard() {
  const root = $('#view-dash');
  root.innerHTML = '';
  const wrap = el('div', 'dash-wrap');
  root.append(wrap);
  if (!state.loaded) return;

  if (!state.datacenters.length) {
    const box = el('div', 'empty');
    box.style.marginTop = '80px';
    box.append(el('p', '', 'Nenhum datacenter cadastrado ainda. Comece criando o primeiro para ver o painel.'));
    const b = el('button', 'btn primary', 'Novo datacenter');
    b.type = 'button'; b.addEventListener('click', () => openDatacenter());
    box.append(b);
    wrap.append(box);
    return;
  }

  const stats = dcStats();
  const totalU = stats.reduce((s, x) => s + x.total, 0);
  const usedTotal = stats.reduce((s, x) => s + x.used, 0);
  const comHost = state.equip.filter((e) => e.hostid).length;
  const semHost = state.equip.length - comHost;
  const zbx = state.zbx;
  const semRack = zbx?.ok ? Math.max(0, zbx.total - [...new Set(state.equip.filter((e) => e.hostid).map((e) => e.hostid))].filter((id) => zbx.found.has(id)).length) : null;

  wrap.append(el('h2', '', 'Visão geral'));

  const kpis = el('div', 'kpis');
  const kpi = (n, l) => { const k = el('div', 'kpi'); k.append(el('div', 'n', n), el('div', 'l', l)); kpis.append(k); };
  kpi(fmt(state.datacenters.length), 'Datacenters');
  kpi(fmt(state.racks.length), 'Racks');
  kpi(fmt(state.equip.length), 'Equipamentos nos racks');
  kpi(fmt(comHost), 'Associados a hosts do Zabbix');
  kpi(fmt(semHost), 'Itens sem host');
  kpi(semRack == null ? '-' : fmt(semRack), 'Hosts do Zabbix sem rack');
  wrap.append(kpis);

  const grid = el('div', 'dash-grid');
  const left = el('div', 'dash-col');
  const right = el('div', 'dash-col');
  grid.append(left, right);
  wrap.append(grid);

  // Datacenters com mais espaço livre (em % das U)
  const pDc = panel('Datacenters com mais espaço livre');
  const ordenados = [...stats].sort((a, b) => pct(b.free, b.total) - pct(a.free, a.total) || b.free - a.free).slice(0, 5);
  for (const s of ordenados) {
    pDc.append(meterRow({
      name: rotuloDc(s.dc),
      value: s.total ? `${pct(s.free, s.total)}% livre, ${fmt(s.free)} de ${fmt(s.total)}U, ${s.racks} racks` : 'sem racks',
      fraction: s.total ? s.used / s.total : 0,
      onClick: () => { state.dcId = s.dc.id; state.rackId = racksDoDc(s.dc.id)[0]?.id ?? null; saveSelection(); setView('racks'); },
    }));
  }
  left.append(pDc);

  // Racks mais cheios
  const pRk = panel('Racks mais cheios');
  const cheios = state.racks
    .map((r) => ({ r, used: usedU(r) }))
    .sort((a, b) => b.used / b.r.altura_u - a.used / a.r.altura_u || b.r.altura_u - a.r.altura_u)
    .slice(0, 5);
  if (!cheios.length) pRk.append(el('p', 'note', 'Nenhum rack cadastrado.'));
  for (const { r, used } of cheios) {
    const dc = state.datacenters.find((d) => d.id === r.datacenter_id);
    pRk.append(meterRow({
      name: `${r.nome}${dc?.sigla ? `, ${dc.sigla}` : ''}`,
      value: `${pct(used, r.altura_u)}% ocupado, ${r.altura_u - used}U livres`,
      fraction: used / r.altura_u,
      onClick: () => { state.dcId = r.datacenter_id; state.rackId = r.id; saveSelection(); setView('racks'); },
    }));
  }
  left.append(pRk);

  // Ocupação geral
  const pOc = panel('Ocupação geral');
  pOc.append(meterRow({
    name: `${pct(usedTotal, totalU)}% das U ocupadas`,
    value: `${fmt(usedTotal)} de ${fmt(totalU)}U, ${fmt(totalU - usedTotal)}U livres`,
    fraction: totalU ? usedTotal / totalU : 0,
  }));
  right.append(pOc);

  // Status dos hosts posicionados
  const pSt = panel('Hosts posicionados nos racks');
  if (!zbx) {
    pSt.append(el('p', 'note', 'Consultando o Zabbix...'));
  } else if (!zbx.ok) {
    const n = el('p', 'note error', `Zabbix indisponível: ${zbx.error}`);
    pSt.append(n);
  } else {
    const cont = { up: 0, down: 0, off: 0, unknown: 0, missing: 0 };
    for (const id of new Set(state.equip.filter((e) => e.hostid).map((e) => e.hostid))) {
      cont[zbx.found.has(id) ? hostState(id) || 'unknown' : 'missing']++;
    }
    const linhas = [
      ['up', 'Disponíveis'], ['down', 'Indisponíveis'], ['off', 'Desativados'], ['unknown', 'Status desconhecido'], ['missing', 'Não encontrados no Zabbix'],
    ];
    for (const [k, rot] of linhas) {
      if (k === 'missing' && !cont.missing) continue;
      const li = el('div', 'stat-line');
      li.append(el('span', `led ${k === 'up' || k === 'down' || k === 'off' ? k : ''}`), el('span', '', rot), el('span', 'v', fmt(cont[k])));
      pSt.append(li);
    }
    pSt.append(el('p', 'note', `${fmt(zbx.total)} hosts no Zabbix, ${fmt(semRack)} ainda sem rack.`));
  }
  right.append(pSt);

  // Patch panels
  const pp = state.equip.filter((e) => e.tem_portas);
  const pPp = panel('Patch panels');
  if (!pp.length) {
    pPp.append(el('p', 'note', 'Nenhum item com portas cadastrado.'));
  } else {
    const total = pp.reduce((s, e) => s + e.portas_total, 0);
    const comDest = pp.reduce((s, e) => s + e.portas_com_destino, 0);
    const l1 = el('div', 'stat-line'); l1.append(el('span', '', 'Patch panels nos racks'), el('span', 'v', fmt(pp.length)));
    const l2 = el('div', 'stat-line'); l2.append(el('span', '', 'Portas cadastradas'), el('span', 'v', fmt(total)));
    const l3 = el('div', 'stat-line'); l3.append(el('span', '', 'Portas com destino'), el('span', 'v', fmt(comDest)));
    pPp.append(l1, l2, l3);
  }
  right.append(pPp);

  // Itens sem host por tipo
  const porTipo = new Map();
  for (const e of state.equip.filter((x) => !x.hostid)) {
    const k = e.tipo_nome || 'Sem tipo';
    porTipo.set(k, (porTipo.get(k) || 0) + 1);
  }
  if (porTipo.size) {
    const pTp = panel('Itens sem host por tipo');
    for (const [k, n] of [...porTipo].sort((a, b) => b[1] - a[1])) {
      const li = el('div', 'stat-line');
      li.append(el('span', '', k), el('span', 'v', fmt(n)));
      pTp.append(li);
    }
    right.append(pTp);
  }
}

/* -------------------------------------------------------------------- WhatsApp */
async function loadWhats() {
  try {
    const [tecnicos, auditoria, status] = await Promise.all([
      api('GET', '/api/tecnicos'), api('GET', '/api/auditoria?limit=30'), api('GET', '/api/bot/status'),
    ]);
    renderWhats({ tecnicos, auditoria, status });
  } catch (err) { toast(err.message, 'error'); }
}

function renderWhats({ tecnicos, auditoria, status }) {
  const root = $('#view-whats');
  const foco = document.activeElement?.closest?.('#view-whats') ? document.activeElement.getAttribute('aria-label') : null;
  root.innerHTML = '';
  const wrap = el('div', 'dash-wrap');
  root.append(wrap);
  wrap.append(el('h2', '', 'WhatsApp'));

  const grid = el('div', 'dash-grid');
  const left = el('div', 'dash-col');
  const right = el('div', 'dash-col');
  grid.append(left, right);
  wrap.append(grid);

  // Técnicos autorizados
  const p = panel('Técnicos autorizados');
  p.append(el('p', 'note', 'Só estes números conseguem usar o comando /dcim. Mensagens de qualquer outro número são ignoradas, sem resposta. Informe o número com DDI e DDD, ex.: 5516999999999.'));
  const err = el('p', 'form-error');
  err.setAttribute('role', 'alert');
  const { wrap: tw, tbody } = tableOf(['Nome', 'Número', 'Ativo', '']);
  tw.style.maxHeight = 'none';

  const add = el('tr', 'add');
  const nome = textInput('', 'Nome do novo técnico', 80); nome.placeholder = 'Nome';
  const tel = textInput('', 'Número do novo técnico', 20); tel.placeholder = '5516999999999';
  const bAdd = el('button', 'btn primary', 'Adicionar'); bAdd.type = 'button';
  const enviar = async () => {
    err.textContent = '';
    try { await api('POST', '/api/tecnicos', { nome: nome.value, telefone: tel.value }); await loadWhats(); }
    catch (e) { err.textContent = e.message; }
  };
  bAdd.addEventListener('click', enviar);
  for (const i of [nome, tel]) i.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); enviar(); } });
  for (const c of [nome, tel, el('span'), bAdd]) { const td = el('td'); td.append(c); add.append(td); }
  tbody.append(add);

  for (const t of tecnicos) {
    const tr = el('tr');
    const n = textInput(t.nome, `Nome de ${t.nome}`, 80);
    const f = textInput(t.telefone, `Número de ${t.nome}`, 20);
    const a = el('input'); a.type = 'checkbox'; a.checked = !!t.ativo; a.setAttribute('aria-label', `${t.nome} ativo`);
    const salvar = async () => {
      err.textContent = '';
      try { await api('PUT', `/api/tecnicos/${t.id}`, { nome: n.value, telefone: f.value, ativo: a.checked }); await loadWhats(); }
      catch (e) { err.textContent = e.message; await loadWhats(); }
    };
    for (const i of [n, f, a]) i.addEventListener('change', salvar);
    const del = el('button', 'btn danger', 'Excluir'); del.type = 'button';
    del.addEventListener('click', async () => {
      if (!confirm(`Remover ${t.nome} da lista de técnicos?`)) return;
      try { await api('DELETE', `/api/tecnicos/${t.id}`); await loadWhats(); } catch (e) { err.textContent = e.message; }
    });
    for (const c of [n, f, a, del]) { const td = el('td'); td.append(c); tr.append(td); }
    tbody.append(tr);
  }
  p.append(tw, err);
  left.append(p);

  // Conexão com o bot
  const pc = panel('Conexão com o script do WPPConnect');
  if (status.configurado) {
    pc.append(el('p', 'note', 'BOT_TOKEN configurado. O script envia as mensagens para /api/bot/mensagem usando esse token (veja wpp/dcim-bridge.js).'));
  } else {
    pc.append(el('p', 'note error', 'BOT_TOKEN não está configurado no arquivo .env. Enquanto isso o WhatsApp fica desativado.'));
  }
  right.append(pc);

  // Últimas ações
  const pa = panel('Últimas ações pelo WhatsApp');
  if (!auditoria.length) pa.append(el('p', 'note', 'Nenhuma ação registrada ainda.'));
  for (const a of auditoria) {
    const li = el('div', 'stat-line');
    const txt = el('span');
    txt.append(el('strong', '', a.quem || 'desconhecido'), document.createTextNode(`, ${a.acao}: ${a.detalhe || ''}`));
    li.append(txt, el('span', 'v', a.quando.slice(5, 16).replace('-', '/')));
    li.style.alignItems = 'flex-start';
    pa.append(li);
  }
  right.append(pa);

  if (foco) root.querySelector(`[aria-label="${CSS.escape(foco)}"]`)?.focus();
}

/* ---------------------------------------------------------------------- início */
$('#tab-dash').addEventListener('click', () => setView('dash'));
$('#tab-racks').addEventListener('click', () => setView('racks'));
$('#tab-whats').addEventListener('click', () => setView('whats'));

$('#dc-select').addEventListener('change', (ev) => {
  state.dcId = Number(ev.target.value) || null;
  state.rackId = racksDoDc()[0]?.id ?? null;
  saveSelection(); renderAll(); refreshStatus();
});
$('#dc-new').addEventListener('click', () => openDatacenter());
$('#dc-edit').addEventListener('click', () => {
  const dc = state.datacenters.find((d) => d.id === state.dcId);
  if (dc) openDatacenter(dc);
});
$('#rack-new').addEventListener('click', () => openRack());

let searchTimer;
$('#host-search').addEventListener('input', (ev) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.search = ev.target.value.trim(); loadHosts(); }, 300);
});
$('#group-select').addEventListener('change', (ev) => { state.groupId = ev.target.value; loadHosts(); });

setInterval(refreshStatus, 60000);

loadSelection();
setView('dash');
loadAll()
  .then(() => { loadGroups(); loadHosts(); loadZbxDash(); })
  .catch((err) => toast(err.message, 'error'));

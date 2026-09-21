'use strict';
// Conversa do técnico pelo WhatsApp. Recebe o texto de cada mensagem e devolve
// { respostas: [texto, ...], ativa: boolean }. O estado de cada técnico fica no SQLite.

const net = require('net');
const db = require('./db');
const zabbix = require('./zabbix');
const { txt, validarEquipamento, inserirEquipamento, registrarAuditoria } = require('./services');
const fotos = require('./fotos');
const { imagemDoRack } = require('./rackimg');

const TTL_MS = 10 * 60 * 1000; // sessão expira após 10 minutos sem mensagens
const MAX_LISTA = 25;          // itens mostrados por lista
const MAX_MSG = 3500;          // tamanho máximo de cada mensagem enviada
const SQLITE_CONSTRAINT_UNIQUE = 2067;

const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

/* ------------------------------------------------------------------ sessões */
function carregar(chave) {
  const r = db.prepare('SELECT estado, atualizado_em FROM bot_sessoes WHERE chave = ?').get(chave);
  if (!r) return null;
  if (Date.now() - r.atualizado_em > TTL_MS) { apagar(chave); return { expirada: true }; }
  return JSON.parse(r.estado);
}
function salvar(chave, est) {
  db.prepare(
    `INSERT INTO bot_sessoes (chave, estado, atualizado_em) VALUES (?, ?, ?)
     ON CONFLICT(chave) DO UPDATE SET estado = excluded.estado, atualizado_em = excluded.atualizado_em`
  ).run(chave, JSON.stringify(est), Date.now());
}
function apagar(chave) { db.prepare('DELETE FROM bot_sessoes WHERE chave = ?').run(chave); }
const novoEstado = () => ({ passo: 'menu', fluxo: null, d: {}, ops: [], titulo: '' });

/* ------------------------------------------------------------------- dados */
const datacenters = () => db.prepare('SELECT * FROM datacenters ORDER BY nome').all();
const racksDe = (dcId) => db.prepare('SELECT * FROM racks WHERE datacenter_id = ? ORDER BY cage, nome').all(dcId);
const rackPorId = (id) => db.prepare('SELECT * FROM racks WHERE id = ?').get(id);
const equipsDe = (rackId) => db.prepare(
  `SELECT e.*, COALESCE(t.tem_portas, 0) AS tem_portas,
          (SELECT COUNT(*) FROM portas p WHERE p.equipamento_id = e.id) AS portas_total
   FROM equipamentos e LEFT JOIN tipos_equipamento t ON t.id = e.tipo_id
   WHERE e.rack_id = ? ORDER BY e.u_inicio DESC`
).all(rackId);

const topo = (e) => e.u_inicio + e.altura_u - 1;
const rotuloU = (e) => `U${e.u_inicio}${e.altura_u > 1 ? `-${topo(e)}` : ''}`;

function ocupadas(rackId) {
  const set = new Set();
  for (const e of equipsDe(rackId)) for (let u = e.u_inicio; u <= topo(e); u++) set.add(u);
  return set;
}

function faixasLivres(rack) {
  const occ = ocupadas(rack.id);
  const faixas = [];
  let ini = null;
  for (let u = 1; u <= rack.altura_u + 1; u++) {
    const livre = u <= rack.altura_u && !occ.has(u);
    if (livre && ini === null) ini = u;
    if (!livre && ini !== null) { faixas.push(ini === u - 1 ? `U${ini}` : `U${ini}-${u - 1}`); ini = null; }
  }
  return faixas.length ? faixas.join(', ') : 'nenhuma';
}

/* ------------------------------------------------------------------- textos */
const RODAPE = '\n\n0 = cancelar';
const menu = () => [
  '*DCIM*', '',
  '1 - Consultar rack',
  '2 - Adicionar equipamento',
  '3 - Cadastrar portas de patch panel',
  '4 - Adicionar foto a um equipamento',
  '', '0 - Sair',
].join('\n');

function listar(titulo, ops) {
  const linhas = ops.slice(0, MAX_LISTA).map((o, i) => `${i + 1} - ${o.label}`);
  if (ops.length > MAX_LISTA) linhas.push(`... e mais ${ops.length - MAX_LISTA}. Digite parte do nome para filtrar.`);
  return `${titulo}\n\n${linhas.join('\n')}${RODAPE}`;
}

// Quebra um texto longo em mensagens de até MAX_MSG caracteres, cortando por linha.
function partir(linhas) {
  const msgs = [];
  let atual = '';
  for (const l of linhas) {
    if (atual && (atual + '\n' + l).length > MAX_MSG) { msgs.push(atual); atual = l; } else atual = atual ? `${atual}\n${l}` : l;
  }
  if (atual) msgs.push(atual);
  return msgs;
}

const dcOps = () => datacenters().map((d) => ({ id: d.id, label: `${d.nome}${d.sigla ? ` (${d.sigla})` : ''}` }));
const rackOps = (dcId) => racksDe(dcId).map((r) => ({
  id: r.id,
  label: `${r.nome}${r.cage ? `, cage ${r.cage}` : ''} (${r.altura_u}U, ${ocupadas(r.id).size}U ocupadas)`,
}));

/* --------------------------------------------------------------- utilitários */
const resp = (textos, ativa = true) => ({ textos: [].concat(textos), ativa });

function voltarMenu(est, aviso) {
  est.passo = 'menu'; est.fluxo = null; est.d = {}; est.ops = []; est.titulo = '';
  return resp([...(aviso ? [].concat(aviso) : []), menu()]);
}

function mostrarLista(est, passo, titulo, ops) {
  est.passo = passo; est.titulo = titulo; est.ops = ops;
  return resp(listar(titulo, ops));
}

// Escolha por número ou por parte do texto do rótulo.
function escolher(est, entrada) {
  const ops = est.ops;
  const n = Number(entrada);
  if (Number.isInteger(n) && n >= 1 && n <= ops.length) return { item: ops[n - 1] };
  const q = norm(entrada);
  if (!q) return { invalido: true };
  const achados = ops.filter((o) => norm(o.label).includes(q));
  if (achados.length === 1) return { item: achados[0] };
  if (achados.length > 1 && achados.length < ops.length) { est.ops = achados; return { refinou: true }; }
  return { invalido: true };
}

/* -------------------------------------------------------------------- fluxos */
function iniciarDc(est) {
  const ops = dcOps();
  if (!ops.length) return voltarMenu(est, 'Nenhum datacenter cadastrado ainda.');
  // Pergunta sempre, mesmo com um só datacenter: o técnico confirma onde está trabalhando.
  return mostrarLista(est, 'dc', 'Qual datacenter?', ops);
}

function iniciarRack(est) {
  const ops = rackOps(est.d.dcId);
  if (!ops.length) return voltarMenu(est, 'Este datacenter ainda não tem racks.');
  if (ops.length === 1) return aposRack(est, ops[0].id);
  return mostrarLista(est, 'rack', 'Qual rack?', ops);
}

async function aposRack(est, rackId) {
  est.d.rackId = rackId;
  const rack = rackPorId(rackId);
  if (est.fluxo === 'consulta') return consultarRack(est, rack);
  if (est.fluxo === 'foto') {
    const eqs = equipsDe(rackId).map((e) => ({ id: e.id, nome: e.nome, label: `${e.nome} (${rotuloU(e)})${e.foto ? ' [tem foto]' : ''}` }));
    if (!eqs.length) return voltarMenu(est, `O rack ${rack.nome} não tem equipamentos.`);
    return mostrarLista(est, 'foto_eq', 'De qual equipamento é a foto?', eqs);
  }
  if (est.fluxo === 'add') {
    est.passo = 'origem';
    return resp(`Rack *${rack.nome}*. O equipamento tem host no Zabbix?\n\n1 - Sim, buscar no Zabbix\n2 - Não, é um item sem host (patch panel, PDU, etc.)${RODAPE}`);
  }
  // portas
  const pps = equipsDe(rackId).filter((e) => e.tem_portas).map((e) => ({ id: e.id, label: `${e.nome} (${e.portas_total} portas)` }));
  if (!pps.length) return voltarMenu(est, `O rack ${rack.nome} não tem itens com portas (patch panel). Cadastre o item na opção 2, escolhendo um tipo com portas.`);
  if (pps.length === 1) return aposPatch(est, pps[0]);
  return mostrarLista(est, 'pp', 'Qual patch panel?', pps);
}

// Consulta: manda a imagem do bayface (igual à da tela web); se não for possível gerar, cai para a lista em texto.
async function consultarRack(est, rack) {
  let png = null;
  try { png = (await imagemDoRack(rack.id))?.png; } catch (err) { console.error('Bot/imagem do rack:', err.message); }
  if (!png) return voltarMenu(est, textoRack(rack));
  const usadas = ocupadas(rack.id).size;
  const legenda = `${rack.nome}${rack.cage ? `, cage ${rack.cage}` : ''}: ${rack.altura_u}U, ${usadas}U ocupadas, ${rack.altura_u - usadas}U livres.\nU livres: ${faixasLivres(rack)}`;
  return voltarMenu(est, [{ imagem: png.toString('base64'), mimetype: 'image/png', legenda }]);
}

function textoRack(rack) {
  const dc = db.prepare('SELECT * FROM datacenters WHERE id = ?').get(rack.datacenter_id);
  const eqs = equipsDe(rack.id);
  const usadas = ocupadas(rack.id).size;
  const linhas = [
    `*${rack.nome}*${rack.cage ? `, cage ${rack.cage}` : ''}, ${dc ? dc.nome : ''}`,
    `${rack.altura_u}U, ${usadas}U ocupadas, ${rack.altura_u - usadas}U livres`,
    `U livres: ${faixasLivres(rack)}`,
    '',
  ];
  if (!eqs.length) linhas.push('Nenhum equipamento neste rack.');
  for (const e of eqs) {
    const partes = [rotuloU(e), e.nome];
    if (e.ip) partes.push(`(${e.ip})`);
    if (e.tem_portas) partes.push(`[${e.portas_total} portas]`);
    if (!e.full_depth) partes.push(`[só ${e.face}]`);
    else if (e.face === 'traseira') partes.push('[traseira]');
    linhas.push(partes.join(' '));
  }
  return partir(linhas);
}

const promptAltura = (rack) => `Quantas U de altura o equipamento ocupa? (1 a ${rack.altura_u})${RODAPE}`;
const promptUInicio = (rack, altura) =>
  `Em qual U ele começa? (a mais baixa que ocupa)\nU livres: ${faixasLivres(rack)}\nDigite um número de 1 a ${rack.altura_u - altura + 1}.${RODAPE}`;

function aposPatch(est, item) {
  est.d.eqId = item.id;
  est.d.eqNome = item.label.replace(/ \(\d+ portas\)$/, '');
  est.passo = 'porta_id';
  return resp(promptPortaId(est));
}
const promptPortaId = (est) =>
  `Patch panel *${est.d.eqNome}*. Informe o ID da porta (ex.: 12).\nAtalho: ID;destino;observação (ex.: 12;Sala 3;cabo azul).\n\n0 = terminar`;

function salvarPorta(est, tec, portaId, destino, obs) {
  const id = txt(portaId, 30);
  if (!id) return resp(`O ID da porta não pode ficar vazio.\n\n${promptPortaId(est)}`);
  const dest = txt(destino || '', 200) || null;
  const ob = txt(obs || '', 500) || null;
  try {
    db.prepare('INSERT INTO portas (equipamento_id, porta_id, destino, observacao) VALUES (?, ?, ?, ?)').run(est.d.eqId, id, dest, ob);
  } catch (err) {
    if (err.errcode === SQLITE_CONSTRAINT_UNIQUE) {
      est.passo = 'porta_id';
      return resp(`A porta ${id} já existe neste patch panel. Informe outro ID (para corrigir uma porta existente, use o Bayface).\n\n${promptPortaId(est)}`);
    }
    throw err;
  }
  registrarAuditoria({ quem: tec.nome, acao: 'porta cadastrada', detalhe: `${est.d.eqNome}: porta ${id}${dest ? `, destino ${dest}` : ''}` });
  const total = db.prepare('SELECT COUNT(*) AS n FROM portas WHERE equipamento_id = ?').get(est.d.eqId).n;
  est.passo = 'porta_id'; est.d.porta_id = est.d.destino = undefined;
  return resp([`Porta ${id} salva${dest ? ` (destino: ${dest})` : ''}. Total: ${total} ${total === 1 ? 'porta' : 'portas'}.`, promptPortaId(est)]);
}

function resumo(est) {
  const d = est.d;
  const rack = rackPorId(d.rackId);
  const tipo = d.tipo_id ? db.prepare('SELECT nome FROM tipos_equipamento WHERE id = ?').get(d.tipo_id) : null;
  const ate = d.u_inicio + d.altura - 1;
  return [
    'Confirma o cadastro?', '',
    `Equipamento: *${d.nome}*`,
    d.host ? 'Host do Zabbix: sim' : `Tipo: ${tipo ? tipo.nome : 'sem tipo'}`,
    ...(d.host ? [] : [`Modelo: ${d.modelo || '-'}`, `IP: ${d.ip || '-'}`, `Observação: ${d.observacao || '-'}`]),
    `Rack: ${rack.nome}, ${d.altura}U (U${d.u_inicio}${d.altura > 1 ? ` a U${ate}` : ''})`,
    `Face: ${d.face}, ${d.full_depth ? 'profundidade inteira' : 'meia profundidade'}`,
    '', 'Responda *sim* ou *não*.',
  ].join('\n');
}

function gravarEquipamento(est, tec) {
  const d = est.d;
  const rack = rackPorId(d.rackId);
  const body = {
    rack_id: d.rackId, hostid: d.host ? d.host.hostid : null, nome: d.nome, u_inicio: d.u_inicio, altura_u: d.altura,
    face: d.face, full_depth: d.full_depth, tipo_id: d.tipo_id || null, ip: d.ip || null, modelo: d.modelo || null, observacao: d.observacao || null,
  };
  const v = validarEquipamento(body);
  if (v.erro) {
    est.passo = 'altura';
    return resp([`Não foi possível gravar: ${v.erro}.`, `Vamos refazer a posição.\n\n${promptAltura(rack)}`]);
  }
  const criado = inserirEquipamento(v.dados);
  registrarAuditoria({
    quem: tec.nome, acao: 'equipamento adicionado',
    detalhe: `${d.nome} no rack ${rack.nome}, U${d.u_inicio}${d.altura > 1 ? `-${d.u_inicio + d.altura - 1}` : ''}`,
  });
  const salvo = `Equipamento *${d.nome}* salvo no rack ${rack.nome} (U${d.u_inicio}${d.altura > 1 ? ` a U${d.u_inicio + d.altura - 1}` : ''}).`;
  est.fluxo = null; est.ops = [];
  est.d = { fotoEqId: criado.id, fotoEqNome: d.nome, aposCadastro: true };
  est.passo = 'foto';
  return resp([salvo, 'Quer anexar uma foto dele agora? Envie a imagem ou responda - para pular.']);
}

/* ------------------------------------------------------------- máquina de passos */
const ESCOLHAS = {
  dc: (est, item) => { est.d.dcId = item.id; return iniciarRack(est); },
  rack: (est, item) => aposRack(est, item.id),
  pp: (est, item) => aposPatch(est, item),
  host_pick: (est, item) => {
    est.d.host = { hostid: item.id, name: item.name };
    est.d.nome = item.name;
    est.passo = 'altura';
    return resp(promptAltura(rackPorId(est.d.rackId)));
  },
  foto_eq: (est, item) => {
    est.d.fotoEqId = item.id; est.d.fotoEqNome = item.nome; est.d.aposCadastro = false;
    est.passo = 'foto';
    return resp(`Envie agora a foto do equipamento *${item.nome}*.${RODAPE}`);
  },
  sh_tipo: (est, item) => {
    est.d.tipo_id = item.id;
    est.passo = 'sh_modelo';
    return resp(`Modelo do equipamento? (- para pular)${RODAPE}`);
  },
};

async function avancar(est, entrada, tec, media) {
  if (est.passo === 'menu') {
    if (media) return resp(`Não estou esperando uma foto agora.\n\n${menu()}`);
    if (entrada === '0') return resp('Até logo!', false);
    const fluxo = { 1: 'consulta', 2: 'add', 3: 'portas', 4: 'foto' }[entrada];
    if (!fluxo) return resp(`Opção inválida.\n\n${menu()}`);
    est.fluxo = fluxo; est.d = {};
    return iniciarDc(est);
  }

  if (media && est.passo !== 'foto') return resp('Não estou esperando uma foto agora. Responda ao que foi perguntado, ou 0 para cancelar.');

  if (entrada === '0') {
    return voltarMenu(est, est.passo === 'porta_id' ? 'Cadastro de portas encerrado.' : 'Cancelado.');
  }

  if (ESCOLHAS[est.passo]) {
    const r = escolher(est, entrada);
    if (r.item) return ESCOLHAS[est.passo](est, r.item);
    return resp(r.refinou ? listar(est.titulo, est.ops) : `Não entendi. Digite o número da opção.\n\n${listar(est.titulo, est.ops)}`);
  }

  const rack = est.d.rackId ? rackPorId(est.d.rackId) : null;
  const pular = entrada === '-';

  switch (est.passo) {
    case 'origem':
      if (entrada === '1') { est.passo = 'host_busca'; return resp(`Digite parte do nome do host no Zabbix.${RODAPE}`); }
      if (entrada === '2') { est.passo = 'sh_nome'; return resp(`Qual o nome do equipamento? (ex.: PP-01)${RODAPE}`); }
      return resp('Responda 1 (host do Zabbix) ou 2 (item sem host).');

    case 'host_busca': {
      let hosts;
      try { hosts = await zabbix.getHosts({ search: entrada, limit: 40 }); }
      catch (err) {
        console.error('Bot/Zabbix:', err.message);
        est.passo = 'origem';
        return resp('Não consegui consultar o Zabbix agora. Responda 2 para cadastrar como item sem host, ou 0 para cancelar.');
      }
      const usados = new Set(db.prepare('SELECT hostid FROM equipamentos WHERE hostid IS NOT NULL').all().map((r) => r.hostid));
      const livres = hosts.filter((h) => !usados.has(h.hostid));
      if (!livres.length) {
        return resp(hosts.length
          ? 'Esses hosts já estão todos posicionados em racks. Tente outro nome ou 0 para cancelar.'
          : 'Nenhum host encontrado com esse nome. Tente outro termo ou 0 para cancelar.');
      }
      const ops = livres.map((h) => {
        const ip = (h.interfaces || []).find((i) => i.main === '1')?.ip || h.interfaces?.[0]?.ip || '';
        return { id: h.hostid, name: h.name, label: `${h.name}${ip ? ` (${ip})` : ''}` };
      });
      return mostrarLista(est, 'host_pick', 'Qual host?', ops);
    }

    case 'sh_nome': {
      const nome = txt(entrada, 100);
      if (!nome) return resp('Informe um nome.');
      est.d.nome = nome;
      const tipos = db.prepare('SELECT id, nome FROM tipos_equipamento ORDER BY nome').all().map((t) => ({ id: t.id, label: t.nome }));
      if (!tipos.length) { est.d.tipo_id = null; est.passo = 'sh_modelo'; return resp(`Modelo do equipamento? (- para pular)${RODAPE}`); }
      return mostrarLista(est, 'sh_tipo', 'Qual o tipo?', [...tipos, { id: null, label: 'Sem tipo' }]);
    }

    case 'sh_modelo':
      est.d.modelo = pular ? null : txt(entrada, 120) || null;
      est.passo = 'sh_ip';
      return resp(`IP do equipamento? (- para pular)${RODAPE}`);

    case 'sh_ip':
      if (!pular && !net.isIP(entrada.trim())) return resp('IP inválido. Digite um IPv4/IPv6 válido ou - para pular.');
      est.d.ip = pular ? null : entrada.trim();
      est.passo = 'sh_obs';
      return resp(`Observação? (- para pular)${RODAPE}`);

    case 'sh_obs':
      est.d.observacao = pular ? null : txt(entrada, 500) || null;
      est.passo = 'altura';
      return resp(promptAltura(rack));

    case 'altura': {
      const n = Number(entrada);
      if (!Number.isInteger(n) || n < 1 || n > rack.altura_u) return resp(`Digite um número inteiro de 1 a ${rack.altura_u}.`);
      est.d.altura = n; est.passo = 'u_inicio';
      return resp(promptUInicio(rack, n));
    }

    case 'u_inicio': {
      const n = Number(entrada);
      const max = rack.altura_u - est.d.altura + 1;
      if (!Number.isInteger(n) || n < 1 || n > max) return resp(`Digite um número inteiro de 1 a ${max}.`);
      est.d.u_inicio = n; est.passo = 'face';
      return resp(`Em qual face fica o equipamento?\n\n1 - Frente\n2 - Traseira${RODAPE}`);
    }

    case 'face':
      if (entrada !== '1' && entrada !== '2') return resp('Responda 1 (frente) ou 2 (traseira).');
      est.d.face = entrada === '1' ? 'frente' : 'traseira'; est.passo = 'prof';
      return resp(`Ele ocupa a profundidade inteira do rack?\n\n1 - Sim (aparece na frente e na traseira)\n2 - Não, só na ${est.d.face}${RODAPE}`);

    case 'prof':
      if (entrada !== '1' && entrada !== '2') return resp('Responda 1 (profundidade inteira) ou 2 (meia profundidade).');
      est.d.full_depth = entrada === '1'; est.passo = 'confirma';
      return resp(resumo(est));

    case 'confirma': {
      const r = norm(entrada);
      if (['sim', 's'].includes(r)) return gravarEquipamento(est, tec);
      if (['nao', 'n'].includes(r)) return voltarMenu(est, 'Cadastro cancelado.');
      return resp('Responda *sim* para gravar ou *não* para cancelar.');
    }

    case 'foto': {
      if (media) {
        const r = fotos.salvarFoto(est.d.fotoEqId, Buffer.from(String(media.base64 || ''), 'base64'));
        if (r.erro) return resp(`Não consegui salvar a foto: ${r.erro}. Envie outra imagem, ou 0 para cancelar.`);
        registrarAuditoria({ quem: tec.nome, acao: 'foto anexada', detalhe: est.d.fotoEqNome });
        return voltarMenu(est, `Foto de *${est.d.fotoEqNome}* salva.`);
      }
      if (entrada === '-' || ['nao', 'n'].includes(norm(entrada))) return voltarMenu(est, est.d.aposCadastro ? 'Ok, ficou sem foto.' : 'Cancelado.');
      return resp('Envie a foto como imagem. Responda - para pular ou 0 para cancelar.');
    }

    case 'porta_id': {
      if (entrada.includes(';')) {
        const [id, dest, obs] = entrada.split(';').map((p) => p.trim());
        return salvarPorta(est, tec, id, dest, obs);
      }
      est.d.porta_id = entrada.trim(); est.passo = 'porta_destino';
      return resp(`Destino da porta ${est.d.porta_id}? (- para pular)${RODAPE}`);
    }

    case 'porta_destino':
      est.d.destino = pular ? '' : entrada; est.passo = 'porta_obs';
      return resp(`Observação da porta ${est.d.porta_id}? (- para pular)${RODAPE}`);

    case 'porta_obs':
      return salvarPorta(est, tec, est.d.porta_id, est.d.destino, pular ? '' : entrada);

    default:
      return voltarMenu(est, 'Algo saiu do esperado. Vamos recomeçar.');
  }
}

/* ------------------------------------------------------------------- entrada */
async function processar({ chave, tecnico, body, media }) {
  const entrada = String(body || '').trim();
  const inicia = /^\/dcim\b/i.test(entrada);

  let est = carregar(chave);
  const expirou = !!(est && est.expirada);
  if (expirou) est = null;

  if (inicia) {
    est = novoEstado();
    const primeiro = tecnico.nome.split(/\s+/)[0];
    salvar(chave, est);
    return { respostas: [`Olá, ${primeiro}!\n\n${menu()}`], ativa: true, aguardaFoto: false };
  }
  if (!est) {
    // Mensagem comum de um técnico sem conversa ativa: só avisa se a sessão acabou de expirar.
    return expirou ? { respostas: ['Sessão encerrada por inatividade. Envie /dcim para recomeçar.'], ativa: false } : null;
  }
  if (!entrada && !media) return { respostas: [], ativa: true };

  const r = await avancar(est, entrada, tecnico, media);
  if (r.ativa) salvar(chave, est); else apagar(chave);
  return {
    respostas: r.textos.flatMap((t) => (Array.isArray(t) ? t : [t])),
    ativa: r.ativa,
    aguardaFoto: r.ativa && est.passo === 'foto', // a ponte só encaminha imagens quando isto é true
  };
}

module.exports = { processar };

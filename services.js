const net = require('net');
const db = require('./db');

const isPosInt = (v) => Number.isInteger(v) && v > 0;
const txt = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Número de telefone -> chave de comparação. No Brasil o WhatsApp às vezes omite o 9 do celular
// (5516XXXXXXXX em vez de 55169XXXXXXXX); a chave remove esse 9 para os dois formatos casarem.
function chaveTelefone(raw) {
  const d = String(raw || '').split('@')[0].replace(/\D/g, '');
  if (d.startsWith('55') && d.length === 13 && d[4] === '9') return d.slice(0, 4) + d.slice(5);
  return d;
}

// full_depth = 1: ocupa a U nas duas faces do rack; 0: só na face indicada.
// Dois equipamentos conflitam se compartilham alguma U e (algum é full_depth ou estão na mesma face).
// Itens com host (hostid) não guardam tipo/ip/modelo/observação: esses dados vêm do Zabbix.
function validarEquipamento(b, ignoreId) {
  const rack = isPosInt(b.rack_id) ? db.prepare('SELECT * FROM racks WHERE id = ?').get(b.rack_id) : null;
  if (!rack) return { erro: 'rack inválido' };
  const nome = txt(b.nome, 100);
  if (!nome) return { erro: 'nome é obrigatório' };
  if (!isPosInt(b.u_inicio)) return { erro: 'u_inicio deve ser inteiro > 0' };
  if (!isPosInt(b.altura_u)) return { erro: 'altura_u deve ser inteiro > 0' };
  if (!['frente', 'traseira'].includes(b.face)) return { erro: 'face deve ser frente ou traseira' };

  const topo = b.u_inicio + b.altura_u - 1;
  if (topo > rack.altura_u) return { erro: `não cabe: o rack ${rack.nome} tem ${rack.altura_u}U` };

  const fullDepth = b.full_depth === 0 || b.full_depth === false ? 0 : 1;
  const outros = db.prepare('SELECT * FROM equipamentos WHERE rack_id = ? AND id <> ?').all(rack.id, ignoreId || 0);
  const choque = outros.find((o) => {
    const oTopo = o.u_inicio + o.altura_u - 1;
    const sobrepoe = b.u_inicio <= oTopo && o.u_inicio <= topo;
    return sobrepoe && (fullDepth || o.full_depth || o.face === b.face);
  });
  if (choque) return { erro: `conflita com ${choque.nome} (U${choque.u_inicio} a U${choque.u_inicio + choque.altura_u - 1})` };

  const hostid = b.hostid ? String(b.hostid) : null;
  let tipo_id = null, ip = null, modelo = null, observacao = null;
  if (hostid) {
    const dup = db.prepare(
      'SELECT e.nome, r.nome AS rack_nome FROM equipamentos e JOIN racks r ON r.id = e.rack_id WHERE e.hostid = ? AND e.id <> ?'
    ).get(hostid, ignoreId || 0);
    if (dup) return { erro: `esse host já está no rack ${dup.rack_nome} (${dup.nome})`, status: 409 };
  } else {
    let tipo = null;
    if (b.tipo_id !== undefined && b.tipo_id !== null && b.tipo_id !== '') {
      tipo = isPosInt(b.tipo_id) ? db.prepare('SELECT * FROM tipos_equipamento WHERE id = ?').get(b.tipo_id) : null;
      if (!tipo) return { erro: 'tipo inválido' };
      tipo_id = tipo.id;
    }
    ip = txt(b.ip, 45) || null;
    if (ip && !net.isIP(ip)) return { erro: 'IP inválido' };
    modelo = txt(b.modelo, 120) || null;
    observacao = txt(b.observacao, 500) || null;
    if (ignoreId && !(tipo && tipo.tem_portas)) {
      const n = db.prepare('SELECT COUNT(*) AS n FROM portas WHERE equipamento_id = ?').get(ignoreId).n;
      if (n) return { erro: `este item tem ${n} portas cadastradas; remova-as antes de mudar para um tipo sem portas`, status: 409 };
    }
  }
  return { dados: { rack_id: rack.id, hostid, nome, u_inicio: b.u_inicio, altura_u: b.altura_u, face: b.face, full_depth: fullDepth, tipo_id, ip, modelo, observacao } };
}

const COLS = 'rack_id, hostid, nome, u_inicio, altura_u, face, full_depth, tipo_id, ip, modelo, observacao';
const valoresEquip = (d) => [d.rack_id, d.hostid, d.nome, d.u_inicio, d.altura_u, d.face, d.full_depth, d.tipo_id, d.ip, d.modelo, d.observacao];


function inserirEquipamento(d) {
  const r = db.prepare(`INSERT INTO equipamentos (${COLS}) VALUES (${COLS.split(',').map(() => '?').join(', ')})`).run(...valoresEquip(d));
  return db.prepare('SELECT * FROM equipamentos WHERE id = ?').get(r.lastInsertRowid);
}

function registrarAuditoria({ origem = 'whatsapp', quem, acao, detalhe }) {
  db.prepare('INSERT INTO auditoria (origem, quem, acao, detalhe) VALUES (?, ?, ?, ?)').run(origem, quem || null, acao, detalhe || null);
}

module.exports = { isPosInt, txt, chaveTelefone, validarEquipamento, COLS, valoresEquip, inserirEquipamento, registrarAuditoria };

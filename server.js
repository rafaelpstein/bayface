require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');
const zabbix = require('./zabbix');
const bot = require('./bot');
const fotos = require('./fotos');
const { imagemDoRack } = require('./rackimg');
const { isPosInt, txt, chaveTelefone, validarEquipamento, COLS, valoresEquip, inserirEquipamento } = require('./services');

const app = express();
app.use(express.json({ limit: '12mb' })); // o bot recebe fotos em base64
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
const bad = (res, msg) => res.status(400).json({ erro: msg });
const notFound = (res) => res.status(404).json({ erro: 'não encontrado' });
const conflito = (res, msg) => res.status(409).json({ erro: msg });

// node:sqlite expõe o código estendido do SQLite em err.errcode
const SQLITE_CONSTRAINT_UNIQUE = 2067;
const SQLITE_CONSTRAINT_FOREIGNKEY = 787;

function handleDbError(res, err, msgUnico = 'já existe registro com esse nome') {
  if (err.errcode === SQLITE_CONSTRAINT_UNIQUE) return conflito(res, msgUnico);
  if (err.errcode === SQLITE_CONSTRAINT_FOREIGNKEY) return bad(res, 'referência inválida');
  console.error(err);
  return res.status(500).json({ erro: 'erro interno' });
}

// ---------- datacenters ----------
function validarDatacenter(b, ignoreId) {
  const nome = txt(b.nome, 100);
  if (!nome) return { erro: 'nome é obrigatório' };
  const sigla = txt(b.sigla, 10).toUpperCase();
  if (!/^[A-Z0-9]{3}$/.test(sigla)) return { erro: 'a sigla deve ter 3 caracteres (letras ou números)' };
  const pais = txt(b.pais, 10).toUpperCase();
  if (!/^[A-Z]{2}$/.test(pais)) return { erro: 'o país deve ter 2 letras (ex.: BR)' };
  const uf = txt(b.uf, 10).toUpperCase();
  if (!/^[A-Z]{2}$/.test(uf)) return { erro: 'a UF deve ter 2 letras (ex.: SP)' };
  const municipio = txt(b.municipio, 10).toUpperCase();
  if (!/^[A-Z]{3}$/.test(municipio)) return { erro: 'o município deve ter 3 letras (ex.: RPO)' };
  const dup = db.prepare('SELECT nome FROM datacenters WHERE sigla = ? AND id <> ?').get(sigla, ignoreId || 0);
  if (dup) return { erro: `a sigla ${sigla} já está em uso por ${dup.nome}`, status: 409 };
  return { dados: { nome, sigla, pais, uf, municipio, localizacao: txt(b.localizacao, 200) || null } };
}

app.get('/api/datacenters', (req, res) => {
  res.json(db.prepare('SELECT * FROM datacenters ORDER BY nome').all());
});

app.post('/api/datacenters', (req, res) => {
  const v = validarDatacenter(req.body);
  if (v.erro) return res.status(v.status || 400).json({ erro: v.erro });
  const d = v.dados;
  try {
    const r = db.prepare('INSERT INTO datacenters (nome, localizacao, sigla, pais, uf, municipio) VALUES (?, ?, ?, ?, ?, ?)')
      .run(d.nome, d.localizacao, d.sigla, d.pais, d.uf, d.municipio);
    res.status(201).json(db.prepare('SELECT * FROM datacenters WHERE id = ?').get(r.lastInsertRowid));
  } catch (err) { handleDbError(res, err); }
});

app.put('/api/datacenters/:id', (req, res) => {
  const atual = db.prepare('SELECT id FROM datacenters WHERE id = ?').get(req.params.id);
  if (!atual) return notFound(res);
  const v = validarDatacenter(req.body, atual.id);
  if (v.erro) return res.status(v.status || 400).json({ erro: v.erro });
  const d = v.dados;
  try {
    db.prepare('UPDATE datacenters SET nome = ?, localizacao = ?, sigla = ?, pais = ?, uf = ?, municipio = ? WHERE id = ?')
      .run(d.nome, d.localizacao, d.sigla, d.pais, d.uf, d.municipio, atual.id);
    res.json(db.prepare('SELECT * FROM datacenters WHERE id = ?').get(atual.id));
  } catch (err) { handleDbError(res, err); }
});

app.delete('/api/datacenters/:id', (req, res) => {
  fotos.apagarFotosDoDatacenter(req.params.id);
  const r = db.prepare('DELETE FROM datacenters WHERE id = ?').run(req.params.id);
  if (!r.changes) return notFound(res);
  res.status(204).end();
});

// ---------- racks ----------
app.get('/api/racks', (req, res) => {
  const { datacenter_id } = req.query;
  const rows = datacenter_id
    ? db.prepare('SELECT * FROM racks WHERE datacenter_id = ? ORDER BY cage, nome').all(datacenter_id)
    : db.prepare('SELECT * FROM racks ORDER BY datacenter_id, cage, nome').all();
  res.json(rows);
});

app.post('/api/racks', (req, res) => {
  const { datacenter_id, nome, cage = null, altura_u } = req.body;
  if (!isPosInt(datacenter_id)) return bad(res, 'datacenter_id inválido');
  if (!nome || !nome.trim()) return bad(res, 'nome é obrigatório');
  if (!isPosInt(altura_u)) return bad(res, 'altura_u deve ser inteiro > 0');
  try {
    const r = db.prepare('INSERT INTO racks (datacenter_id, nome, cage, altura_u) VALUES (?, ?, ?, ?)')
      .run(datacenter_id, nome.trim(), cage, altura_u);
    res.status(201).json(db.prepare('SELECT * FROM racks WHERE id = ?').get(r.lastInsertRowid));
  } catch (err) { handleDbError(res, err); }
});

app.put('/api/racks/:id', (req, res) => {
  const { datacenter_id, nome, cage = null, altura_u } = req.body;
  if (!isPosInt(datacenter_id)) return bad(res, 'datacenter_id inválido');
  if (!nome || !nome.trim()) return bad(res, 'nome é obrigatório');
  if (!isPosInt(altura_u)) return bad(res, 'altura_u deve ser inteiro > 0');

  // não permite reduzir a altura abaixo do que já está ocupado
  const maxU = db.prepare('SELECT MAX(u_inicio + altura_u - 1) AS m FROM equipamentos WHERE rack_id = ?').get(req.params.id).m;
  if (maxU && altura_u < maxU) return bad(res, `há equipamentos até a U${maxU}; altura mínima: ${maxU}`);

  try {
    const r = db.prepare('UPDATE racks SET datacenter_id = ?, nome = ?, cage = ?, altura_u = ? WHERE id = ?')
      .run(datacenter_id, nome.trim(), cage, altura_u, req.params.id);
    if (!r.changes) return notFound(res);
    res.json(db.prepare('SELECT * FROM racks WHERE id = ?').get(req.params.id));
  } catch (err) { handleDbError(res, err); }
});

app.delete('/api/racks/:id', (req, res) => {
  fotos.apagarFotosDoRack(req.params.id);
  const r = db.prepare('DELETE FROM racks WHERE id = ?').run(req.params.id);
  if (!r.changes) return notFound(res);
  res.status(204).end();
});

// ---------- tipos de equipamento ----------
app.get('/api/tipos', (req, res) => {
  res.json(db.prepare('SELECT * FROM tipos_equipamento ORDER BY nome').all());
});

app.post('/api/tipos', (req, res) => {
  const nome = txt(req.body.nome, 60);
  if (!nome) return bad(res, 'nome é obrigatório');
  try {
    const r = db.prepare('INSERT INTO tipos_equipamento (nome, tem_portas) VALUES (?, ?)').run(nome, req.body.tem_portas ? 1 : 0);
    res.status(201).json(db.prepare('SELECT * FROM tipos_equipamento WHERE id = ?').get(r.lastInsertRowid));
  } catch (err) { handleDbError(res, err, 'já existe um tipo com esse nome'); }
});

app.put('/api/tipos/:id', (req, res) => {
  const tipo = db.prepare('SELECT * FROM tipos_equipamento WHERE id = ?').get(req.params.id);
  if (!tipo) return notFound(res);
  const nome = txt(req.body.nome, 60);
  if (!nome) return bad(res, 'nome é obrigatório');
  const temPortas = req.body.tem_portas ? 1 : 0;
  if (tipo.tem_portas && !temPortas) {
    const n = db.prepare(
      'SELECT COUNT(*) AS n FROM portas p JOIN equipamentos e ON e.id = p.equipamento_id WHERE e.tipo_id = ?'
    ).get(tipo.id).n;
    if (n) return conflito(res, `há ${n} portas cadastradas em itens deste tipo; remova-as antes de desmarcar "tem portas"`);
  }
  try {
    db.prepare('UPDATE tipos_equipamento SET nome = ?, tem_portas = ? WHERE id = ?').run(nome, temPortas, tipo.id);
    res.json(db.prepare('SELECT * FROM tipos_equipamento WHERE id = ?').get(tipo.id));
  } catch (err) { handleDbError(res, err, 'já existe um tipo com esse nome'); }
});

app.delete('/api/tipos/:id', (req, res) => {
  const n = db.prepare('SELECT COUNT(*) AS n FROM equipamentos WHERE tipo_id = ?').get(req.params.id).n;
  if (n) return conflito(res, `${n} item(ns) nos racks usam este tipo`);
  const r = db.prepare('DELETE FROM tipos_equipamento WHERE id = ?').run(req.params.id);
  if (!r.changes) return notFound(res);
  res.status(204).end();
});

// ---------- equipamentos ----------
const EQUIP_SELECT = `
  SELECT e.*, r.nome AS rack_nome, r.datacenter_id,
         t.nome AS tipo_nome, COALESCE(t.tem_portas, 0) AS tem_portas,
         (SELECT COUNT(*) FROM portas p WHERE p.equipamento_id = e.id) AS portas_total,
         (SELECT COUNT(*) FROM portas p WHERE p.equipamento_id = e.id AND TRIM(COALESCE(p.destino, '')) <> '') AS portas_com_destino
  FROM equipamentos e
  JOIN racks r ON r.id = e.rack_id
  LEFT JOIN tipos_equipamento t ON t.id = e.tipo_id`;

app.get('/api/equipamentos', (req, res) => {
  const rows = req.query.rack_id
    ? db.prepare(`${EQUIP_SELECT} WHERE e.rack_id = ? ORDER BY e.u_inicio`).all(req.query.rack_id)
    : db.prepare(`${EQUIP_SELECT} ORDER BY e.rack_id, e.u_inicio`).all();
  res.json(rows);
});

app.post('/api/equipamentos', (req, res) => {
  const v = validarEquipamento(req.body);
  if (v.erro) return res.status(v.status || 400).json({ erro: v.erro });
  try {
    res.status(201).json(inserirEquipamento(v.dados));
  } catch (err) { handleDbError(res, err); }
});

app.put('/api/equipamentos/:id', (req, res) => {
  const atual = db.prepare('SELECT id FROM equipamentos WHERE id = ?').get(req.params.id);
  if (!atual) return notFound(res);
  const v = validarEquipamento(req.body, atual.id);
  if (v.erro) return res.status(v.status || 400).json({ erro: v.erro });
  try {
    const sets = COLS.split(',').map((c) => `${c.trim()} = ?`).join(', ');
    db.prepare(`UPDATE equipamentos SET ${sets} WHERE id = ?`).run(...valoresEquip(v.dados), atual.id);
    res.json(db.prepare('SELECT * FROM equipamentos WHERE id = ?').get(atual.id));
  } catch (err) { handleDbError(res, err); }
});

app.delete('/api/equipamentos/:id', (req, res) => {
  fotos.removerFoto(req.params.id);
  const r = db.prepare('DELETE FROM equipamentos WHERE id = ?').run(req.params.id);
  if (!r.changes) return notFound(res);
  res.status(204).end();
});

// ---------- foto do equipamento ----------
app.get('/api/equipamentos/:id/foto', (req, res) => {
  const e = db.prepare('SELECT foto FROM equipamentos WHERE id = ?').get(req.params.id);
  if (!e || !e.foto) return notFound(res);
  res.set('Cache-Control', 'private, max-age=86400'); // o nome do arquivo muda a cada foto nova
  res.sendFile(fotos.caminho(e.foto));
});

app.put('/api/equipamentos/:id/foto', express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '8mb' }), (req, res) => {
  if (!db.prepare('SELECT id FROM equipamentos WHERE id = ?').get(req.params.id)) return notFound(res);
  if (!Buffer.isBuffer(req.body)) return res.status(415).json({ erro: 'envie a imagem como JPEG, PNG ou WebP' });
  const r = fotos.salvarFoto(req.params.id, req.body);
  if (r.erro) return bad(res, r.erro);
  res.json({ foto: r.nome });
});

app.delete('/api/equipamentos/:id/foto', (req, res) => {
  if (!fotos.removerFoto(req.params.id)) return notFound(res);
  res.status(204).end();
});

// ---------- imagem do rack (a mesma usada pelo bot do WhatsApp) ----------
app.get('/api/racks/:id/imagem.png', async (req, res) => {
  try {
    const r = await imagemDoRack(req.params.id);
    if (!r) return notFound(res);
    res.set('Content-Disposition', `inline; filename="bayface-${r.rack.nome.replace(/[^\w.-]+/g, '_')}.png"`);
    res.type('png').send(r.png);
  } catch (err) {
    console.error('Imagem do rack:', err);
    res.status(500).json({ erro: 'não foi possível gerar a imagem' });
  }
});

// ---------- portas do patch panel ----------
function dadosPorta(b) {
  const porta_id = txt(b.porta_id, 30);
  if (!porta_id) return { erro: 'informe o ID da porta' };
  return { dados: { porta_id, destino: txt(b.destino, 200) || null, observacao: txt(b.observacao, 500) || null } };
}

app.get('/api/equipamentos/:id/portas', (req, res) => {
  res.json(db.prepare('SELECT * FROM portas WHERE equipamento_id = ? ORDER BY id').all(req.params.id));
});

app.post('/api/equipamentos/:id/portas', (req, res) => {
  const e = db.prepare(
    'SELECT e.id, COALESCE(t.tem_portas, 0) AS tem_portas FROM equipamentos e LEFT JOIN tipos_equipamento t ON t.id = e.tipo_id WHERE e.id = ?'
  ).get(req.params.id);
  if (!e) return notFound(res);
  if (!e.tem_portas) return bad(res, 'este item não é de um tipo com portas (ex.: patch panel)');
  const v = dadosPorta(req.body);
  if (v.erro) return bad(res, v.erro);
  const d = v.dados;
  try {
    const r = db.prepare('INSERT INTO portas (equipamento_id, porta_id, destino, observacao) VALUES (?, ?, ?, ?)')
      .run(e.id, d.porta_id, d.destino, d.observacao);
    res.status(201).json(db.prepare('SELECT * FROM portas WHERE id = ?').get(r.lastInsertRowid));
  } catch (err) { handleDbError(res, err, `já existe a porta ${d.porta_id} neste patch panel`); }
});

app.put('/api/portas/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM portas WHERE id = ?').get(req.params.id);
  if (!p) return notFound(res);
  const v = dadosPorta(req.body);
  if (v.erro) return bad(res, v.erro);
  const d = v.dados;
  try {
    db.prepare('UPDATE portas SET porta_id = ?, destino = ?, observacao = ? WHERE id = ?').run(d.porta_id, d.destino, d.observacao, p.id);
    res.json(db.prepare('SELECT * FROM portas WHERE id = ?').get(p.id));
  } catch (err) { handleDbError(res, err, `já existe a porta ${d.porta_id} neste patch panel`); }
});

app.delete('/api/portas/:id', (req, res) => {
  const r = db.prepare('DELETE FROM portas WHERE id = ?').run(req.params.id);
  if (!r.changes) return notFound(res);
  res.status(204).end();
});

// ---------- técnicos autorizados (WhatsApp) ----------
function dadosTecnico(b) {
  const nome = txt(b.nome, 80);
  if (!nome) return { erro: 'nome é obrigatório' };
  const telefone = String(b.telefone || '').replace(/\D/g, '');
  if (telefone.length < 10 || telefone.length > 15) return { erro: 'informe o número com DDI e DDD, ex.: 5516999999999' };
  return { dados: { nome, telefone, chave: chaveTelefone(telefone), ativo: b.ativo === false || b.ativo === 0 ? 0 : 1 } };
}

app.get('/api/tecnicos', (req, res) => {
  res.json(db.prepare('SELECT * FROM tecnicos ORDER BY nome').all());
});

app.post('/api/tecnicos', (req, res) => {
  const v = dadosTecnico(req.body);
  if (v.erro) return bad(res, v.erro);
  const d = v.dados;
  try {
    const r = db.prepare('INSERT INTO tecnicos (nome, telefone, chave, ativo) VALUES (?, ?, ?, ?)').run(d.nome, d.telefone, d.chave, d.ativo);
    res.status(201).json(db.prepare('SELECT * FROM tecnicos WHERE id = ?').get(r.lastInsertRowid));
  } catch (err) { handleDbError(res, err, 'esse número já está cadastrado'); }
});

app.put('/api/tecnicos/:id', (req, res) => {
  const v = dadosTecnico(req.body);
  if (v.erro) return bad(res, v.erro);
  const d = v.dados;
  try {
    const r = db.prepare('UPDATE tecnicos SET nome = ?, telefone = ?, chave = ?, ativo = ? WHERE id = ?').run(d.nome, d.telefone, d.chave, d.ativo, req.params.id);
    if (!r.changes) return notFound(res);
    db.prepare('DELETE FROM bot_sessoes WHERE chave = ?').run(d.chave);
    res.json(db.prepare('SELECT * FROM tecnicos WHERE id = ?').get(req.params.id));
  } catch (err) { handleDbError(res, err, 'esse número já está cadastrado'); }
});

app.delete('/api/tecnicos/:id', (req, res) => {
  const t = db.prepare('SELECT chave FROM tecnicos WHERE id = ?').get(req.params.id);
  if (!t) return notFound(res);
  db.prepare('DELETE FROM tecnicos WHERE id = ?').run(req.params.id);
  db.prepare('DELETE FROM bot_sessoes WHERE chave = ?').run(t.chave);
  res.status(204).end();
});

app.get('/api/auditoria', (req, res) => {
  const limite = Math.min(Number(req.query.limit) || 30, 200);
  res.json(db.prepare('SELECT * FROM auditoria ORDER BY id DESC LIMIT ?').all(limite));
});

// ---------- bot do WhatsApp ----------
// O script do WPPConnect encaminha as mensagens para cá. Números fora da lista de técnicos
// recebem 204 sem corpo: o script não responde nada (a mensagem é ignorada).
const BOT_TOKEN = process.env.BOT_TOKEN || '';

function tokenValido(req) {
  const h = req.headers.authorization || '';
  const enviado = Buffer.from(h.startsWith('Bearer ') ? h.slice(7) : '');
  const esperado = Buffer.from(BOT_TOKEN);
  return enviado.length === esperado.length && crypto.timingSafeEqual(enviado, esperado);
}

app.get('/api/bot/status', (req, res) => {
  res.json({ configurado: !!BOT_TOKEN });
});

app.post('/api/bot/mensagem', async (req, res) => {
  if (!BOT_TOKEN) return res.status(503).json({ erro: 'BOT_TOKEN não configurado' });
  if (!tokenValido(req)) return res.status(401).json({ erro: 'token inválido' });

  const from = String(req.body.from || '');
  if (!from || from.includes('@g.us') || from.includes('@broadcast')) return res.status(204).end();
  const chave = chaveTelefone(from);
  const tecnico = db.prepare('SELECT * FROM tecnicos WHERE chave = ? AND ativo = 1').get(chave);
  if (!tecnico) return res.status(204).end();

  try {
    const out = await bot.processar({ chave, tecnico, body: String(req.body.body || ''), media: req.body.media || null });
    if (!out) return res.status(204).end();
    res.json(out);
  } catch (err) {
    console.error('Bot:', err);
    res.json({ respostas: ['Ocorreu um erro no DCIM. Envie /dcim para recomeçar.'], ativa: false });
  }
});

// ---------- zabbix ----------
function erroZabbix(res, err) {
  console.error('Zabbix:', err.message);
  res.status(502).json({ erro: `falha ao consultar o Zabbix: ${err.message}` });
}

app.get('/api/zabbix/hosts', async (req, res) => {
  try {
    const hostids = req.query.hostids
      ? String(req.query.hostids).split(',').filter((id) => /^\d+$/.test(id))
      : undefined;
    res.json(await zabbix.getHosts({ search: req.query.search, groupid: req.query.groupid, hostids }));
  } catch (err) { erroZabbix(res, err); }
});

app.get('/api/zabbix/hostgroups', async (req, res) => {
  try { res.json(await zabbix.getHostGroups()); } catch (err) { erroZabbix(res, err); }
});

app.get('/api/zabbix/resumo', async (req, res) => {
  try { res.json({ total: await zabbix.getHostCount() }); } catch (err) { erroZabbix(res, err); }
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`DCIM rodando em http://localhost:${PORT}`));
}
module.exports = app;

const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'dcim.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS datacenters (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nome        TEXT NOT NULL UNIQUE,
  localizacao TEXT,
  sigla       TEXT,   -- 3 caracteres
  pais        TEXT,   -- 2 letras (BR)
  uf          TEXT,   -- 2 letras (SP)
  municipio   TEXT    -- 3 letras (RPO)
);

CREATE TABLE IF NOT EXISTS racks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  datacenter_id  INTEGER NOT NULL REFERENCES datacenters(id) ON DELETE CASCADE,
  nome           TEXT NOT NULL,
  cage           TEXT,
  altura_u       INTEGER NOT NULL CHECK (altura_u > 0),
  UNIQUE (datacenter_id, nome)
);

-- Tipos de itens sem host (patch panel, PDU, organizador...). tem_portas = 1 habilita o cadastro de portas.
CREATE TABLE IF NOT EXISTS tipos_equipamento (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  nome       TEXT NOT NULL UNIQUE,
  tem_portas INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS equipamentos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  rack_id    INTEGER NOT NULL REFERENCES racks(id) ON DELETE CASCADE,
  hostid     TEXT,                       -- hostid do Zabbix (vazio em itens sem host)
  nome       TEXT NOT NULL,
  u_inicio   INTEGER NOT NULL CHECK (u_inicio > 0),
  altura_u   INTEGER NOT NULL CHECK (altura_u > 0),
  face       TEXT NOT NULL DEFAULT 'frente' CHECK (face IN ('frente', 'traseira')),
  full_depth INTEGER NOT NULL DEFAULT 1, -- 1 = ocupa frente e traseira; 0 = só a face indicada
  tipo_id    INTEGER REFERENCES tipos_equipamento(id),
  ip         TEXT,
  modelo     TEXT,
  observacao TEXT
);

-- Técnicos autorizados a usar o bot do WhatsApp. "chave" é o número normalizado (ver services.chaveTelefone).
CREATE TABLE IF NOT EXISTS tecnicos (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  nome     TEXT NOT NULL,
  telefone TEXT NOT NULL,
  chave    TEXT NOT NULL UNIQUE,
  ativo    INTEGER NOT NULL DEFAULT 1
);

-- Estado da conversa de cada técnico no WhatsApp
CREATE TABLE IF NOT EXISTS bot_sessoes (
  chave         TEXT PRIMARY KEY,
  estado        TEXT NOT NULL,
  atualizado_em INTEGER NOT NULL
);

-- Registro de quem alterou o quê pelo WhatsApp
CREATE TABLE IF NOT EXISTS auditoria (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  quando  TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  origem  TEXT NOT NULL,
  quem    TEXT,
  acao    TEXT NOT NULL,
  detalhe TEXT
);

CREATE TABLE IF NOT EXISTS portas (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  equipamento_id INTEGER NOT NULL REFERENCES equipamentos(id) ON DELETE CASCADE,
  porta_id       TEXT NOT NULL,
  destino        TEXT,
  observacao     TEXT,
  UNIQUE (equipamento_id, porta_id)
);
`);

// Migração de bancos criados em versões anteriores
function addColumn(table, col, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}
addColumn('datacenters', 'sigla', 'TEXT');
addColumn('datacenters', 'pais', 'TEXT');
addColumn('datacenters', 'uf', 'TEXT');
addColumn('datacenters', 'municipio', 'TEXT');
addColumn('equipamentos', 'full_depth', 'INTEGER NOT NULL DEFAULT 1');
addColumn('equipamentos', 'tipo_id', 'INTEGER REFERENCES tipos_equipamento(id)');
addColumn('equipamentos', 'ip', 'TEXT');
addColumn('equipamentos', 'modelo', 'TEXT');
addColumn('equipamentos', 'observacao', 'TEXT');
addColumn('equipamentos', 'foto', 'TEXT'); // nome do arquivo em ./uploads

// Um host do Zabbix só pode estar em um lugar; a sigla identifica o datacenter
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_equip_hostid ON equipamentos(hostid) WHERE hostid IS NOT NULL');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_dc_sigla ON datacenters(sigla) WHERE sigla IS NOT NULL');

// Tipos iniciais (editáveis pela tela)
if (db.prepare('SELECT COUNT(*) AS n FROM tipos_equipamento').get().n === 0) {
  const ins = db.prepare('INSERT INTO tipos_equipamento (nome, tem_portas) VALUES (?, ?)');
  ins.run('Patch panel', 1);
  ins.run('Organizador de cabos', 0);
  ins.run('PDU', 0);
  ins.run('Bandeja', 0);
}

module.exports = db;

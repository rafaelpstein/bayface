'use strict';
// Foto do equipamento: uma por equipamento, guardada em ./uploads (a nova substitui a anterior).
const fs = require('fs');
const path = require('path');
const db = require('./db');

const DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(DIR, { recursive: true });
const MAX_BYTES = 8 * 1024 * 1024;

function tipoImagem(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg' };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png' };
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return { ext: 'webp' };
  return null;
}

const caminho = (nome) => path.join(DIR, path.basename(nome));
function apagarArquivo(nome) { try { fs.unlinkSync(caminho(nome)); } catch { /* já não existe */ } }

// Valida pelo conteúdo (não pelo que o cliente diz ser) e grava. Devolve { nome } ou { erro }.
function salvarFoto(equipId, buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return { erro: 'imagem vazia' };
  if (buf.length > MAX_BYTES) return { erro: 'a imagem passa de 8 MB' };
  const tipo = tipoImagem(buf);
  if (!tipo) return { erro: 'formato não suportado (use JPEG, PNG ou WebP)' };
  const anterior = db.prepare('SELECT foto FROM equipamentos WHERE id = ?').get(equipId);
  if (!anterior) return { erro: 'equipamento não encontrado' };
  const nome = `equip-${equipId}-${Date.now()}.${tipo.ext}`;
  fs.writeFileSync(caminho(nome), buf);
  db.prepare('UPDATE equipamentos SET foto = ? WHERE id = ?').run(nome, equipId);
  if (anterior.foto) apagarArquivo(anterior.foto);
  return { nome };
}

function removerFoto(equipId) {
  const e = db.prepare('SELECT foto FROM equipamentos WHERE id = ?').get(equipId);
  if (!e || !e.foto) return false;
  db.prepare('UPDATE equipamentos SET foto = NULL WHERE id = ?').run(equipId);
  apagarArquivo(e.foto);
  return true;
}

// Apaga os arquivos das fotos que serão perdidas por uma exclusão em cascata (rack ou datacenter).
function apagarFotosDoRack(rackId) {
  for (const r of db.prepare('SELECT foto FROM equipamentos WHERE rack_id = ? AND foto IS NOT NULL').all(rackId)) apagarArquivo(r.foto);
}
function apagarFotosDoDatacenter(dcId) {
  for (const r of db.prepare(
    'SELECT e.foto FROM equipamentos e JOIN racks r ON r.id = e.rack_id WHERE r.datacenter_id = ? AND e.foto IS NOT NULL'
  ).all(dcId)) apagarArquivo(r.foto);
}

module.exports = { salvarFoto, removerFoto, caminho, apagarArquivo, apagarFotosDoRack, apagarFotosDoDatacenter };

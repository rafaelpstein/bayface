'use strict';
// Ponte entre o seu script do WPPConnect e o Bayface (DCIM).
// Copie este arquivo para a pasta do script do WhatsApp e siga o LEIA-ME.md.
//
// Só mensagens que começam com /dcim, ou de quem já está numa conversa do DCIM, são enviadas ao Bayface.
// Fotos só são encaminhadas quando o Bayface está esperando uma foto daquele técnico.
// O Bayface só responde a números cadastrados como técnicos; de qualquer outro número ele não devolve
// nada e esta ponte também não responde (a mensagem é ignorada).

const http = require('http');
const https = require('https');
const { URL } = require('url');

const DCIM_URL = process.env.DCIM_URL || 'http://IP-DO-BAYFACE:3000';       // endereço do Bayface
const DCIM_TOKEN = process.env.DCIM_TOKEN || 'COLE-AQUI-O-BOT_TOKEN-DO-BAYFACE'; // igual ao BOT_TOKEN do .env do Bayface
const TTL_MS = 10 * 60 * 1000; // igual ao tempo de sessão do Bayface

const ativos = new Map(); // chat (message.from) -> { ts: última mensagem da conversa, foto: o Bayface espera uma foto? }
const cacheTelefone = new Map(); // LID -> telefone (@c.us)

// O WhatsApp identifica muitos contatos por um LID (123...@lid) em vez do telefone. O Bayface autoriza por telefone,
// então convertemos o LID no número real. As respostas continuam indo para o chat original (message.from).
function paraTexto(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return v._serialized || (v.user ? String(v.user) : paraTexto(v.id));
  return '';
}

async function telefoneReal(client, from) {
  if (!String(from).endsWith('@lid')) return from;
  if (cacheTelefone.has(from)) return cacheTelefone.get(from);
  try {
    const entrada = await client.page.evaluate((id) => WPP.contact.getPnLidEntry(id), from);
    const digitos = paraTexto(entrada && entrada.phoneNumber).split('@')[0].replace(/\D/g, '');
    if (digitos.length >= 10 && digitos.length <= 15) {
      const tel = `${digitos}@c.us`;
      cacheTelefone.set(from, tel);
      return tel;
    }
  } catch (err) {
    console.error('DCIM: não consegui converter o LID em telefone:', err && err.message ? err.message : err);
  }
  return from; // sem conversão: o Bayface tenta pelo próprio ID (técnico cadastrado com os dígitos do LID)
}

function postJson(urlStr, body, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const data = JSON.stringify(body);
    const req = lib.request({
      hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method: 'POST', timeout: 30000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Authorization: `Bearer ${token}` },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function enviarImagem(client, para, item) {
  const mime = item.mimetype || 'image/png';
  try {
    await client.sendImageFromBase64(para, `data:${mime};base64,${item.imagem}`, 'bayface.png', item.legenda || '');
  } catch (err) {
    console.error('DCIM: falha ao enviar a imagem:', err && err.message ? err.message : err);
    if (item.legenda) await client.sendText(para, item.legenda);
  }
}

// Devolve true se a mensagem foi tratada pelo DCIM (o resto do seu script deve ignorá-la).
async function tratarDcim(client, message) {
  if (message.isGroupMsg) return false;

  const conversa = ativos.get(message.from);
  const emConversa = !!conversa && Date.now() - conversa.ts < TTL_MS;
  let payload;

  if (message.type === 'image') {
    // foto: só interessa se o Bayface pediu uma foto a este número
    if (!emConversa || !conversa.foto) return false;
    try {
      const buf = await client.decryptFile(message);
      payload = { from: await telefoneReal(client, message.from), body: '', media: { mimetype: message.mimetype || 'image/jpeg', base64: buf.toString('base64') } };
    } catch (err) {
      console.error('DCIM: não consegui baixar a foto:', err && err.message ? err.message : err);
      return true;
    }
  } else {
    if (typeof message.body !== 'string') return false;
    if (message.type && message.type !== 'chat') return false; // ignora áudios, vídeos, documentos etc.
    const texto = message.body.trim();
    const inicia = /^\/dcim\b/i.test(texto);
    if (!inicia && !emConversa) return false;
    payload = { from: await telefoneReal(client, message.from), body: texto };
  }

  try {
    const r = await postJson(`${DCIM_URL}/api/bot/mensagem`, payload, DCIM_TOKEN);
    if (r.status === 204) { ativos.delete(message.from); return true; } // número não autorizado: ignora
    if (r.status !== 200) {
      console.error('DCIM respondeu', r.status, r.body);
      ativos.delete(message.from);
      return true;
    }
    const out = JSON.parse(r.body);
    if (out.ativa) ativos.set(message.from, { ts: Date.now(), foto: !!out.aguardaFoto }); else ativos.delete(message.from);
    for (const item of out.respostas || []) {
      if (typeof item === 'string') await client.sendText(message.from, item);
      else if (item && item.imagem) await enviarImagem(client, message.from, item);
    }
  } catch (err) {
    console.error('DCIM indisponível:', err.message);
  }
  return true;
}

module.exports = { tratarDcim };

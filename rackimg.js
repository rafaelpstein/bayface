'use strict';
// Desenha o bayface (frente e traseira lado a lado) como imagem PNG, no mesmo estilo da tela web.
// Gera um SVG e converte com o resvg (WebAssembly: não depende de bibliotecas nativas do sistema).

const fs = require('fs');
const path = require('path');

const U = 26;          // altura de 1U
const BAY_W = 304;     // largura do miolo (com as tiras de furos)
const EAR = 12;        // orelha do equipamento / tira de furos
const NUM_W = 22;      // coluna de numeração
const PAD_X = 6, PAD_Y = 10;
const GAP = 40, MARGIN = 24;
const FACE_W = PAD_X * 2 + NUM_W * 2 + BAY_W;

const COR = { concreto: '#D8DCE0', ink: '#1C2228', ink2: '#56606A', aco: '#252B31', trilho: '#39414A', vao: '#14181C' };
const LED = { up: '#2F9E5C', down: '#D23B3B', off: '#6A737C', unknown: '#D9DDE1' };
const F_SANS = "'IBM Plex Sans', 'IBM Plex Sans SemiBold', sans-serif";
const F_COND = "'IBM Plex Sans Condensed', 'IBM Plex Sans Condensed SemiBold', sans-serif";

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const cortar = (t, maxPx, pxChar) => {
  t = String(t || '');
  const max = Math.max(0, Math.floor(maxPx / pxChar));
  return t.length <= max ? t : max > 1 ? t.slice(0, max - 1) + '…' : '';
};

// 'up' | 'down' | 'off' | 'unknown' | null, a partir do host do Zabbix (mesma regra da tela web)
function estadoHost(h) {
  if (!h) return null;
  if (h.status === '1') return 'off';
  const i = (h.interfaces || []).find((x) => x.main === '1') || (h.interfaces || [])[0];
  if (i?.available === '1') return 'up';
  if (i?.available === '2') return 'down';
  return 'unknown';
}
const ipDoHost = (h) => (h?.interfaces || []).find((x) => x.main === '1')?.ip || h?.interfaces?.[0]?.ip || '';

const topo = (e) => e.u_inicio + e.altura_u - 1;
const rotuloU = (e) => `U${e.u_inicio}${e.altura_u > 1 ? `-${topo(e)}` : ''}`;

function faceSvg(rack, face, equips, hosts, ox, oy) {
  const N = rack.altura_u;
  const bx = ox + PAD_X + NUM_W;   // início do miolo
  const by = oy + PAD_Y;
  const H = PAD_Y * 2 + N * U;
  const o = [];

  o.push(`<rect x="${ox}" y="${oy}" width="${FACE_W}" height="${H}" rx="4" fill="${COR.aco}"/>`);
  // trilhos, vão e linhas de U
  o.push(`<rect x="${bx}" y="${by}" width="${BAY_W}" height="${N * U}" fill="${COR.trilho}"/>`);
  o.push(`<rect x="${bx + EAR}" y="${by}" width="${BAY_W - EAR * 2}" height="${N * U}" fill="${COR.vao}"/>`);
  o.push(`<rect x="${bx}" y="${by}" width="${EAR}" height="${N * U}" fill="url(#furos)"/>`);
  o.push(`<rect x="${bx + BAY_W - EAR}" y="${by}" width="${EAR}" height="${N * U}" fill="url(#furos)"/>`);
  for (let i = 1; i < N; i++) {
    o.push(`<line x1="${bx}" y1="${by + i * U}" x2="${bx + BAY_W}" y2="${by + i * U}" stroke="#fff" stroke-opacity=".07"/>`);
  }
  // numeração (U1 embaixo)
  for (let u = 1; u <= N; u++) {
    const cy = by + (N - u) * U + U / 2 + 3.5;
    o.push(`<text x="${ox + PAD_X + NUM_W / 2}" y="${cy}" font-family="${F_SANS}" font-size="10" fill="#98A2AC" text-anchor="middle">${u}</text>`);
    o.push(`<text x="${bx + BAY_W + NUM_W / 2}" y="${cy}" font-family="${F_SANS}" font-size="10" fill="#98A2AC" text-anchor="middle">${u}</text>`);
  }

  // equipamentos: full_depth aparece nas duas faces; os demais só na sua
  for (const e of equips) {
    if (!(e.face === face || e.full_depth)) continue;
    const tall = e.altura_u >= 2;
    const h = e.altura_u * U;
    const x = bx;
    const y = by + (N - topo(e)) * U;
    const back = e.face !== face;
    const host = e.hostid ? hosts.get(e.hostid) : null;
    const ip = e.hostid ? ipDoHost(host) : e.ip || '';
    const hw = e.hostid ? host?.inventory?.hardware || '' : e.modelo || '';
    const estado = e.hostid ? estadoHost(host) : null;
    const meta = ip || (e.tem_portas ? `${e.portas_total} ${e.portas_total === 1 ? 'porta' : 'portas'}` : rotuloU(e));

    o.push(`<g>`);
    o.push(`<rect x="${x}" y="${y}" width="${BAY_W}" height="${h}" fill="url(#${back ? 'gTras' : 'gFrente'})"/>`);
    o.push(`<line x1="${x}" y1="${y + 0.5}" x2="${x + BAY_W}" y2="${y + 0.5}" stroke="#E5E8EB" stroke-opacity="${back ? '.35' : '1'}"/>`);
    o.push(`<line x1="${x}" y1="${y + h - 0.5}" x2="${x + BAY_W}" y2="${y + h - 0.5}" stroke="#6F7882"/>`);
    // orelhas com um parafuso por U
    o.push(`<rect x="${x}" y="${y}" width="${EAR}" height="${h}" fill="#98A2AC"/><rect x="${x + BAY_W - EAR}" y="${y}" width="${EAR}" height="${h}" fill="#98A2AC"/>`);
    o.push(`<line x1="${x + EAR - 0.5}" y1="${y}" x2="${x + EAR - 0.5}" y2="${y + h}" stroke="#7B858F"/><line x1="${x + BAY_W - EAR + 0.5}" y1="${y}" x2="${x + BAY_W - EAR + 0.5}" y2="${y + h}" stroke="#7B858F"/>`);
    for (let i = 0; i < e.altura_u; i++) {
      const cy = y + i * U + U / 2;
      o.push(`<circle cx="${x + EAR / 2}" cy="${cy}" r="2.3" fill="#59626B"/><circle cx="${x + BAY_W - EAR / 2}" cy="${cy}" r="2.3" fill="#59626B"/>`);
    }
    // aletas de ventilação nos equipamentos com 2U ou mais
    if (tall) {
      const vw = Math.round(BAY_W * 0.22), vx = x + BAY_W - 26 - vw;
      for (let vx2 = vx; vx2 < vx + vw; vx2 += 6) o.push(`<rect x="${vx2}" y="${y + 6}" width="2" height="${h - 12}" fill="#000" fill-opacity=".16"/>`);
    }

    // textos
    const nomeX = x + 36, ipX = x + BAY_W - 20;
    const metaW = meta.length * 6.1;
    const disp = ipX - nomeX - metaW - 10;
    const baseTexto = tall ? y + (h - (hw ? 26 : 13)) / 2 + 11 : y + U / 2 + 4.5;
    const nome = cortar(e.nome, tall ? ipX - nomeX - metaW - 10 : Math.min(disp, Math.max(90, disp - (hw ? 40 : 0))), 7.1);
    if (estado || e.hostid) {
      o.push(`<circle cx="${x + 24}" cy="${baseTexto - 4.5}" r="3.6" fill="${LED[estado] || LED.unknown}" stroke="#000" stroke-opacity=".4"/>`);
    }
    o.push(`<text x="${nomeX}" y="${baseTexto}" font-family="${F_COND}" font-weight="600" font-size="13" fill="${COR.ink}">${esc(nome)}</text>`);
    o.push(`<text x="${ipX}" y="${baseTexto}" font-family="${F_COND}" font-weight="600" font-size="11" fill="#37404A" text-anchor="end">${esc(meta)}</text>`);
    if (hw) {
      if (tall) {
        o.push(`<text x="${nomeX}" y="${baseTexto + 15}" font-family="${F_COND}" font-weight="600" font-size="11" fill="#4A545E">${esc(cortar(hw, ipX - nomeX - 4, 6.0))}</text>`);
      } else {
        const hwX = nomeX + nome.length * 7.1 + 10;
        const hwMax = ipX - metaW - 10 - hwX;
        if (hwMax > 30) o.push(`<text x="${hwX}" y="${baseTexto}" font-family="${F_COND}" font-weight="600" font-size="11" fill="#4A545E">${esc(cortar(hw, hwMax, 6.0))}</text>`);
      }
    }
    o.push(`</g>`);
  }
  return o.join('\n');
}

function rackSvg({ rack, dcNome, equips, hosts }) {
  const N = rack.altura_u;
  const faceH = PAD_Y * 2 + N * U;
  const W = MARGIN * 2 + FACE_W * 2 + GAP;
  const HEAD = 62, TITLE = 30;
  const H = MARGIN + HEAD + TITLE + faceH + MARGIN;
  const usadas = new Set();
  for (const e of equips) for (let u = e.u_inicio; u <= topo(e); u++) usadas.add(u);
  const meta = `${rack.cage ? `Cage ${rack.cage}, ` : ''}${dcNome ? `${dcNome}, ` : ''}${N}U, ${usadas.size}U ocupadas, ${N - usadas.size}U livres`;

  const oy = MARGIN + HEAD + TITLE;
  const x1 = MARGIN, x2 = MARGIN + FACE_W + GAP;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
  <linearGradient id="gFrente" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#CBD1D7"/><stop offset="1" stop-color="#A9B1B9"/></linearGradient>
  <linearGradient id="gTras" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#949DA5"/><stop offset="1" stop-color="#79828B"/></linearGradient>
  <pattern id="furos" width="${EAR}" height="${U}" patternUnits="userSpaceOnUse">
    <rect width="${EAR}" height="${U}" fill="${COR.trilho}"/>
    <g fill="${COR.vao}"><rect x="3" y="3" width="6" height="4" rx="1"/><rect x="3" y="11" width="6" height="4" rx="1"/><rect x="3" y="19" width="6" height="4" rx="1"/></g>
  </pattern>
</defs>
<rect width="${W}" height="${H}" fill="${COR.concreto}"/>
<text x="${MARGIN}" y="${MARGIN + 24}" font-family="${F_SANS}" font-weight="600" font-size="24" fill="${COR.ink}">${esc(rack.nome)}</text>
<text x="${MARGIN}" y="${MARGIN + 48}" font-family="${F_SANS}" font-size="15" fill="${COR.ink2}">${esc(meta)}</text>
<text x="${x1 + FACE_W / 2}" y="${MARGIN + HEAD + 20}" font-family="${F_SANS}" font-weight="600" font-size="16" fill="${COR.ink}" text-anchor="middle">Frente</text>
<text x="${x2 + FACE_W / 2}" y="${MARGIN + HEAD + 20}" font-family="${F_SANS}" font-weight="600" font-size="16" fill="${COR.ink}" text-anchor="middle">Traseira</text>
${faceSvg(rack, 'frente', equips, hosts, x1, oy)}
${faceSvg(rack, 'traseira', equips, hosts, x2, oy)}
</svg>`;
  return { svg, largura: W, altura: H };
}

/* ------------------------------------------------------------------ PNG */
let resvgPronto = null;
async function iniciar() {
  if (!resvgPronto) {
    resvgPronto = (async () => {
      const mod = require('@resvg/resvg-wasm');
      const wasm = fs.readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm'));
      await mod.initWasm(wasm);
      const dir = path.join(__dirname, 'assets', 'fonts');
      const fontes = fs.readdirSync(dir).filter((f) => f.endsWith('.ttf')).map((f) => new Uint8Array(fs.readFileSync(path.join(dir, f))));
      return { Resvg: mod.Resvg, fontes };
    })();
  }
  return resvgPronto;
}

// dados: { rack, dcNome, equips: [equipamentos com tem_portas/portas_total], hosts: Map(hostid -> host do Zabbix) }
async function rackPng(dados) {
  const { Resvg, fontes } = await iniciar();
  const { svg, altura } = rackSvg({ ...dados, hosts: dados.hosts || new Map() });
  const zoom = Math.max(1, Math.min(2, 1700 / altura)); // imagem final com no máximo ~1700 px de altura
  const r = new Resvg(svg, {
    fitTo: { mode: 'zoom', value: zoom },
    font: { fontBuffers: fontes, loadSystemFonts: false, defaultFontFamily: 'IBM Plex Sans' },
  });
  return Buffer.from(r.render().asPng());
}

// Monta a imagem de um rack a partir do banco e do Zabbix (status, IP e hardware dos hosts).
async function imagemDoRack(rackId) {
  const db = require('./db');
  const zabbix = require('./zabbix');
  const rack = db.prepare('SELECT * FROM racks WHERE id = ?').get(rackId);
  if (!rack) return null;
  const dc = db.prepare('SELECT nome FROM datacenters WHERE id = ?').get(rack.datacenter_id);
  const equips = db.prepare(
    `SELECT e.*, COALESCE(t.tem_portas, 0) AS tem_portas,
            (SELECT COUNT(*) FROM portas p WHERE p.equipamento_id = e.id) AS portas_total
     FROM equipamentos e LEFT JOIN tipos_equipamento t ON t.id = e.tipo_id
     WHERE e.rack_id = ? ORDER BY e.u_inicio`
  ).all(rackId);
  const hosts = new Map();
  const ids = [...new Set(equips.filter((e) => e.hostid).map((e) => e.hostid))];
  if (ids.length) {
    try { for (const h of await zabbix.getHosts({ hostids: ids })) hosts.set(h.hostid, h); }
    catch (err) { console.error('Imagem do rack sem dados do Zabbix:', err.message); }
  }
  return { png: await rackPng({ rack, dcNome: dc ? dc.nome : '', equips, hosts }), rack };
}

module.exports = { rackPng, rackSvg, imagemDoRack };

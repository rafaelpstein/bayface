// Cliente mínimo da API do Zabbix 6.0.x
// - user.login usa o parâmetro "user" (em 6.0; "username" só a partir da 6.4)
// - o token de sessão vai no campo "auth" do corpo (não em header)

const URL_API = process.env.ZABBIX_URL; // ex.: https://zabbix.exemplo.com/api_jsonrpc.php
const USER = process.env.ZABBIX_USER;
const PASSWORD = process.env.ZABBIX_PASSWORD;

let authToken = null;
let reqId = 1;

async function rpc(method, params, auth) {
  if (!URL_API) throw new Error('ZABBIX_URL não configurada');
  const body = { jsonrpc: '2.0', method, params, id: reqId++ };
  if (auth) body.auth = auth;

  const res = await fetch(URL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json-rpc' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Zabbix HTTP ${res.status}`);

  const json = await res.json();
  if (json.error) {
    const e = new Error(`${json.error.message} ${json.error.data || ''}`.trim());
    e.zabbix = json.error;
    throw e;
  }
  return json.result;
}

async function login() {
  authToken = await rpc('user.login', { user: USER, password: PASSWORD });
  return authToken;
}

function sessionExpired(err) {
  const data = err.zabbix && err.zabbix.data ? err.zabbix.data : '';
  return /Session terminated|Not authorised/i.test(data);
}

// Chamada autenticada; refaz o login uma vez se a sessão expirou
async function call(method, params) {
  if (!authToken) await login();
  try {
    return await rpc(method, params, authToken);
  } catch (err) {
    if (sessionExpired(err)) {
      await login();
      return rpc(method, params, authToken);
    }
    throw err;
  }
}

async function getHosts({ search, groupid, hostids, limit = 300 } = {}) {
  const params = {
    output: ['hostid', 'host', 'name', 'status'],
    // "available" (0 desconhecido, 1 disponível, 2 indisponível) fica na interface a partir da 6.0
    selectInterfaces: ['ip', 'type', 'main', 'available'],
    selectGroups: ['groupid', 'name'], // 6.0: selectGroups (selectHostGroups só na 6.2+)
    selectInventory: ['hardware'],     // vem vazio se o inventário do host estiver desativado
    sortfield: 'name',
  };
  if (search) {
    params.search = { name: search, host: search };
    params.searchByAny = true;
  }
  if (groupid) params.groupids = [groupid];
  if (hostids && hostids.length) params.hostids = hostids;
  else params.limit = limit; // consultas por hostids trazem todos os pedidos
  return call('host.get', params);
}

async function getHostCount() {
  return Number(await call('host.get', { countOutput: true }));
}

async function getHostGroups() {
  return call('hostgroup.get', { output: ['groupid', 'name'], sortfield: 'name' });
}

module.exports = { getHosts, getHostGroups, getHostCount };

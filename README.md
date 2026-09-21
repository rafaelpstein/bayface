# Bayface: DCIM + Zabbix

Requer Node.js 22.13 ou superior (usa o `node:sqlite` nativo).

## Instalação e atualização
    npm install
    cp .env.example .env    # preencha ZABBIX_URL, ZABBIX_USER e ZABBIX_PASSWORD
    npm start               # http://localhost:3000

Ao atualizar de uma versão anterior, o banco `dcim.db` existente é migrado sozinho.
Datacenters antigos ficam sem sigla/país/UF/município até serem editados (o formulário exige os quatro campos).

## Telas
- **Dashboard** (tela inicial): datacenters, racks, equipamentos, hosts do Zabbix sem rack, datacenters com mais
  espaço livre (% das U), racks mais cheios, ocupação geral, status dos hosts posicionados e resumo de patch panels.
- **Racks**: cadastro de datacenters e racks, bayface (frente e traseira lado a lado) e lista de hosts do Zabbix.

## Fotos e imagem do rack
- Cada equipamento pode ter uma foto (a nova substitui a anterior): pelo WhatsApp (opção 4, ou logo após cadastrar) ou pela
  tela, ao clicar no equipamento. Os arquivos ficam na pasta `uploads/`, que deve entrar no seu backup junto com `dcim.db`.
- `GET /api/racks/:id/imagem.png` gera a imagem do bayface (é a mesma que o bot envia); na tela, botão "Baixar imagem".
- As fontes usadas na imagem ficam em `assets/fonts`. O desenho é feito em WebAssembly, sem dependências nativas.

## Regras
- Datacenter: sigla (3 caracteres, única), país (2 letras), UF (2 letras) e município (3 letras).
- Equipamentos com "profundidade inteira" aparecem na frente e na traseira; os de meia profundidade ocupam só a face escolhida.
- Hosts do Zabbix mostram IP e hardware (campo hardware do inventário; habilite o inventário nos hosts).
- Itens sem host: tipo (tabela editável em "Gerenciar tipos"), modelo, IP opcional e observação.
- Tipos com "tem portas" (ex.: Patch panel) permitem cadastrar portas uma a uma: ID, destino e observação.

## WhatsApp (WPPConnect)
Técnicos cadastrados na aba **WhatsApp** usam o comando `/dcim` para consultar racks (o bot responde com a imagem do bayface,
frente e traseira), adicionar equipamentos, cadastrar portas de patch panel e anexar fotos de equipamentos. Números fora da lista são ignorados em silêncio; cada alteração fica registrada.
Configure `BOT_TOKEN` no `.env` e siga `wpp/LEIA-ME.md` para ligar o script do WPPConnect.

## API
- /api/datacenters, /api/racks, /api/tipos, /api/equipamentos (GET, POST, PUT /:id, DELETE /:id)
- /api/equipamentos/:id/portas (GET, POST), /api/portas/:id (PUT, DELETE)
- /api/tecnicos, /api/auditoria, POST /api/bot/mensagem (usada pelo script do WPPConnect, exige BOT_TOKEN)
- /api/equipamentos/:id/foto (GET, PUT, DELETE), GET /api/racks/:id/imagem.png
- GET /api/zabbix/hosts (?search=&groupid=&hostids=1,2), /api/zabbix/hostgroups, /api/zabbix/resumo

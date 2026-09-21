# Integração do WhatsApp (WPPConnect) com o Bayface

## 1. No Bayface
No arquivo `.env`, defina um token secreto (use algo longo e aleatório) e reinicie:

    BOT_TOKEN=troque-por-um-token-longo

Depois, na aba **WhatsApp**, cadastre os técnicos (número com DDI e DDD, ex.: 5516999999999).
Números que não estiverem na lista são ignorados em silêncio.

## 2. No servidor do WPPConnect
1. Copie `dcim-bridge.js` para a pasta do seu script.
2. Defina o endereço e o token (variáveis de ambiente ou edite as duas constantes no topo do arquivo):

       DCIM_URL=http://IP-DO-BAYFACE:3000
       DCIM_TOKEN=o-mesmo-BOT_TOKEN

3. No seu script, faça duas mudanças:

       const { tratarDcim } = require('./dcim-bridge');
       ...
       client.onMessage(async (message) => {          // acrescente "async"
         if (await tratarDcim(client, message)) return; // nova linha
         ... (o resto do seu código continua igual)

4. Reinicie o script. Do WhatsApp de um técnico cadastrado, envie `/dcim`.

## Atualizando o dcim-bridge.js
Ao receber uma versão nova do Bayface, substitua também o `dcim-bridge.js` do servidor do WPPConnect pela nova
(ele passou a enviar a imagem do rack e a receber fotos) e reinicie o script. O restante do seu script não muda.

## Contatos identificados por LID
Quando o WhatsApp entrega o contato como `123...@lid` em vez do telefone, o `dcim-bridge.js` converte o LID no número
real (via `getPnLidEntry`) antes de consultar o Bayface. Cadastre os técnicos pelo **telefone** (com DDI e DDD).
Se a conversão falhar, o erro aparece no console do script e o Bayface tenta o próprio ID.

## Observações
- O token trafega em HTTP puro entre os servidores. Se passar por rede não confiável, use HTTPS (proxy reverso) ou VPN.
- Se o Bayface estiver fora do ar, o script só registra o erro no console e não responde nada ao técnico.
- Fotos só são aceitas quando o bot pediu uma (opção 4 ou logo após cadastrar um equipamento); imagens fora disso são ignoradas.
- Conversas expiram após 10 minutos sem mensagens.

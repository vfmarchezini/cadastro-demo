require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const twilio = require('twilio');
const { WebSocketServer } = require('ws');
const OpenAI = require('openai');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const SMS_FROM = process.env.SMS_FROM || '';
const WHATSAPP_FROM = process.env.WHATSAPP_FROM || '';
const TTS_PROVIDER = process.env.TTS_PROVIDER || 'ElevenLabs';
const TTS_VOICE = process.env.TTS_VOICE || 'KHmfNHtEjHhLK9eER20w-flash_v2_5';
const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Sofia';
const BRAND_NAME = process.env.BRAND_NAME || 'Vox';
const PARTICIPANTES_FILE = process.env.PARTICIPANTES_FILE || path.join(__dirname, 'participantes.json');

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const openai = new OpenAI();

// -----------------------------------------------------------------------------
// Mock backend — o que o CRM/Salesforce faria em produção
// Base de participantes carregada de PARTICIPANTES_FILE (JSON).
// Devs podem editar `participantes.json` livremente pra ajustar as personas.
// -----------------------------------------------------------------------------

function carregarParticipantes() {
  try {
    const raw = fs.readFileSync(PARTICIPANTES_FILE, 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) throw new Error('esperado um array');
    const map = new Map();
    for (const p of arr) {
      if (!p.documento) continue;
      map.set(String(p.documento), p);
    }
    console.log(`  [crm] ${map.size} participante(s) carregado(s) de ${PARTICIPANTES_FILE}`);
    return map;
  } catch (e) {
    console.warn(`  [crm] falha ao carregar ${PARTICIPANTES_FILE}: ${e.message} — iniciando com base vazia`);
    return new Map();
  }
}

const PARTICIPANTES = carregarParticipantes();

function normalizeDoc(input) {
  return String(input || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

function buscarParticipante(doc) {
  const key = normalizeDoc(doc);
  const found = PARTICIPANTES.get(key);
  if (found) return { encontrado: true, ...found };
  return { encontrado: false, documento: key };
}

function upsertParticipante(record) {
  const key = normalizeDoc(record.documento);
  const existing = PARTICIPANTES.get(key) || { documento: key, tipo: key.match(/^[A-Z]/) ? 'Passaporte' : 'CPF', ultima_atualizacao: '' };
  const merged = {
    ...existing,
    ...record,
    documento: key,
    ultima_atualizacao: new Date().toISOString().slice(0, 10),
  };
  PARTICIPANTES.set(key, merged);
  return merged;
}

// -----------------------------------------------------------------------------
// Estado da demo — o que apareceria no CRM depois do atendimento
// -----------------------------------------------------------------------------

const cadastrosSalvos = [];        // {documento, nome, ..., canal}
const retornosAgendados = [];      // {documento?, motivo, from, ts}
const linksEnviados = [];          // {token, documento, canal, destino, ts, url, status}
const tokens = new Map();          // token → { documento, criadoPor, criadoEm }
const ativos = new Map();          // callSid → { from, startedAt, turns, ended }
const callBindings = new Map();    // callSid → { session, ws }  (para sync omnichannel)
const sseClients = new Set();
const conversationSidByDoc = new Map();  // documento → Twilio Conversation SID (memory)

function broadcastSSE(event) {
  const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch {}
  }
}

function pushTurn(callSid, role, text) {
  const s = ativos.get(callSid);
  if (!s) return;
  const turn = { role, text, ts: Date.now() };
  s.turns.push(turn);
  broadcastSSE({ type: 'turn', callSid, turn });
}

function newToken() {
  return crypto.randomBytes(6).toString('hex');
}

// -----------------------------------------------------------------------------
// Twilio Conversations — "memory" por participante
// Cada persona vira uma Conversation com atributos = snapshot do cadastro.
// Idempotente por uniqueName (`vox-<documento>`). Falha silenciosa se a
// Conversations API não estiver habilitada na conta.
// -----------------------------------------------------------------------------

function recordToAttributes(record) {
  return JSON.stringify({
    fonte: 'vox-crm',
    documento: record.documento,
    tipo: record.tipo,
    nome: record.nome || '',
    data_nascimento: record.data_nascimento || '',
    telefone: record.telefone || '',
    email: record.email || '',
    endereco: record.endereco || '',
    ultima_atualizacao: record.ultima_atualizacao || '',
  });
}

async function ensureConversation(record) {
  const uniqueName = `vox-${record.documento}`;
  const attributes = recordToAttributes(record);
  try {
    await twilioClient.conversations.v1.conversations(uniqueName).fetch();
    await twilioClient.conversations.v1.conversations(uniqueName).update({ attributes });
    console.log(`  [memory] atualizou ${uniqueName}`);
    return uniqueName;
  } catch (e) {
    if (e.status !== 404 && e.code !== 20404) {
      console.warn(`  [memory] falha ao ler ${uniqueName}: ${e.message}`);
      return null;
    }
    try {
      const c = await twilioClient.conversations.v1.conversations.create({
        uniqueName,
        friendlyName: `${BRAND_NAME} — ${record.nome}`,
        attributes,
      });
      conversationSidByDoc.set(record.documento, c.sid);
      console.log(`  [memory] criou ${uniqueName} · ${c.sid}`);
      return c.sid;
    } catch (err) {
      console.warn(`  [memory] falha ao criar ${uniqueName}: ${err.message}`);
      return null;
    }
  }
}

async function bootstrapConversations() {
  console.log('  [memory] sincronizando personas com Twilio Conversations...');
  for (const p of PARTICIPANTES.values()) {
    await ensureConversation(p);
  }
}

// -----------------------------------------------------------------------------
// Rotas HTTP — dashboard + SSE
// -----------------------------------------------------------------------------

app.get('/', (req, res) => res.sendFile(__dirname + '/public/index.html'));

app.get('/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const snapshot = {
    ativos: Array.from(ativos.entries()).map(([callSid, s]) => ({
      callSid, from: s.from, startedAt: s.startedAt, turns: s.turns, ended: s.ended,
    })),
    cadastrosSalvos,
    retornosAgendados,
    linksEnviados,
  };
  res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
  const keepalive = setInterval(() => res.write(': ping\n\n'), 20000);
  sseClients.add(res);
  req.on('close', () => {
    clearInterval(keepalive);
    sseClients.delete(res);
  });
});

app.get('/api/base', (req, res) => {
  res.json(Array.from(PARTICIPANTES.values()));
});

// -----------------------------------------------------------------------------
// Voz — ConversationRelay
// -----------------------------------------------------------------------------

app.post('/voice/incoming', (req, res) => {
  const wsUrl = PUBLIC_URL.replace(/^https?/, 'wss') + '/relay';
  const twiml = new twilio.twiml.VoiceResponse();
  const connect = twiml.connect();
  connect.conversationRelay({
    url: wsUrl,
    welcomeGreeting:
      `Central ${BRAND_NAME}, bem-vindo. Aqui é a ${ASSISTANT_NAME}, sua assistente virtual. ` +
      'Pra começar, me informe o C P F ou passaporte do titular — ' +
      'pode falar, ou digitar pelo teclado e apertar jogo-da-velha ao terminar.',
    welcomeGreetingInterruptible: 'any',
    voice: TTS_VOICE,
    language: 'pt-BR',
    ttsLanguage: 'pt-BR',
    transcriptionLanguage: 'pt-BR',
    ttsProvider: TTS_PROVIDER,
    transcriptionProvider: 'Google',
    speechModel: 'telephony',
    interruptible: 'any',
    dtmfDetection: 'true',
  });
  res.type('text/xml').send(twiml.toString());
});

// -----------------------------------------------------------------------------
// Web form — canal alternativo, sempre pré-preenchido pela memória do CRM
// -----------------------------------------------------------------------------

app.get('/atualizar/:token', (req, res) => {
  if (!tokens.get(req.params.token)) return res.status(404).send('Link inválido ou expirado.');
  res.sendFile(__dirname + '/public/form.html');
});

app.get('/atualizar/:token/data', (req, res) => {
  const t = tokens.get(req.params.token);
  if (!t) return res.status(404).json({ erro: 'token inválido' });
  const dados = PARTICIPANTES.get(normalizeDoc(t.documento)) || { documento: t.documento };
  res.json({
    token: req.params.token,
    documento: dados.documento,
    nome: dados.nome || '',
    data_nascimento: dados.data_nascimento || '',
    telefone: dados.telefone || '',
    email: dados.email || '',
    endereco: dados.endereco || '',
    ultima_atualizacao: dados.ultima_atualizacao || '',
    origem: t.criadoPor,
  });
});

app.post('/atualizar/:token/data', (req, res) => {
  const t = tokens.get(req.params.token);
  if (!t) return res.status(404).json({ erro: 'token inválido' });
  const before = PARTICIPANTES.get(normalizeDoc(t.documento)) || { documento: t.documento };
  const snapshotAntes = { ...before };
  const merged = upsertParticipante({
    documento: t.documento,
    nome: req.body.nome,
    data_nascimento: req.body.data_nascimento,
    telefone: req.body.telefone,
    email: req.body.email,
    endereco: req.body.endereco,
  });
  const alteracoes = diffCadastro(snapshotAntes, merged);
  const record = {
    ...merged,
    salvo_em: new Date().toISOString(),
    canal: 'web',
    origem_call_sid: t.criadoPor,
    alteracoes,
  };
  cadastrosSalvos.unshift(record);
  broadcastSSE({ type: 'cadastro-salvo', record });
  ensureConversation(merged).catch((err) => console.warn('  [memory] sync web:', err.message));
  tokens.delete(req.params.token); // one-shot

  // Sync omnichannel — se a chamada ainda tá viva, cutuca a Sofia pra comentar
  const bind = callBindings.get(t.criadoPor);
  if (bind && bind.ws.readyState === 1 /* OPEN */) {
    notificarSyncNaChamada(bind.session, bind.ws, alteracoes).catch((err) =>
      console.warn('  [sync] falha:', err.message)
    );
  }

  res.json({ ok: true });
});

const NOMES_HUMANOS = {
  nome: 'nome',
  data_nascimento: 'data de nascimento',
  telefone: 'telefone',
  email: 'e-mail',
  endereco: 'endereço',
};

function diffCadastro(antes, depois) {
  const changes = [];
  for (const campo of Object.keys(NOMES_HUMANOS)) {
    const a = String(antes[campo] || '').trim();
    const b = String(depois[campo] || '').trim();
    if (a !== b) changes.push({ campo, antes: a, depois: b });
  }
  return changes;
}

async function notificarSyncNaChamada(session, ws, alteracoes) {
  const resumo = alteracoes.length
    ? alteracoes
        .map((c) => {
          const label = NOMES_HUMANOS[c.campo] || c.campo;
          if (!c.antes) return `${label} foi preenchido com "${c.depois}"`;
          if (!c.depois) return `${label} foi removido (era "${c.antes}")`;
          return `${label} mudou de "${c.antes}" para "${c.depois}"`;
        })
        .join('; ')
    : 'nenhum campo mudou — o cliente só confirmou os dados';

  const cue =
    `(EVENTO OMNICHANNEL — o cliente ACABOU DE salvar o formulário web agora. ` +
    `Alterações: ${resumo}. ` +
    `Faça exatamente: 1) reconheça naturalmente que você viu a atualização citando 1 ou 2 dos campos mudados ` +
    `(ex.: "Ótimo, vi aqui que você atualizou seu e-mail e telefone."); ` +
    `2) pergunte se ele precisa de mais alguma coisa; ` +
    `3) se ele disser que não, chame encerrar_atendimento. ` +
    `NÃO chame salvar_cadastro — o cliente já salvou pelo link.)`;

  // Se o assistente estiver falando algo, aborta pra ele pegar esse evento
  if (session.speakingController) {
    try { session.speakingController.abort(); } catch {}
    session.speakingController = null;
  }
  session.messages.push({ role: 'user', content: cue });
  console.log(`  [sync] cutucando ${ASSISTANT_NAME} — ${alteracoes.length} campo(s) mudou(aram)`);
  await runAgent(session, ws);
}

// -----------------------------------------------------------------------------
// Prompt e tools
// -----------------------------------------------------------------------------

const SYSTEM_PROMPT = `
Você é a ${ASSISTANT_NAME}, assistente virtual da ${BRAND_NAME}. Seu trabalho é conduzir a JORNADA DE ATUALIZAÇÃO CADASTRAL do participante que ligou.

REGRAS DE ESTILO (voz — vai ser falado):
- Português brasileiro, tom cordial e direto. Você representa a ${BRAND_NAME}.
- Frases CURTAS, uma pergunta por vez. Nunca peça vários dados juntos.
- REGRA ABSOLUTA de números: SEMPRE leia CPF, passaporte, telefone, data de nascimento, CEP e qualquer sequência numérica DÍGITO POR DÍGITO, com pausas de vírgula agrupando de 3 em 3. NUNCA "por extenso" (nunca "trezentos", "mil e vinte e três", etc).
  * CPF 30012345678 → "três, zero, zero, um, dois, três, quatro, cinco, seis, sete, oito"
  * Telefone (11) 96922-2122 → "onze, nove, seis, nove, dois, dois, dois, um, dois, dois"
  * Data 1985-06-12 → "doze de junho de mil novecentos e oitenta e cinco" (data pode ser lida naturalmente)
  * CEP 01310-200 → "zero, um, três, um, zero, dois, zero, zero"

FLUXO OBRIGATÓRIO:

1) Peça o CPF ou passaporte do titular. Só um. Confirme repetindo antes de buscar.
   Chame \`buscar_participante\`.

2) Se \`encontrado: false\`:
   - Diga: "Não localizei esse documento na nossa base. Vou registrar seu contato para que a central te retorne no horário de atendimento."
   - Chame \`agendar_retorno\` com motivo "documento não cadastrado".
   - Se despeça e chame \`encerrar_atendimento\`.

3) Se \`encontrado: true\`:
   a) Confirme o titular ("Falo com <nome>?"). Se negar, \`agendar_retorno\` motivo "titular não confirmado" e encerre.
   b) IMPORTANTE — Ofereça 3 opções pra continuar, de forma CURTA:
      "Perfeito. Prefere atualizar aqui comigo por voz, ou receber um link por SMS ou WhatsApp pra preencher no celular?"
   c) Se ele escolher SMS ou WhatsApp:
      - Verifique o campo \`telefone\` que veio em \`buscar_participante\`.
        - Se JÁ tem telefone no cadastro: confirme lendo o número SEM o código +55 (só o DDD e o número, dígito a dígito devagar). Ex: "(11) 96922-2122" vira "onze, nove seis nove dois dois, dois um dois dois. É esse mesmo número?"
          - Se ele confirmar, chame \`enviar_link_sms\` OU \`enviar_link_whatsapp\` SEM o parâmetro \`telefone\` (o sistema usa o do cadastro).
          - Se ele disser que é outro, peça com DDD e passe como \`telefone\`.
        - Se NÃO tem telefone no cadastro: peça com DDD e passe como \`telefone\`.
      - Nunca chame os dois canais na mesma ligação.
      - Depois de enviar, avise: "Enviei o link. Você pode preencher agora mesmo se quiser — eu fico aqui na linha e confirmo assim que entrar. Se preferir desligar, a atualização entra automaticamente."
      - NÃO chame \`encerrar_atendimento\` agora — fique aguardando. Se receber um EVENTO OMNICHANNEL avisando que o cliente salvou pelo web, comente as mudanças, pergunte se precisa de mais alguma coisa e SÓ AÍ encerre.
   d) Se ele escolher voz (ou disser "posso fazer aqui mesmo"):
      - Colete os dados UM POR UM, nesta ordem:
        i) Data de nascimento (confirme).
        ii) Nome completo (só reconfirme se soar diferente).
        iii) Endereço completo (rua, número, bairro, cidade, estado).
        iv) Telefone com DDD.
        v) E-mail (peça pra soletrar; leia de volta letra por letra pra confirmar).
      - Se em qualquer momento ele disser que não tem em mãos ou sem tempo, ofereça o LINK como alternativa antes de agendar retorno.
      - Depois de coletar tudo, leia um resumo curto: "Pra confirmar: <resumo>. Está correto?"
      - Se sim: chame \`salvar_cadastro\`, agradeça, \`encerrar_atendimento\`.
      - Se ele quiser corrigir, corrija só o campo apontado, releia, pergunte de novo.

4) Nunca invente dados. Se não entendeu duas vezes seguidas, ofereça o link SMS/WhatsApp.

5) Você NÃO faz diagnóstico, NÃO oferece produtos, NÃO discute outros assuntos. Se o cliente pedir outra coisa, avise que essa central é só atualização cadastral.
`.trim();

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'buscar_participante',
      description: 'Busca o participante na base pelo CPF ou passaporte.',
      parameters: {
        type: 'object',
        properties: {
          documento: { type: 'string', description: 'CPF ou passaporte como o cliente ditou. O sistema normaliza.' },
        },
        required: ['documento'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'salvar_cadastro',
      description: 'Salva os dados atualizados. Só chame após o cliente confirmar "está correto".',
      parameters: {
        type: 'object',
        properties: {
          documento: { type: 'string' },
          nome: { type: 'string' },
          data_nascimento: { type: 'string', description: 'AAAA-MM-DD' },
          telefone: { type: 'string' },
          email: { type: 'string' },
          endereco: { type: 'string' },
        },
        required: ['documento', 'nome', 'data_nascimento', 'telefone', 'email', 'endereco'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'enviar_link_sms',
      description: 'Envia um link por SMS pro cliente preencher no navegador. Se o cliente confirmar o telefone que já está no cadastro, OMITA `telefone` — o sistema usa o do cadastro. Só passe `telefone` quando o cliente ditar um número diferente.',
      parameters: {
        type: 'object',
        properties: {
          telefone: { type: 'string', description: 'Novo número com DDD, apenas quando o cliente ditar diferente do cadastro.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'enviar_link_whatsapp',
      description: 'Envia um link por WhatsApp pro cliente preencher no navegador. Se o cliente confirmar o telefone que já está no cadastro, OMITA `telefone` — o sistema usa o do cadastro. Só passe `telefone` quando o cliente ditar um número diferente.',
      parameters: {
        type: 'object',
        properties: {
          telefone: { type: 'string', description: 'Novo número com DDD, apenas quando o cliente ditar diferente do cadastro.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'agendar_retorno',
      description: 'Registra que a Central deve retornar o contato do cliente.',
      parameters: {
        type: 'object',
        properties: {
          motivo: { type: 'string' },
          documento: { type: 'string' },
        },
        required: ['motivo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'encerrar_atendimento',
      description: 'Encerra a chamada educadamente ao final do fluxo.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

// -----------------------------------------------------------------------------
// Execução das tools
// -----------------------------------------------------------------------------

function normalizePhone(input) {
  const digits = String(input || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('55')) return '+' + digits;
  if (digits.length >= 10) return '+55' + digits;
  return digits;
}

async function sendMessage({ to, from, body }) {
  return twilioClient.messages.create({ to, from, body });
}

async function callTool(name, args, session) {
  if (name === 'buscar_participante') {
    const result = buscarParticipante(args?.documento || '');
    if (result.encontrado) {
      session.documento = result.documento;
      session.titular = result;
    }
    broadcastSSE({ type: 'tool', callSid: session.callSid, tool: name, args, result });
    return result;
  }

  if (name === 'salvar_cadastro') {
    const merged = upsertParticipante({
      documento: args?.documento || session.documento || '',
      nome: args?.nome || '',
      data_nascimento: args?.data_nascimento || '',
      telefone: args?.telefone || '',
      email: args?.email || '',
      endereco: args?.endereco || '',
    });
    const record = { ...merged, salvo_em: new Date().toISOString(), canal: 'voz', call_sid: session.callSid };
    cadastrosSalvos.unshift(record);
    broadcastSSE({ type: 'cadastro-salvo', record });
    ensureConversation(merged).catch((err) => console.warn('  [memory] sync voz:', err.message));
    session.finalizado = true;
    return { ok: true, mensagem: 'Cadastro atualizado com sucesso.' };
  }

  if (name === 'enviar_link_sms' || name === 'enviar_link_whatsapp') {
    if (!session.documento) return { ok: false, erro: 'Ainda não localizei o cliente.' };
    const canal = name === 'enviar_link_sms' ? 'sms' : 'whatsapp';
    // Prioridade: telefone que o cliente ditou > telefone do cadastro > número que originou a chamada
    const telefoneCadastro = session.titular?.telefone || '';
    const to_bare = normalizePhone(args?.telefone || telefoneCadastro || session.from);
    if (!to_bare) return { ok: false, erro: 'Não consegui interpretar o telefone.' };
    const origem_telefone = args?.telefone ? 'informado' : (telefoneCadastro ? 'cadastro' : 'chamada');

    const token = newToken();
    tokens.set(token, {
      documento: session.documento,
      criadoPor: session.callSid,
      criadoEm: new Date().toISOString(),
    });
    const url = `${PUBLIC_URL}/atualizar/${token}`;
    const nome = session.titular?.nome || 'você';
    const msg = `${BRAND_NAME} — Central de Atendimento\nOlá ${nome.split(' ')[0]}, aqui está o link para atualizar seu cadastro (já vem preenchido com o que temos):\n${url}\n\nO link é pessoal e válido por 24h.`;

    const from = canal === 'sms' ? SMS_FROM : WHATSAPP_FROM;
    const to = canal === 'sms' ? to_bare : `whatsapp:${to_bare}`;
    if (!from) return { ok: false, erro: `${canal.toUpperCase()}_FROM não configurado no .env` };

    const record = {
      token, documento: session.documento, canal, destino: to_bare, url,
      enviado_em: new Date().toISOString(), status: 'pendente', call_sid: session.callSid,
      origem_telefone,
    };
    linksEnviados.unshift(record);

    try {
      const r = await sendMessage({ to, from, body: msg });
      record.status = 'enviado';
      record.sid = r.sid;
      console.log(`  [link] ${canal} → ${to} · sid ${r.sid} · token ${token}`);
    } catch (e) {
      record.status = 'falhou';
      record.erro = e.message;
      console.error(`  [link] ${canal} → ${to} falhou:`, e.message);
    }
    broadcastSSE({ type: 'link-enviado', record });
    return { ok: record.status === 'enviado', canal, destino: to_bare, erro: record.erro };
  }

  if (name === 'agendar_retorno') {
    const record = {
      documento: normalizeDoc(args?.documento || session.documento || ''),
      motivo: args?.motivo || 'não informado',
      from: session.from || '',
      agendado_em: new Date().toISOString(),
      call_sid: session.callSid,
    };
    retornosAgendados.unshift(record);
    broadcastSSE({ type: 'retorno-agendado', record });
    session.finalizado = true;
    return { ok: true };
  }

  if (name === 'encerrar_atendimento') {
    session.encerrar = true;
    return { ok: true };
  }

  return { erro: 'ferramenta desconhecida' };
}

// -----------------------------------------------------------------------------
// HTTP + WebSocket
// -----------------------------------------------------------------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/relay') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws) => {
  const session = {
    callSid: null,
    from: null,
    documento: null,
    titular: null,
    finalizado: false,
    encerrar: false,
    speakingController: null,  // AbortController válido SOMENTE enquanto TTS ativo
    dtmfBuffer: '',
    dtmfTimer: null,
    messages: [{ role: 'system', content: SYSTEM_PROMPT }],
  };

  async function flushDtmf() {
    if (session.dtmfTimer) { clearTimeout(session.dtmfTimer); session.dtmfTimer = null; }
    const num = session.dtmfBuffer;
    session.dtmfBuffer = '';
    if (!num) return;
    const synth = `(o cliente digitou pelo teclado: ${num} — trate como se tivesse ditado esse número)`;
    session.messages.push({ role: 'user', content: synth });
    pushTurn(session.callSid, 'user', `⌨ ${num}`);
    await runAgent(session, ws);
  }

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type !== 'setup') {
      console.log(`  [relay-msg] ${msg.type}${msg.voicePrompt ? ` "${msg.voicePrompt}"` : ''}`);
    }

    if (msg.type === 'setup') {
      session.callSid = msg.callSid;
      session.from = msg.from;
      ativos.set(msg.callSid, {
        from: msg.from,
        startedAt: new Date().toISOString(),
        turns: [],
        ended: false,
      });
      callBindings.set(msg.callSid, { session, ws });
      broadcastSSE({
        type: 'session-start',
        callSid: msg.callSid,
        from: msg.from,
        startedAt: ativos.get(msg.callSid).startedAt,
      });
      console.log(`  [relay] chamada ${msg.callSid} de ${msg.from}`);
      return;
    }

    if (msg.type === 'prompt' && msg.voicePrompt) {
      const userText = msg.voicePrompt;
      session.messages.push({ role: 'user', content: userText });
      pushTurn(session.callSid, 'user', userText);
      await runAgent(session, ws);
      return;
    }

    if (msg.type === 'interrupt') {
      // Só aborta se ela ESTIVER falando no momento. Se speakingController é null,
      // é um interrupt espúrio (respiração, ruído) — ignoramos.
      if (session.speakingController) {
        try { session.speakingController.abort(); } catch {}
        session.speakingController = null;
        console.log(`  [relay] interrupt aplicado`);
      } else {
        console.log(`  [relay] interrupt ignorado (não estava falando)`);
      }
      return;
    }

    if (msg.type === 'dtmf' && msg.digit) {
      const d = msg.digit;
      if (d === '#') {
        // Finaliza entrada
        await flushDtmf();
        return;
      }
      if (d === '*') {
        // Limpa buffer (opção "apagar e recomeçar")
        if (session.dtmfTimer) { clearTimeout(session.dtmfTimer); session.dtmfTimer = null; }
        session.dtmfBuffer = '';
        return;
      }
      session.dtmfBuffer += d;
      if (session.dtmfTimer) clearTimeout(session.dtmfTimer);
      // Timeout de idle: se parar de digitar por 2.5s, submete
      session.dtmfTimer = setTimeout(() => {
        flushDtmf().catch((err) => console.error('  [dtmf] flush:', err.message));
      }, 2500);
      return;
    }

    if (msg.type === 'error') {
      console.error(`  [relay] erro:`, msg.description);
    }
  });

  ws.on('close', () => {
    const s = ativos.get(session.callSid);
    if (s) {
      s.ended = true;
      broadcastSSE({ type: 'session-end', callSid: session.callSid });
      setTimeout(() => ativos.delete(session.callSid), 3 * 60 * 1000);
    }
    callBindings.delete(session.callSid);
    console.log(`  [relay] fim ${session.callSid}`);
  });
});

async function runAgent(session, ws) {
  for (let hop = 0; hop < 6; hop++) {
    const abortController = new AbortController();
    let stream;
    try {
      stream = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        messages: session.messages,
        tools: TOOLS,
        tool_choice: 'auto',
        temperature: 0.3,
        stream: true,
      }, { signal: abortController.signal });
    } catch (e) {
      if (e.name === 'AbortError') return;
      console.error('  [openai] erro:', e.message);
      throw e;
    }

    const toolCalls = [];
    let content = '';
    let buf = '';
    let spokeAnything = false;
    let interrupted = false;

    try {
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta || {};

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const i = tc.index ?? 0;
            if (!toolCalls[i]) toolCalls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
            if (tc.id) toolCalls[i].id = tc.id;
            if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
            if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
          }
        }

        if (delta.content) {
          content += delta.content;
          buf += delta.content;
          const flushIdx = findFlushBoundary(buf);
          if (flushIdx > 0) {
            const piece = buf.slice(0, flushIdx);
            buf = buf.slice(flushIdx);
            streamSpeak(ws, piece, false);
            spokeAnything = true;
            // Só liga o interrupt handler DEPOIS que ela começou a falar
            if (!session.speakingController) session.speakingController = abortController;
          }
        }
      }
    } catch (e) {
      if (e.name === 'AbortError' || abortController.signal.aborted) {
        interrupted = true;
      } else {
        console.error('  [stream] erro:', e.message);
        // Fecha o áudio se aberto pra Relay não travar
        if (spokeAnything) streamSpeak(ws, '', true);
        session.speakingController = null;
        return;
      }
    }

    if (interrupted) {
      // Fecha o áudio pra Relay saber que terminamos, ainda que curto
      if (spokeAnything) streamSpeak(ws, '', true);
      session.speakingController = null;
      return;
    }

    if (toolCalls.length) {
      if (buf.length) {
        streamSpeak(ws, buf, true);
        buf = '';
        spokeAnything = true;
      } else if (spokeAnything) {
        streamSpeak(ws, '', true);
      }
      session.speakingController = null;
      if (content) pushTurn(session.callSid, 'assistant', content);
      session.messages.push({ role: 'assistant', content: content || null, tool_calls: toolCalls });
      for (const tc of toolCalls) {
        const args = safeJson(tc.function.arguments);
        const result = await callTool(tc.function.name, args, session);
        console.log(`  [tool] ${tc.function.name}`, args, '→', result);
        session.messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(result),
        });
      }
      if (session.encerrar) {
        setTimeout(() => { try { ws.close(); } catch {} }, 3000);
        return;
      }
      continue;
    }

    if (buf.length) {
      streamSpeak(ws, buf, true);
      spokeAnything = true;
    } else if (spokeAnything) {
      streamSpeak(ws, '', true);
    }
    session.speakingController = null;

    if (content) {
      session.messages.push({ role: 'assistant', content });
      pushTurn(session.callSid, 'assistant', content);
    }
    return;
  }
}

function findFlushBoundary(buf) {
  const re = /[.!?…](\s|$)/g;
  let m;
  while ((m = re.exec(buf)) !== null) {
    if (m.index >= 15) return m.index + m[0].length;
  }
  if (buf.length >= 45) {
    const cm = buf.match(/,\s/);
    if (cm && cm.index >= 15) return cm.index + cm[0].length;
    const sp = buf.lastIndexOf(' ');
    if (sp >= 25) return sp + 1;
  }
  return 0;
}

function streamSpeak(ws, text, last) {
  ws.send(JSON.stringify({ type: 'text', token: text, last }));
}

function safeJson(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }

// -----------------------------------------------------------------------------

server.listen(PORT, () => {
  console.log(`\n  ${BRAND_NAME} — Central de Atualização Cadastral`);
  console.log(`  Dashboard  →  http://localhost:${PORT}`);
  console.log(`  Voice URL  →  ${PUBLIC_URL}/voice/incoming`);
  console.log(`  Voz: +55 11 5039-6311 · SMS: ${SMS_FROM} · WhatsApp: ${WHATSAPP_FROM}\n`);
  bootstrapConversations().catch((err) => console.warn('  [memory] bootstrap falhou:', err.message));
});

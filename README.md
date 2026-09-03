# Vox — Demo de Atualização Cadastral (RFP Torre Health)

Demonstração pra apoiar a proposta da **Voxline** na RFP da **Torre Health** —
mostra como uma central omnichannel com IA da Twilio conduz o fluxo de
atualização cadastral do Derek, agora com escolha de canal pelo próprio cliente.

## O que a demo prova (linkado à RFP)

| Requisito da RFP                       | Onde aparece na demo                                            |
|----------------------------------------|-----------------------------------------------------------------|
| **Agente IA de voz** falado, baixa lat.| Chamada → ConversationRelay + OpenAI + Amazon Polly Camila-Neural |
| **Omnichannel com memória**            | Voz identifica o titular → envia link SMS/WhatsApp **já pré-preenchido** com o cadastro atual |
| **Transição sem recomeçar conversa**   | Cliente escolhe entre voz, SMS ou WhatsApp — a Sofia usa o mesmo registro do CRM |
| **Integração agnóstica com CRM**       | `buscar_participante`/`salvar_cadastro` são funções isoladas — trocam por Salesforce/RPA em produção |
| **Rastreabilidade**                    | Dashboard mostra cadastros salvos, links enviados (SID Twilio) e retornos agendados |
| **Transbordo humano (Anvisa/reclamação)** | Padrão pronto no `automatiza-demo` ao lado — reaproveitável (via TaskRouter/Flex) |

## Fluxo (versão atualizada)

```
Participante liga → Sofia pede CPF/Passaporte → busca CRM
   ├─ não encontrado → registra retorno da Central → encerra
   └─ encontrado     → confirma titular → OFERECE 3 CANAIS:
        ├─ voz         → coleta campo a campo → confirma → salva
        ├─ SMS  (link) → envia link pré-preenchido → cliente termina no navegador
        └─ WhatsApp    → mesmo, mas via WhatsApp
```

O link web (`/atualizar/:token`) abre um formulário **já com todos os dados
que a Sofia leu no CRM** — o cliente só confirma ou corrige o que mudou.
Quando ele salva, aparece no mesmo dashboard, com badge indicando o canal.

## Setup pra devs

Requer Node 18+, uma conta Twilio com Voice + ConversationRelay habilitados,
uma chave da OpenAI, e ngrok (ou qualquer túnel HTTPS público).

```bash
git clone <este-repo>
cd cadastro-demo
npm install
cp .env.example .env
# Editar .env com suas credenciais (ver seção Configuração abaixo)
export OPENAI_API_KEY=sk-...   # ou coloque no .env
```

### Configuração via `.env`

| Variável             | O que é                                                        |
|----------------------|----------------------------------------------------------------|
| `TWILIO_ACCOUNT_SID` | SID da conta Twilio                                            |
| `TWILIO_AUTH_TOKEN`  | Auth token da conta                                            |
| `VOICE_NUMBER_SID`   | SID do phone number (usado por `npm run wire`)                 |
| `SMS_FROM`           | Número Twilio de origem pra SMS                                |
| `WHATSAPP_FROM`      | Endereço WhatsApp (`whatsapp:+55...`)                          |
| `PUBLIC_URL`         | URL pública alcançável pela Twilio (ex: `https://x.ngrok.app`) |
| `OPENAI_MODEL`       | Modelo do OpenAI (padrão: `gpt-4o-mini`)                       |
| `TTS_PROVIDER`       | `ElevenLabs` ou `Amazon`                                       |
| `TTS_VOICE`          | Voice ID (ElevenLabs: `<id>-flash_v2_5`, ex: Fernanda `KHmfNHtEjHhLK9eER20w-flash_v2_5`) |
| `ASSISTANT_NAME`     | Nome do assistente (padrão: `Sofia`)                           |
| `BRAND_NAME`         | Nome da marca (padrão: `Vox`)                                  |
| `PARTICIPANTES_FILE` | Caminho do JSON com a base mockada (padrão: `./participantes.json`) |

### Personas mockadas

A base do "CRM" fica em [`participantes.json`](./participantes.json). Cada
entrada tem `documento`, `tipo` (CPF/Passaporte), `nome`, `data_nascimento`,
`telefone`, `email`, `endereco`, `ultima_atualizacao`. Edite livremente pra
adaptar às personas da sua demo. Reinicie o servidor após editar.

### Rodar (3 terminais)

```bash
# T1 — túnel HTTPS público
ngrok http --domain=<seu-dominio>.ngrok.app 3000

# T2 — servidor
npm start
# → http://localhost:3000 (dashboard)

# T3 — aponta o webhook do número Twilio pra este servidor
npm run wire
```

Ligue pro número Twilio configurado.

### ElevenLabs (opcional, mas recomendado)

A voz padrão é `Fernanda` (ElevenLabs, PT-BR natural). Requer credencial
ElevenLabs configurada em: Twilio Console → Voice → **ConversationRelay** →
Third-party TTS Providers → **ElevenLabs** → cole a API key. Se não
configurar, troque no `.env` pra `TTS_PROVIDER=Amazon` + `TTS_VOICE=Camila-Neural`.

### Trocar branding/assistente

Só ajustar `ASSISTANT_NAME` e `BRAND_NAME` no `.env`. O prompt, o greeting e as
mensagens de SMS/WhatsApp usam essas variáveis. Título "Vox" no HTML do
dashboard/form fica hardcoded — edite [`public/index.html`](public/index.html)
e [`public/form.html`](public/form.html) se quiser mudar.

## Roteiro de demo (~7 min)

### 1. Contexto (30s)
> "Isso é uma prova de conceito pro fluxo que o Derek desenhou — atualização
> cadastral. Mas com dois twists que ajudam na RFP da Torre Health: a
> Sofia oferece 3 canais pro cliente, e o link web já vem pré-preenchido
> com o que ela leu do CRM. Tudo em cima da Twilio."

### 2. Caminho voz puro (2 min)
Ligar do celular → Sofia pede documento → ditar `123 456 789 00` (Maria) →
Sofia confirma o nome, oferece as 3 opções → **dizer "posso fazer aqui
mesmo"** → Sofia coleta data, endereço, telefone, e-mail → confirma → salva.

Dashboard mostra o card verde com badge `voz`.

### 3. Caminho híbrido: identifica na voz, termina no celular (3 min)
Ligar de novo → ditar `111 222 333 44` (Ana) → Sofia confirma → oferece
opções → **dizer "manda por WhatsApp"** → Sofia pede número → **ditar seu
próprio número** → Sofia envia link e encerra.

No celular, abrir o link do WhatsApp — o formulário abre **com o nome, e-mail
e outras informações já preenchidas** (só endereço e telefone estão
vazios, porque estavam mesmo). Preencher, tocar Confirmar.

Dashboard mostra o card verde de novo — mesma pessoa, mas badge `web`.

> "Essa é a história de memória omnichannel. O cliente não recomeça a
> conversa quando muda de canal — a IA já identificou no telefone, o
> celular só mostra o que faltava."

### 4. Não cadastrado (30s)
Ligar → ditar `999 999 999 99` → Sofia não localiza, agenda retorno da
Central. Card laranja no dashboard.

### 5. Encerramento — vínculo com o resto da stack (1 min)
> "O que não coloquei aqui pra não inflar: sentiment em tempo real com
> transbordo automático pro Flex se o cliente ficar frustrado — já roda
> na minha demo Automatiza ao lado. Enterprise Knowledge (RAG) entra
> nas tools também, exatamente do mesmo jeito que `buscar_participante`
> — só troca o mock por uma busca vetorial. Isso segue a arquitetura de
> **Conversations + Orchestrator + Memory + Agent Connect** da Twilio."

## Base mockada

| Documento     | Nome                     | Estado dos dados                          |
|---------------|--------------------------|-------------------------------------------|
| 12345678900   | Maria da Silva Santos    | só nome + nascimento (ideal p/ voz puro)  |
| 98765432100   | João Pereira de Andrade  | todos completos (ideal p/ mostrar edição) |
| 11122233344   | Ana Beatriz Nogueira     | e-mail preenchido, resto vazio (ideal p/ link) |
| **30012345678** | **Rui Manuel Patrício** | **todos os 5 campos preenchidos + telefone = seu celular (ideal p/ confirmar telefone do cadastro e mandar WhatsApp)** |
| FF123456      | Carlos Vieira Costa      | passaporte, só nome/nasc                  |
| qualquer outro| —                        | **não encontrado** → agenda retorno       |

### Persona de teste — Rui Patrício

Cadastro pré-carregado no CRM:

- Nome: Rui Manuel Patrício
- Data de nascimento: 12/06/1985
- Telefone: (11) 96922-2122  ← seu número, para confirmar em voz
- E-mail: rui.patricio@email.com
- Endereço: Av. Paulista, 1578, apto 92 — Bela Vista, São Paulo/SP, CEP 01310-200

Fluxo: ligar → ditar `300 123 456 78` → Sofia confirma o titular → você diz "manda por WhatsApp" → **Sofia lê o telefone do cadastro ("onze, nove seis nove dois dois, dois um dois dois — é esse mesmo?")** → você confirma → link chega no seu WhatsApp → abre pré-preenchido, você só corrige o que quiser.

## Twilio Conversations — memory

No startup, o servidor sincroniza cada persona com uma **Conversation** no Twilio (`uniqueName = vox-<documento>`), guardando o snapshot do cadastro em `attributes`. É o "memory omnichannel" da Voxline: qualquer canal futuro (Chat, WhatsApp, Voice) resolve o participante pela mesma Conversation.

- Console: https://console.twilio.com/us1/develop/conversations
- Falha silenciosa se Conversations não estiver habilitada — não bloqueia a demo.
- Todo `salvar_cadastro` (voz) e todo POST do formulário web propagam a atualização de volta para a Conversation.

## Estrutura

```
cadastro-demo/
├── server.js                 # /voice/incoming, /relay, /atualizar/:token, tools
├── public/
│   ├── index.html            # dashboard SSE (voz + links + web + retornos)
│   └── form.html             # formulário mobile-first, pré-preenchido
├── scripts/wire-webhook.js   # aponta o 6311 pro /voice/incoming
└── .env                      # SIDs owlclinic + números SMS/WhatsApp
```

## Se algo falhar durante a demo

- **WhatsApp outbound não chega** → Meta exige template pra iniciar
  conversa fria. Fallback: usar SMS. Ou pedir pro cliente mandar um
  `oi` pro 6311 antes (abre janela de 24h). Log fica no dashboard, card
  fica com status `falhou`.
- **SMS não chega** → confirmar `SMS_FROM` no `.env` (número 9521-3530-3
  precisa estar ativo com A2P registrado).
- **Chamada cai no VM Twilio** → `npm run wire` de novo.
- **Camila-Neural indisponível** → trocar para `Polly.Camila` no
  `/voice/incoming`.

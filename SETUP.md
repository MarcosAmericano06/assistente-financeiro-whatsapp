# Setup passo a passo

Tempo estimado: 2 a 3 horas, com o Claude Code ajudando. Faça na ordem.

## 1. Contas (todas gratuitas para começar)

1. **Neon** (neon.tech): crie um projeto Postgres na região `sa-east-1` e copie a URL com **pooler** para `DATABASE_URL`.
2. **Pluggy**:
   - Em **meu.pluggy.ai**, conecte cada banco seu pelo consentimento Open Finance.
   - Em **dashboard.pluggy.ai**, crie um app e copie o Client ID e o Secret.
   - Compartilhe os itens do MeuPluggy com o app. Cada banco vira um item; os ids vão em `PLUGGY_ITEM_IDS`.
   - Os itens do MeuPluggy atualizam **uma vez por dia**, e você pode forçar pelo app MeuPluggy.
3. **Gemini** (aistudio.google.com): crie uma chave num projeto **com faturamento ativo** (veja os riscos no README).
4. **Google Calendar** (opcional, para a agenda no resumo da manhã):
   - Crie um projeto no Google Cloud, ative a Calendar API e crie um cliente OAuth do tipo "Desktop".
   - Gere um refresh token com o escopo `https://www.googleapis.com/auth/calendar.events`.
   - **Atenção:** se o app OAuth ficar em modo "Teste", o token expira em 7 dias. Publique o app, ou use uma conta Google Workspace com app "Interno".
5. **Telegram**: crie um bot com o @BotFather e pegue o seu chat id. Ele recebe o QR de pareamento do WhatsApp e serve de reserva para os avisos.
6. **Oracle Cloud** (Always Free): crie uma VM Ubuntu 24.04 (a micro x86 basta) e guarde a chave SSH.
7. **Número de WhatsApp para o bot**: um chip ou número dedicado. Não use o seu número pessoal.

## 2. No seu computador

Você vai precisar de Node 22+, Docker Desktop (para os testes) e do Claude Code.

```bash
npm ci
docker compose up -d --wait
npm run preflight          # typecheck + testes (precisa do Docker)
cp .env.example .env       # preencha
cp setup.example.json setup.json   # seus nomes, família, projetos
```

Os campos do `setup.json`:

| Campo | O que é |
|---|---|
| `ownNames` | Como o **seu** nome aparece nas transferências entre as suas contas (ex.: `"joana da silva"`). Essas viram transferência, não gasto. |
| `family` | Nomes da família como aparecem nos PIX. Quando o mesmo valor entra e sai em até 3 dias, é repasse e fica fora das contas. Os outros PIX de família vêm na lista com ❓. |
| `projects` | Projetos das tarefas. |
| `cardPaymentPatterns` | Trechos da descrição do pagamento de fatura feito pela conta corrente (ex.: `"pagamento de fatura"`, `"pagamento para banco x"`). Descubra depois do primeiro sync (passo 4). |

## 3. Banco de dados

```bash
DATABASE_URL="$(grep '^DATABASE_URL=' .env | cut -d= -f2-)" npx drizzle-kit migrate
npm run setup
```

## 4. Primeiro sync e ajuste fino

Rode um sync uma vez, localmente:

```bash
npx tsx --env-file=.env src/ingestion/run.ts
```

Depois procure os pagamentos de fatura feitos pela conta corrente, que **não podem contar como gasto**. Peça ao Claude: "procure no banco as saídas da conta corrente que parecem pagamento de fatura". Ponha os trechos em `cardPaymentPatterns` e rode `npm run setup` de novo.

## 5. VM

Na VM, uma vez só:

```bash
sudo apt update && sudo apt install -y git rsync
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
sudo timedatectl set-timezone America/Sao_Paulo
mkdir -p ~/bot-financeiro
```

No seu computador:

1. Copie `infra/deploy.env.example` para `infra/deploy.env` e preencha.
2. Copie o `.env` para a VM, em `~/bot-financeiro/.env`.
3. Instale o serviço a partir de `infra/bot-wa.service`, seguindo as instruções no topo do arquivo.
4. Rode `bash infra/deploy.sh`.

**Pareamento:** na primeira subida, o QR do WhatsApp chega no seu Telegram. Abra o WhatsApp **do número do bot**, vá em **Aparelhos conectados → Conectar aparelho** e escaneie.

## 6. Pronto

Mande um "oi" do seu número pessoal para o número do bot. Os horários dos avisos:

| Quando | O quê |
|---|---|
| Todo dia, 07h30 | Resumo da manhã |
| Todo dia, 19h | Lista de gastos |
| Domingo, 9h | Relatório da semana e revisão das tarefas |

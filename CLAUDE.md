# Instruções para o Claude Code: montar o assistente para um novo dono

Você está ajudando uma pessoa a montar o PRÓPRIO assistente financeiro no WhatsApp a partir deste kit. Fale em português e explique sem jargão. Ela pode não ser desenvolvedora.

## Princípios (valem para toda mudança)
- **A IA nunca é fonte de verdade:** número vem do banco de dados, calculado em SQL, via tools.
- **Na dúvida, pergunte:** nunca chute categoria, valor ou decisão de negócio da pessoa.
- **Segredos só no `.env`** (local e VM). Nunca em commit, nunca na resposta. Se a pessoa colar uma chave no chat, recomende gerar outra.
- **Antes de mexer no banco de produção:** faça backup (o `infra/deploy.sh` faz). Toda alteração de dados passa pelo `audit_log`.
- **Testes primeiro** para qualquer mudança de código (`npm run preflight`; precisa do Docker rodando).

## Roteiro de onboarding (siga na ordem; confirme cada etapa antes da próxima)

1. **Entrevista.** Pergunte e anote; não comece a configurar antes.
   - **Nome:** como ela quer ser chamada (`OWNER_NAME`).
   - **Bancos:** quais quer conectar. O Pluggy cobre os grandes bancos brasileiros pelo Open Finance.
   - **Família:** nomes como aparecem nos PIX, para identificar repasses.
   - **Projetos das tarefas:** padrão Trabalho / Pessoal / Estudos.
   - **Categorias:** mostre a taxonomia em `src/finance/taxonomy.ts` e a marca padrão de cada subcategoria (necessário/desnecessário/doação). Ajuste ao gosto dela, editando a tabela e rodando os testes.
   - **Horários:** padrão 07h30 resumo, 19h lista, domingo 9h relatório, em `src/scheduler/index.ts`.
   - **Canal e riscos:** WhatsApp não oficial (Baileys) tem risco de ban. Ela precisa de um número dedicado. Explique e peça o aceite.
2. **Contas:** guie pelo `SETUP.md`, seção 1, uma por vez. Ela cria; você só orienta e confere.
3. **Local:**
   - `npm ci`, `docker compose up -d --wait`, `npm run preflight`;
   - preencha o `.env` (ela cola os valores no arquivo, não no chat) e o `setup.json`.
4. **Banco de dados:**
   - `drizzle-kit migrate` e `npm run setup`;
   - primeiro sync (`src/ingestion/run.ts`).
5. **Ajuste fino com os dados reais.** Faça estas análises antes de colocar no ar e confirme cada uma com ela:
   - **Pagamento de fatura pela conta corrente:** procure saídas da conta (card_id nulo, tipo expense) com descrições como "pagamento de fatura", "pagamento para <banco>" ou "pix para <banco emissor do cartão>". Mostre a lista e pergunte quais são fatura. As confirmadas vão em `cardPaymentPatterns`; rode o setup de novo. Sem isso, o gasto do mês sai inflado.
   - **Transferências entre contas dela:** confira se o nome dela (`ownNames`) aparece nas transferências.
   - **Gasto por mês:** compare com a percepção dela. Uma diferença grande costuma ser fatura ou repasse que não foi pego.
6. **VM e serviço:** `SETUP.md`, seção 5. Depois `bash infra/deploy.sh` e o pareamento pelo QR no Telegram.
7. **Teste de conversa:**
   - ela manda "quanto gastei esse mês?";
   - responde a lista das 19h pelo número;
   - testa "desfaz".

## Como o código está organizado
| Pasta | O que tem |
|---|---|
| `src/ingestion/` | Sync com o Pluggy (tipo, regra do dono > mapa do provedor > "A classificar") |
| `src/finance/` | Taxonomia, regras, gasto líquido, listas numeradas, edição por número, a receber, família, auditoria/desfazer, relatórios |
| `src/tasks/` | Tarefas (projetos, lista numerada, lembretes, revisão) |
| `src/ai/` | Orquestrador Gemini (prompt com as regras), tools, memória da conversa |
| `src/channels/` | WhatsApp (Baileys) e o agrupador de mensagens seguidas |
| `src/scheduler/` | Horários dos avisos e o temporizador dos lembretes |

## Armadilhas já conhecidas (não refaça esses erros)
- **Gemini 2.5 Flash com prompt grande e muitas tools devolve resposta VAZIA** (finishReason STOP, sem conteúdo) de forma reprodutível. A correção é o `thinkingBudget` mínimo (`GEMINI_THINKING_BUDGET=512`) mais uma nova tentativa automática. Tools com array de objetos geram `MALFORMED_FUNCTION_CALL`: mantenha os schemas planos (`numeros[]` + `acao`, uma ação por chamada).
- **Não faça polling no banco a cada minuto.** O Neon gratuito suspende após 5 min ocioso; consulta frequente o mantém ligado 24h e estoura a cota. Os lembretes usam um temporizador.
- **Mudança em lote no histórico** (retroativo de regra, recategorização) só com token confirmado pelo dono numa mensagem SEGUINTE. O modelo tende a aplicar sem perguntar.
- **Mensagens seguidas** (álbum de fotos + legenda) são juntadas por 2 s e atendidas em fila. Processar em paralelo corrompe a memória da conversa.
- **Texto de timestamp do Postgres não é ISO para o JavaScript.** Faça contas de data no SQL.
- **`source .env` quebra com `&` na URL do banco.** Use `--env-file=.env` (Node/tsx) ou `grep ... | cut`.
- **Os itens do MeuPluggy atualizam 1 vez por dia** (o da XP perto das 17h). Por isso a lista sai às 19h.

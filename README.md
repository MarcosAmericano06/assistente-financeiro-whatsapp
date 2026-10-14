# Assistente financeiro no WhatsApp

Um assistente pessoal que roda no seu WhatsApp e cuida de três coisas:

- **Gastos**: puxa automaticamente as transações dos seus bancos (Open Finance via Pluggy), classifica em categorias em português e com uma marca 🟢 necessário / 🔴 desnecessário / 🎁 doação, e te manda:
  - **todo dia às 19h** a lista numerada do que entrou ("quer alterar algum?");
  - **todo domingo às 9h** o relatório da semana, com comparação com as 4 semanas anteriores.

  Você corrige tudo respondendo pelo número: `4 para mercado`, `3 não é gasto`, `7 é duplicado`, `5 o Pedro vai me devolver 50`, `2 necessário`, `desfaz`.
- **Tarefas**: lista numerada por projeto no resumo das 7h30, lembretes no horário ("me lembra de ligar pro banco amanhã às 15h") e revisão semanal.
- **Agenda**: lê o seu Google Calendar no resumo da manhã.

Pergunte o que quiser em português: "quanto gastei com coisas desnecessárias esse mês?", "relatório de setembro de alimentação", "o que tenho pra fazer hoje?".

## Como funciona

```
Bancos ──Open Finance──▶ Pluggy ──sync a cada 3h──▶ Postgres (Neon)
                                                       ▲   │
WhatsApp ◀──▶ Baileys ◀──▶ Orquestrador (Gemini + tools) ┘   │
                    ▲                                        ▼
                    └──────── agendador: 07h30 resumo · 19h lista · dom 9h relatório · lembretes
```

Princípios que o código segue:

- **A IA nunca é fonte de verdade.** Ela interpreta o pedido; todo número vem do banco de dados, calculado em SQL.
- **Na dúvida, pergunta.** Gasto sem classificação certa vem com ❓. Categoria nova só é criada se você pedir.
- **Nada some sem volta.** Toda alteração fica no `audit_log`, e `desfaz` reverte a última mensagem.
- **Sem dupla contagem.**
  - Pagamento de fatura não é gasto, porque as compras do cartão já contaram.
  - Estorno abate o gasto.
  - Repasse da família e transferência entre as suas contas não contam.
  - Gasto dito à mão só é registrado se foi pago fora dos bancos conectados.

## Custos (aproximados)

| Item | Custo |
|---|---|
| VM Oracle Cloud (Always Free) | R$ 0 |
| Postgres Neon (Free) | R$ 0 |
| Pluggy / MeuPluggy (uso pessoal) | R$ 0 |
| Gemini 2.5 Flash (plano pago, pelo uso) | alguns reais por mês |
| WhatsApp (número próprio, via Baileys) | R$ 0 |

## Riscos que você precisa aceitar

- **WhatsApp não oficial.** O Baileys imita o WhatsApp Web, e a Meta pode banir o número. Use um número dedicado ao bot, nunca o seu principal. O bot só responde ao número do dono e ignora grupos.
- **Dados financeiros.** Eles ficam no seu banco de dados e passam pelo Gemini. Use uma chave de projeto **com faturamento ativo**, porque no plano gratuito o Google pode usar os dados para treinar.
- **Senhas e chaves.** Ficam só no `.env` do seu computador e da VM, nunca no git.

## Como montar o seu

Abra esta pasta no **Claude Code** e diga "quero montar o meu assistente". O `CLAUDE.md` guia o Claude passo a passo. Se preferir fazer à mão, siga o [SETUP.md](SETUP.md).

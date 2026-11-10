import { processActivities, dollars, type Activity, type NewPurchase } from './domain.js';
import { loadState, saveState, type CardPayState, type Offer } from './state.js';
import type { WsClient } from './wealthsimple.js';

const WINDOW_DAYS = 14;
const OFFER_TTL_MS = 24 * 3600 * 1000;
const MAX_PAYMENT_CENTS = 20_000;
const FAIL_ALERT_STREAK = 8;

export interface CardPayDeps {
  ws: WsClient;
  send(text: string): Promise<string | null>;
  resolveTelegramMessageId(messageOutId: string): number | null;
  now(): number;
  uuid(): string;
}

export interface InboundLike {
  channelType: string;
  message: { content: unknown };
}

export interface GroupLike {
  platform_id: string;
  is_group: number;
}

const torontoDate = (iso: string): { day: string; time: string } => {
  const d = new Date(iso);
  const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Toronto', ...opts }).format(d);
  return { day: fmt({ day: '2-digit', month: '2-digit' }), time: fmt({ hour: '2-digit', minute: '2-digit', hour12: false }) };
};

function fmtOffer(p: NewPurchase, accounts: Offer['accounts'], observedAt: string): string {
  const { day, time } = torontoDate(p.occurredAt);
  const lines = [
    '🔔 Nova compra no cartão',
    `${p.merchant} — $${p.amount} CAD`,
    `${day} às ${time}`,
    '',
    'Pagar com saldo — responda a esta mensagem com o número da conta:',
    ...accounts.map((a) => `  ${a.num}) ${a.name} — ${a.balanceCents === null ? 'saldo indisponível' : `disponível $${dollars(a.balanceCents)}`}`),
    '',
    `Saldos consultados às ${observedAt}.`,
  ];
  return lines.join('\n');
}

export interface CardPayService {
  pollOnce(): Promise<void>;
  handleInbound(event: InboundLike, mg: GroupLike, userId: string | null): Promise<boolean>;
}

export function createCardPayService(deps: CardPayDeps): CardPayService {
  const { ws, send } = deps;

  async function sendToUser(text: string): Promise<void> {
    await send(text);
  }

  async function loadAccounts(state: CardPayState): Promise<Offer['accounts']> {
    const accounts = await ws.fetchCashAccounts(state.config.profile);
    if (accounts.length === 0) return [];
    const balances = await ws.fetchWithdrawableCents(
      accounts.map((a) => a.id),
      state.config.cardId,
      state.config.profile,
    );
    const byId = new Map(balances.map((b) => [b.accountId, b.cents]));
    const observedAt = torontoDate(new Date(deps.now()).toISOString()).time;
    return accounts
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((a, i) => ({
        num: i + 1,
        accountId: a.id,
        name: a.name,
        balanceCents: byId.get(a.id) ?? null,
        observedAt,
      }));
  }

  async function createOffer(state: CardPayState, p: NewPurchase): Promise<void> {
    if (p.amountCents > MAX_PAYMENT_CENTS) {
      await sendToUser(
        `🔔 Nova compra no cartão\n${p.merchant} — $${p.amount} CAD\n\nValor acima do limite de $200.00 do monitor — pague manualmente no app.`,
      );
      return;
    }
    const accounts = await loadAccounts(state);
    const offer: Offer = {
      id: `offer-${deps.uuid()}`,
      purchaseKey: p.key,
      messageOutId: null,
      telegramMessageId: null,
      merchant: p.merchant,
      amountCents: p.amountCents,
      currency: p.currency,
      accounts,
      createdAt: new Date(deps.now()).toISOString(),
      state: 'active',
    };
    const text = fmtOffer(p, accounts, new Date(deps.now()).toISOString());
    if (text.length > 4000) {
      offer.state = 'blocked';
      state.offers.push(offer);
      await sendToUser(
        `🔔 Nova compra no cartão\n${p.merchant} — $${p.amount} CAD\n\nNão consegui montar a lista de contas dentro do limite da mensagem. Pague manualmente no app.`,
      );
      return;
    }
    offer.messageOutId = await send(text);
    state.offers.push(offer);
  }

  async function pollOnce(): Promise<void> {
    const state = loadState();
    if (!state.config.enabled) return;

    const startDate = new Date(deps.now() - WINDOW_DAYS * 864e5).toISOString().replace(/\.\d{3}Z$/, 'Z');
    let rows: Activity[];
    try {
      rows = await ws.fetchActivities(state.config.cardId, state.config.profile, startDate);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'auth_required') {
        if (!state.authAlerted) {
          state.authAlerted = true;
          saveState(state);
          await sendToUser('⚠️ Consulta do cartão pausada: Wealthsimple precisa de nova autenticação. Me avise quando quiser refazer o login.');
          return;
        }
        saveState(state);
        return;
      }
      state.failStreak = (state.failStreak || 0) + 1;
      if (state.failStreak >= FAIL_ALERT_STREAK && !state.failAlerted) {
        state.failAlerted = true;
        saveState(state);
        await sendToUser(`⚠️ A consulta do cartão falhou ${state.failStreak} vezes seguidas: ${(e as Error).message?.slice(0, 200)}`);
        return;
      }
      saveState(state);
      return;
    }

    state.authAlerted = false;
    state.failAlerted = false;
    state.failStreak = 0;

    const firstRun = !state.seeded;
    const { newPurchases } = processActivities(state, rows, firstRun);
    state.seeded = true;

    for (const offer of state.offers) {
      if (offer.state !== 'active') continue;
      if (deps.now() - Date.parse(offer.createdAt) > OFFER_TTL_MS) {
        offer.state = 'expired';
        continue;
      }
      const seen = state.seen[offer.purchaseKey];
      if (!seen || seen.st === 'paid' || seen.st === 'inferred_paid') continue;
      if (seen.amount !== offer.amountCents) {
        offer.state = 'invalidated';
        await createOffer(state, {
          key: offer.purchaseKey,
          merchant: seen.merchant,
          amount: dollars(seen.amount),
          amountCents: seen.amount,
          currency: offer.currency,
          occurredAt: seen.at,
          status: 'settled',
        });
      }
    }

    for (const p of newPurchases) {
      await createOffer(state, p);
    }

    saveState(state);
  }

  function parseContent(content: unknown): { text: string; replyToMessageId: number | null } {
    const c = typeof content === 'string' ? (JSON.parse(content) as Record<string, unknown>) : (content as Record<string, unknown>);
    const replyTo = c?.replyTo as { messageId?: number } | undefined;
    return { text: typeof c?.text === 'string' ? c.text : '', replyToMessageId: replyTo?.messageId ?? null };
  }

  async function handleInbound(event: InboundLike, mg: GroupLike, userId: string | null): Promise<boolean> {
    const state = loadState();
    if (!state.config.enabled) return false;
    if (event.channelType !== 'telegram') return false;
    if (mg.platform_id !== state.config.chatPlatformId || mg.is_group === 0) return false;

    const { text, replyToMessageId } = parseContent(event.message.content);
    if (replyToMessageId === null) return false;

    for (const offer of state.offers) {
      if (offer.telegramMessageId === null && offer.messageOutId) {
        offer.telegramMessageId = deps.resolveTelegramMessageId(offer.messageOutId);
      }
    }
    const offer = state.offers.find((o) => o.telegramMessageId === replyToMessageId);
    if (!offer) return false;

    const fail = async (message: string): Promise<boolean> => {
      saveState(state);
      await sendToUser(message);
      return true;
    };

    if (!userId || !state.config.approverIds.includes(userId)) {
      return fail('Só Eudes ou Magda podem autorizar pagamentos.');
    }
    if (offer.state === 'paying') return fail('Pagamento em andamento — aguarde a confirmação.');
    if (offer.state === 'paid') return fail('Essa compra já foi paga.');
    if (offer.state === 'expired') return fail('Essa oferta está expirada. A próxima compra gera um novo aviso.');
    if (offer.state === 'invalidated') return fail('O valor dessa compra mudou — veja o aviso mais recente.');
    if (offer.state === 'blocked') return fail('Essa oferta está bloqueada para pagamento automático.');

    const trimmed = text.trim();
    if (!/^\d+$/.test(trimmed)) return fail('Responda só com o número da conta (ex.: 1).');
    const account = offer.accounts.find((a) => a.num === parseInt(trimmed, 10));
    if (!account) return fail(`Número inválido — escolha entre 1 e ${offer.accounts.length}.`);

    const seen = state.seen[offer.purchaseKey];
    if (!seen) return fail('Compra não encontrada no histórico.');
    if (seen.st === 'paid' || seen.st === 'inferred_paid') {
      offer.state = 'paid';
      return fail('Essa compra já foi paga.');
    }
    if (seen.amount !== offer.amountCents) {
      offer.state = 'invalidated';
      return fail('O valor dessa compra mudou — veja o aviso mais recente.');
    }

    offer.state = 'paying';
    saveState(state);

    let balance: number | null;
    try {
      const balances = await ws.fetchWithdrawableCents([account.accountId], state.config.cardId, state.config.profile);
      balance = balances.find((b) => b.accountId === account.accountId)?.cents ?? null;
    } catch {
      balance = null;
    }
    if (balance === null) {
      offer.state = 'active';
      return fail('Não consegui confirmar o saldo agora — tente de novo em alguns minutos.');
    }
    if (balance < offer.amountCents) {
      offer.state = 'active';
      return fail(`Saldo insuficiente em ${account.name} (disponível $${dollars(balance)}). Responda com outro número.`);
    }

    const attempt = {
      offerId: offer.id,
      userId,
      accountId: account.accountId,
      amountCents: offer.amountCents,
      idempotencyKey: deps.uuid(),
      state: 'submitting' as 'submitting' | 'accepted' | 'rejected' | 'unknown',
      at: new Date(deps.now()).toISOString(),
    };
    state.attempts.push(attempt);
    saveState(state);

    const outcome = await ws.payCard({
      amountCents: offer.amountCents,
      cashAccountId: account.accountId,
      creditAccountId: state.config.cardId,
      idempotencyKey: attempt.idempotencyKey,
      profile: state.config.profile,
    });

    if (outcome.outcome === 'accepted') {
      attempt.state = 'accepted';
      offer.state = 'paid';
      seen.st = 'paid';
      saveState(state);
      await sendToUser(`✅ Wealthsimple aceitou o pagamento de $${dollars(offer.amountCents)} da conta ${account.name} (${offer.merchant}).`);
      return true;
    }
    if (outcome.outcome === 'rejected') {
      attempt.state = 'rejected';
      offer.state = 'active';
      saveState(state);
      await sendToUser(`Pagamento recusado: ${outcome.reason}. Responda com outro número de conta.`);
      return true;
    }
    if (outcome.outcome === 'auth') {
      attempt.state = 'unknown';
      offer.state = 'active';
      saveState(state);
      await sendToUser('⚠️ Wealthsimple pediu reautenticação — o pagamento NÃO foi enviado. Refaça o login e responda de novo.');
      return true;
    }
    attempt.state = 'unknown';
    offer.state = 'blocked';
    saveState(state);
    await sendToUser(
      `⚠️ Resultado incerto no pagamento de $${dollars(offer.amountCents)} (${outcome.reason}). Não repeti o pagamento — vou verificar manualmente antes de qualquer nova tentativa.`,
    );
    return true;
  }

  return { pollOnce, handleInbound };
}

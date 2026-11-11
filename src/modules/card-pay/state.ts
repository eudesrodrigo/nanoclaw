import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../config.js';

export interface SeenEntry {
  st: 'seeded' | 'notified' | 'paid' | 'inferred_paid' | 'blocked';
  amount: number;
  merchant: string;
  at: string;
}

export interface OfferAccount {
  num: number;
  accountId: string;
  name: string;
  balanceCents: number | null;
  observedAt: string;
}

export interface Offer {
  id: string;
  purchaseKey: string;
  messageOutId: string | null;
  telegramMessageId: number | null;
  merchant: string;
  amountCents: number;
  currency: string;
  accounts: OfferAccount[];
  createdAt: string;
  state: 'active' | 'paying' | 'paid' | 'expired' | 'invalidated' | 'blocked';
}

export interface PaymentAttempt {
  offerId: string;
  userId: string;
  accountId: string;
  amountCents: number;
  idempotencyKey: string;
  state: 'submitting' | 'accepted' | 'rejected' | 'unknown';
  confirmDelivered?: boolean;
  at: string;
}

export interface CardPayConfig {
  enabled: boolean;
  chatPlatformId: string;
  approverIds: string[];
  cardId: string;
  profile: string;
}

export interface CardPayState {
  config: CardPayConfig;
  seen: Record<string, SeenEntry>;
  consumedPayments: string[];
  offers: Offer[];
  attempts: PaymentAttempt[];
  authAlerted: boolean;
  failStreak: number;
  failAlerted: boolean;
  seeded: boolean;
}

function freshState(): CardPayState {
  return {
    config: {
      enabled: false,
      chatPlatformId: '',
      approverIds: [],
      cardId: '',
      profile: 'eudes',
    },
    seen: {},
    consumedPayments: [],
    offers: [],
    attempts: [],
    authAlerted: false,
    failStreak: 0,
    failAlerted: false,
    seeded: false,
  };
}

let testPath: string | null = null;

export function _setStatePathForTest(p: string | null): void {
  testPath = p;
}

export function _resetStatePathForTest(): void {
  testPath = null;
}

function statePath(): string {
  return testPath ?? path.join(DATA_DIR, 'card-pay-state.json');
}

export function loadState(): CardPayState {
  const p = statePath();
  if (!fs.existsSync(p)) return freshState();
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<CardPayState>;
  return { ...freshState(), ...parsed, config: { ...freshState().config, ...(parsed.config ?? {}) } };
}

export function saveState(state: CardPayState): void {
  const p = statePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p + '.tmp', JSON.stringify(state, null, 1));
  fs.renameSync(p + '.tmp', p);
}

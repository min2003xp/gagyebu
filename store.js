// 데이터 저장소.
// 지금은 이 기기(브라우저)에만 저장한다. 다음 단계에서 같은 함수 이름을 가진
// Supabase 저장소로 바꿔 끼우면 두 폰이 같은 데이터를 보게 된다.

const KEY = 'gagyebu-data-v1';

export const uid = () =>
  (globalThis.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2);

const DEFAULT_CATS = [
  ['expense', '🍚', '식비'],
  ['expense', '☕', '카페·간식'],
  ['expense', '🧻', '생활용품'],
  ['expense', '🚌', '교통'],
  ['expense', '🏠', '주거·관리비'],
  ['expense', '📱', '통신'],
  ['expense', '💊', '의료'],
  ['expense', '👕', '쇼핑'],
  ['expense', '🎬', '문화·여가'],
  ['expense', '🎁', '경조사·선물'],
  ['expense', '📦', '기타'],
  ['income', '💰', '월급'],
  ['income', '💵', '부수입'],
  ['income', '🪙', '기타 수입'],
];

function defaults() {
  return {
    settings: { names: { a: '나', b: '아내' } },
    categories: DEFAULT_CATS.map(([type, emoji, name]) => ({ id: uid(), type, emoji, name })),
    transactions: [],
    budgets: {},
    recurring: [],
    // 자산: { id, name, kind, owner('a'|'b'|'both'), balances: { 'YYYY-MM': 금액 } }
    assets: [],
    // 변경 기록: { id, at(시각), by('a'|'b'), action('add'|'update'|'delete'), target, text, notifiedAt }
    // 상대방에게 보낼 요약 알림의 재료가 된다.
    activity: [],
    // 결제수단: { id, name, kind('card'|'prepaid'), initialBalance }
    payment_methods: [],
  };
}

export function createStore() {
  let data;
  let fresh = false;
  try {
    const raw = localStorage.getItem(KEY);
    data = raw ? { ...defaults(), ...JSON.parse(raw) } : defaults();
    fresh = !raw;
  } catch {
    data = defaults();
  }

  const listeners = new Set();
  const write = () => { try { localStorage.setItem(KEY, JSON.stringify(data)); } catch {} };
  const commit = () => { write(); listeners.forEach(f => f()); };
  if (fresh) write();

  return {
    mode: 'local',
    get data() { return data; },
    async init() {},
    subscribe(fn) { listeners.add(fn); },

    status: 'ready',
    async addTx(t) {
      data.transactions.push({ ...t, id: uid(), createdAt: Date.now() });
      commit();
    },
    async addRecurringTx(t) { return this.addTx(t); },
    async updateTx(id, patch) {
      data.transactions = data.transactions.map(t => (t.id === id ? { ...t, ...patch } : t));
      commit();
    },
    async deleteTx(id) {
      data.transactions = data.transactions.filter(t => t.id !== id);
      commit();
    },

    async addCategory(c) {
      data.categories.push({ ...c, id: uid() });
      commit();
    },
    async deleteCategory(id) {
      data.categories = data.categories.filter(c => c.id !== id);
      commit();
    },

    async setBudgets(budgets) {
      data.budgets = budgets;
      commit();
    },

    async addRecurring(r) {
      data.recurring.push({ ...r, id: uid() });
      commit();
    },
    async updateRecurring(id, patch) {
      data.recurring = data.recurring.map(r => (r.id === id ? { ...r, ...patch } : r));
      commit();
    },
    async deleteRecurring(id) {
      data.recurring = data.recurring.filter(r => r.id !== id);
      commit();
    },

    async addAsset(a) {
      data.assets.push({ ...a, id: uid() });
      commit();
    },
    async updateAsset(id, patch) {
      data.assets = data.assets.map(a => (a.id === id ? { ...a, ...patch } : a));
      commit();
    },
    async deleteAsset(id) {
      data.assets = data.assets.filter(a => a.id !== id);
      commit();
    },

    async addPaymentMethod(p) {
      const item = { ...p, id: uid() };
      data.payment_methods.push(item);
      commit();
      return item;
    },
    async updatePaymentMethod(id, patch) {
      data.payment_methods = data.payment_methods.map(p => (p.id === id ? { ...p, ...patch } : p));
      commit();
    },
    async deletePaymentMethod(id) {
      data.payment_methods = data.payment_methods.filter(p => p.id !== id);
      commit();
    },

    async addActivity(entry) {
      data.activity = [...data.activity, { ...entry, id: uid(), notifiedAt: null }].slice(-300);
      commit();
    },

    async saveNames(names) {
      data.settings = { ...data.settings, names };
      commit();
    },
  };
}

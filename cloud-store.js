// 두 폰이 함께 쓰는 저장소 (Supabase).
// store.js(이 기기 전용)와 같은 함수 이름과 같은 데이터 모양을 쓴다.

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

/* ---------- DB 모양 <-> 앱 모양 ---------- */
const map = {
  categories: {
    in: r => ({ id: r.id, type: r.type, emoji: r.emoji, name: r.name }),
    out: c => ({ type: c.type, emoji: c.emoji, name: c.name }),
    order: 'created_at',
  },
  transactions: {
    in: r => ({
      id: r.id, type: r.type, amount: Number(r.amount), date: r.date, categoryId: r.category_id,
      who: r.who, memo: r.memo, recurringKey: r.recurring_key, createdAt: Date.parse(r.created_at),
    }),
    out: t => ({
      type: t.type, amount: t.amount, date: t.date, category_id: t.categoryId ?? null,
      who: t.who, memo: t.memo ?? '', recurring_key: t.recurringKey ?? null,
    }),
    order: 'date',
  },
  recurring: {
    in: r => ({
      id: r.id, type: r.type, amount: Number(r.amount), categoryId: r.category_id, who: r.who, memo: r.memo,
      day: r.day, startMonth: r.start_month, lastApplied: r.last_applied,
    }),
    out: r => ({
      type: r.type, amount: r.amount, category_id: r.categoryId ?? null, who: r.who, memo: r.memo ?? '',
      day: r.day, start_month: r.startMonth, last_applied: r.lastApplied ?? null,
    }),
    order: 'created_at',
  },
  assets: {
    in: r => ({ id: r.id, name: r.name, kind: r.kind, owner: r.owner, balances: r.balances || {} }),
    out: a => ({ name: a.name, kind: a.kind, owner: a.owner, balances: a.balances || {} }),
    order: 'created_at',
  },
  activity: {
    in: r => ({
      id: r.id, at: Date.parse(r.at), by: r.author, action: r.action, target: r.target,
      text: r.summary, notifiedAt: r.notified_at,
    }),
    out: a => ({ author: a.by, action: a.action, target: a.target, summary: a.text }),
    order: 'at',
  },
};
// 일부 필드만 바꿀 때 (patch) 쓰는 이름 변환
const PATCH_NAMES = {
  categoryId: 'category_id', recurringKey: 'recurring_key', startMonth: 'start_month', lastApplied: 'last_applied',
};
const patchOut = p => Object.fromEntries(Object.entries(p).map(([k, v]) => [PATCH_NAMES[k] || k, v]));

const must = ({ data, error }) => {
  if (error) throw new Error(error.message);
  return data;
};

// Supabase는 한 번에 최대 1000줄만 주므로 나눠서 모두 가져온다
async function fetchAll(table) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select('*').order(map[table].order, { ascending: true }).range(from, from + 999);
    const rows = must(await q);
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out.map(map[table].in);
}

export function createCloudStore() {
  let data = { settings: { names: { a: '나', b: '아내' } }, categories: [], transactions: [], budgets: {}, recurring: [], assets: [], activity: [] };
  let session = null;
  let member = null;     // { household_id, who }
  let household = null;  // { id, invite_code, names, budgets }
  let partnerJoined = false;
  let channel = null;
  const listeners = new Set();
  const emit = () => listeners.forEach(f => f());

  async function loadHousehold() {
    household = must(await sb.from('households').select('*').eq('id', member.household_id).single());
    data.settings = { names: household.names };
    data.budgets = household.budgets || {};
    const members = must(await sb.from('members').select('who'));
    partnerJoined = members.length >= 2;
  }
  async function loadTable(t) { data[t] = await fetchAll(t); }

  // 다른 폰에서 바꾸면 그 표만 다시 읽는다 (짧은 시간에 여러 번 와도 한 번만)
  const timers = {};
  const reloadSoon = t => {
    clearTimeout(timers[t]);
    timers[t] = setTimeout(async () => {
      try {
        if (t === 'households' || t === 'members') await loadHousehold(); else await loadTable(t);
        emit();
      } catch (e) { console.error(e); }
    }, 300);
  };

  function subscribe() {
    if (channel) sb.removeChannel(channel);
    const hid = member.household_id;
    channel = sb.channel(`household-${hid}`);
    for (const t of Object.keys(map)) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table: t, filter: `household_id=eq.${hid}` }, () => reloadSoon(t));
    }
    channel.on('postgres_changes', { event: '*', schema: 'public', table: 'households', filter: `id=eq.${hid}` }, () => reloadSoon('households'));
    channel.subscribe();
  }

  async function afterAuth() {
    store.status = 'loading';
    emit();
    if (!session) { member = null; store.status = 'signed-out'; return; }
    const rows = must(await sb.from('members').select('household_id, who').eq('user_id', session.user.id));
    member = rows[0] || null;
    if (!member) { store.status = 'no-household'; return; }
    await loadHousehold();
    await Promise.all(Object.keys(map).map(loadTable));
    subscribe();
    store.status = 'ready';
  }

  // 화면을 다시 켰을 때 (폰에서 앱을 다시 열 때) 최신으로
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && store.status === 'ready') {
      Promise.all([loadHousehold(), ...Object.keys(map).map(loadTable)]).then(emit).catch(console.error);
    }
  });

  const insert = async (t, obj) => {
    const row = must(await sb.from(t).insert(map[t].out(obj)).select().single());
    const item = map[t].in(row);
    data[t] = [...data[t], item];
    emit();
    return item;
  };
  const update = async (t, id, patch) => {
    const row = must(await sb.from(t).update(patchOut(patch)).eq('id', id).select().single());
    const item = map[t].in(row);
    data[t] = data[t].map(x => (x.id === id ? item : x));
    emit();
  };
  const remove = async (t, id) => {
    must(await sb.from(t).delete().eq('id', id));
    data[t] = data[t].filter(x => x.id !== id);
    emit();
  };
  const updateHousehold = async patch => {
    household = must(await sb.from('households').update(patch).eq('id', household.id).select().single());
    data.settings = { names: household.names };
    data.budgets = household.budgets || {};
    emit();
  };

  const store = {
    mode: 'cloud',
    status: 'loading',   // loading | signed-out | no-household | ready
    get data() { return data; },
    get me() { return member?.who; },
    get email() { return session?.user?.email || ''; },
    get inviteCode() { return household?.invite_code || ''; },
    get partnerJoined() { return partnerJoined; },
    subscribe(fn) { listeners.add(fn); },

    async init() {
      session = (await sb.auth.getSession()).data.session;
      await afterAuth();
      sb.auth.onAuthStateChange((_event, s) => {
        const changed = (s?.user?.id || null) !== (session?.user?.id || null);
        session = s;
        if (changed) afterAuth().then(emit, e => { console.error(e); emit(); });
      });
    },

    /* 로그인 */
    async signIn(email, password) {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw new Error(error.message.includes('Invalid login') ? '이메일이나 비밀번호가 맞지 않아요'
        : error.message.includes('not confirmed') ? '메일함에서 인증 링크를 먼저 눌러 주세요' : error.message);
    },
    async signUp(email, password) {
      const { data: d, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } });
      if (error) throw new Error(error.message.includes('already registered') ? '이미 가입된 이메일이에요. 로그인해 주세요' : error.message);
      return { needsConfirm: !d.session };
    },
    async signOut() {
      if (channel) sb.removeChannel(channel);
      await sb.auth.signOut();
    },
    async createHousehold() {
      must(await sb.rpc('create_household'));
      await afterAuth();
      emit();
    },
    async joinHousehold(code) {
      must(await sb.rpc('join_household', { code }));
      await afterAuth();
      emit();
    },

    /* 데이터 (store.js 와 같은 이름) */
    addTx: t => insert('transactions', t),
    updateTx: (id, patch) => update('transactions', id, patch),
    deleteTx: id => remove('transactions', id),

    addCategory: c => insert('categories', c),
    deleteCategory: id => remove('categories', id),

    setBudgets: budgets => updateHousehold({ budgets }),
    saveNames: names => updateHousehold({ names }),

    async addRecurring(r) { return insert('recurring', r); },
    updateRecurring: (id, patch) => update('recurring', id, patch),
    deleteRecurring: id => remove('recurring', id),

    addAsset: a => insert('assets', a),
    updateAsset: (id, patch) => update('assets', id, patch),
    deleteAsset: id => remove('assets', id),

    addActivity: a => insert('activity', a),

    // 이 폰의 푸시 알림 주소 저장 / 삭제
    async savePushSubscription(sub) {
      const json = sub.toJSON();
      must(await sb.from('push_subscriptions').upsert(
        { endpoint: json.endpoint, who: member.who, subscription: json },
        { onConflict: 'endpoint' },
      ));
    },
    async removePushSubscription(endpoint) {
      must(await sb.from('push_subscriptions').delete().eq('endpoint', endpoint));
    },

    // 고정 지출 자동 추가: 두 폰이 동시에 넣어도 한 번만 들어가게
    async addRecurringTx(t) {
      const { data: rows, error } = await sb.from('transactions')
        .upsert(map.transactions.out(t), { onConflict: 'household_id,recurring_key', ignoreDuplicates: true })
        .select();
      if (error) throw new Error(error.message);
      if (rows?.length) { data.transactions = [...data.transactions, ...rows.map(map.transactions.in)]; emit(); }
    },
  };
  return store;
}

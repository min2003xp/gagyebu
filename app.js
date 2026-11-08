import { createStore } from './store.js';
import { buildDigest, ACTION_LABEL, QUIET_MINUTES } from './digest.js';
import { SUPABASE_URL, VAPID_PUBLIC_KEY } from './config.js';

/* ---------- 작은 도우미들 ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const fmt = n => Math.round(n).toLocaleString('ko-KR');
const won = n => fmt(n) + '원';
const short = n => {
  const s = n < 0 ? '-' : '', a = Math.abs(n);
  if (a >= 1e8) return `${s}${(a / 1e8).toFixed(a >= 1e9 ? 0 : 1).replace(/\.0$/, '')}억`;
  if (a >= 1e4) return `${s}${Math.round(a / 1e4).toLocaleString('ko-KR')}만`;
  return fmt(n);
};
const monthKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const todayStr = () => { const d = new Date(); return `${monthKey(d)}-${pad(d.getDate())}`; };
const shiftMonth = (key, delta) => { const [y, m] = key.split('-').map(Number); return monthKey(new Date(y, m - 1 + delta, 1)); };
const daysInMonth = key => { const [y, m] = key.split('-').map(Number); return new Date(y, m, 0).getDate(); };
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
const PALETTE = ['#2f7d6d', '#d0573f', '#3f6fd0', '#d9962b', '#8a5cc7', '#3a9fb5', '#c4487f', '#6f8f2f', '#a0703a', '#5c6b7a', '#b5543a', '#4a8f6a', '#7a6fd0', '#c97a2f'];
const WHO = ['a', 'b'];
const KINDS = [
  ['cash', '💵', '입출금·현금'],
  ['saving', '🏦', '예금·적금'],
  ['invest', '📈', '주식·펀드'],
  ['pension', '🧓', '연금·보험'],
  ['realestate', '🏠', '부동산·보증금'],
  ['etc', '💎', '기타 자산'],
  ['debt', '💳', '대출·부채'],
];
const kindOf = k => KINDS.find(x => x[0] === k) || KINDS[5];

const lsGet = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

/* ---------- 상태 ---------- */
// 연결 정보가 있으면 두 폰 공유 저장소, 없으면 이 기기 전용 저장소
// (주소 끝에 ?local 을 붙이면 이 기기 전용으로 열린다: 테스트용)
const useCloud = SUPABASE_URL && !new URLSearchParams(location.search).has('local');
const store = useCloud ? (await import('./cloud-store.js')).createCloudStore() : createStore();
let current = monthKey(new Date());   // 보고 있는 달
let view = 'list';                    // 보고 있는 탭
let me = lsGet('gagyebu-me', 'a');    // 이 폰의 주인 (폰마다 따로 저장)
let budgetEditing = false;

const D = () => store.data;
const names = () => D().settings.names;
const cats = type => D().categories.filter(c => c.type === type);
const catById = id => (id === '__charge__' ? { id, name: '상품권 충전', emoji: '🎫', type: 'expense' }
  : D().categories.find(c => c.id === id) || { id, name: '삭제된 카테고리', emoji: '📦', type: 'expense' });
const catColor = id => { if (id === '__charge__') return '#8a5cc7'; const i = D().categories.findIndex(c => c.id === id); return i < 0 ? '#888888' : PALETTE[i % PALETTE.length]; };
const txOfMonth = key => D().transactions.filter(t => t.date.startsWith(key));
// 지출로 세는 규칙
//  - 상품권 '충전'은 지출 (실제 낸 돈 기준)
//  - 상품권으로 '사용'한 지출은 자동 제외 (충전 때 이미 셌으니까)
//  - '통계에서 제외' 체크한 내역도 제외
const isPrepaidUse = t => t.type === 'expense' && payById(t.paymentId)?.kind === 'prepaid';
const isSpend = t => t.type === 'charge' || (t.type === 'expense' && !t.excluded && !isPrepaidUse(t));
const spendAmount = t => (t.type === 'charge' ? (t.paidAmount || t.amount) : t.amount);
const sum = (list, type) => type === 'expense'
  ? list.filter(isSpend).reduce((a, t) => a + spendAmount(t), 0)
  : list.filter(t => t.type === type && !t.excluded).reduce((a, t) => a + t.amount, 0);
const CHARGE_CAT = '__charge__';   // 통계에서 충전을 묶어 보여줄 가짜 카테고리
const spendCat = t => (t.type === 'charge' ? CHARGE_CAT : t.categoryId);

/* ---------- 결제수단 ---------- */
const pays = () => D().payment_methods || [];
const payById = id => pays().find(p => p.id === id);
const payName = id => (id ? payById(id)?.name || '삭제된 결제수단' : '');
// 충전식 잔액 = 처음 잔액 + 충전 − 그 수단으로 쓴 돈 (date 까지)
function prepaidBalance(p, until = '9999-12-31') {
  let bal = p.initialBalance || 0;
  for (const t of D().transactions) {
    if (t.paymentId !== p.id || t.date > until) continue;
    if (t.type === 'charge') bal += t.amount;
    else if (t.type === 'expense') bal -= t.amount;
  }
  return bal;
}
// 자주 쓴 결제수단이 앞에 오도록
function paysByUse(kind) {
  const count = new Map();
  D().transactions.forEach(t => t.paymentId && count.set(t.paymentId, (count.get(t.paymentId) || 0) + 1));
  return pays().filter(p => !kind || p.kind === kind).sort((a, b) => (count.get(b.id) || 0) - (count.get(a.id) || 0));
}

// 그 달 기준 금액: 그 달에 입력한 값이 없으면 가장 최근에 입력한 값을 쓴다
function balanceAt(asset, key) {
  const months = Object.keys(asset.balances || {}).filter(k => k <= key).sort();
  const m = months[months.length - 1];
  return m ? { value: asset.balances[m], month: m } : null;
}
function netWorth(key) {
  let assets = 0, debts = 0, known = false;
  for (const a of D().assets) {
    const b = balanceAt(a, key);
    if (!b) continue;
    known = true;
    if (a.kind === 'debt') debts += b.value; else assets += b.value;
  }
  // 상품권 잔액도 자산 (그 달 말일 기준)
  const end = `${key}-31`;
  for (const p of pays()) {
    if (p.kind !== 'prepaid') continue;
    const bal = prepaidBalance(p, end);
    assets += bal;
    if (bal) known = true;
  }
  return { assets, debts, net: assets - debts, known };
}
const ownerName = o => (o === 'both' ? '공동' : names()[o] || '');

/* ---------- 변경 기록 (알림 재료) ---------- */
const txText = t => {
  if (t.type === 'charge') return `🎫 ${payName(t.paymentId)} 충전 +${won(t.amount)}`;
  const c = catById(t.categoryId);
  const pay = t.paymentId ? ` (${payName(t.paymentId)})` : '';
  return `${c.emoji} ${t.memo || c.name} ${t.type === 'expense' ? '-' : '+'}${won(t.amount)}${pay}`;
};
const log = (action, target, text) => store.addActivity({ at: Date.now(), by: me, action, target, text });
const other = () => (me === 'a' ? 'b' : 'a');
const seenKey = () => `gagyebu-seen-${me}`;
// 상대방이 바꾼 것 중 이 폰에서 아직 안 본 것
const unseen = () => {
  const since = Number(lsGet(seenKey(), 0));
  return D().activity.filter(i => i.by === other() && i.at > since);
};

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 1800);
}

/* ---------- 고정 지출·수입 자동 추가 ---------- */
let applying = false;
async function applyRecurring() {
  if (applying) return;
  applying = true;
  try {
    const now = todayStr();
    const nowKey = now.slice(0, 7);
    for (const r of [...D().recurring]) {
      let key = r.lastApplied ? shiftMonth(r.lastApplied, 1) : r.startMonth;
      let last = r.lastApplied;
      while (key <= nowKey) {
        const date = `${key}-${pad(Math.min(r.day, daysInMonth(key)))}`;
        if (date > now) break;
        await store.addRecurringTx({
          type: r.type, amount: r.amount, categoryId: r.categoryId, memo: r.memo, who: r.who,
          paymentId: r.paymentId ?? null, date, recurringKey: `${r.id}:${key}`,
        });
        last = key;
        key = shiftMonth(key, 1);
      }
      if (last !== r.lastApplied) await store.updateRecurring(r.id, { lastApplied: last });
    }
  } finally {
    applying = false;
  }
}

/* ---------- 화면 그리기 ---------- */
function render() {
  if (store.me) me = store.me;
  const gated = store.status !== 'ready';
  document.body.classList.toggle('gated', gated);
  if (gated) {
    $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-auth'));
    renderAuth();
    return;
  }
  const [y, m] = current.split('-');
  $('#month-label').textContent = `${y}년 ${Number(m)}월`;
  $('.topbar').classList.toggle('hidden', view === 'settings');
  $('#fab').hidden = view === 'settings' || view === 'assets';
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));
  $$('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  ({ list: renderList, stats: renderStats, budget: renderBudget, assets: renderAssets, settings: renderSettings })[view]();
}

function txRow(t) {
  if (t.type === 'charge') {
    // 충전 = 지출 (실제 낸 돈), 잔액은 충전 금액만큼 늘어남
    const sub = ['충전', names()[t.who], `잔액 +${won(t.amount)}`].filter(Boolean).map(esc).join(' · ');
    return `<button class="tx" data-id="${esc(t.id)}">
      <span class="dot" style="--c:#8a5cc7">🎫</span>
      <span class="tx-main"><b>${esc(t.memo || payName(t.paymentId) + ' 충전')}</b><small>${sub}</small></span>
      <span class="tx-amt expense">-${fmt(spendAmount(t))}</span>
    </button>`;
  }
  const c = catById(t.categoryId);
  const prepaid = isPrepaidUse(t);
  const tag = prepaid ? '상품권 사용(지출 제외)' : t.excluded ? '통계 제외' : '';
  const sub = [c.name, payName(t.paymentId), names()[t.who], t.recurringKey ? '고정' : '', tag]
    .filter(Boolean).map(esc).join(' · ');
  const cls = prepaid ? 'charge' : t.excluded ? 'excluded' : t.type;
  return `<button class="tx" data-id="${esc(t.id)}">
    <span class="dot" style="--c:${catColor(c.id)}">${esc(c.emoji)}</span>
    <span class="tx-main"><b>${esc(t.memo || c.name)}</b><small>${sub}</small></span>
    <span class="tx-amt ${cls}">${t.type === 'expense' ? '-' : '+'}${fmt(t.amount)}</span>
  </button>`;
}

function renderList() {
  const list = txOfMonth(current).sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0));
  const inc = sum(list, 'income');
  const exp = sum(list, 'expense');
  const news = unseen();
  let html = '';
  if (news.length) {
    const d = buildDigest(news, names()[other()]);
    html += `<button class="news-banner" data-act="open-news">
      <span style="font-size:22px">🔔</span>
      <span class="tx-main"><b>${esc(d.title)}</b><small>${esc(news[news.length - 1].text)}</small></span>
      <span class="go">보기</span>
    </button>`;
  }
  if (store.mode === 'cloud' && !store.partnerJoined) {
    html += `<button class="news-banner" data-act="go-settings">
      <span style="font-size:22px">💌</span>
      <span class="tx-main"><b>${esc(names()[other()])}님을 초대하세요</b><small>초대 코드: ${esc(store.inviteCode)}</small></span>
      <span class="go">방법</span>
    </button>`;
  }
  html += `<div class="summary card">
    <div><small>수입</small><b class="income">${won(inc)}</b></div>
    <div><small>지출</small><b class="expense">${won(exp)}</b></div>
    <div><small>남은 돈</small><b>${won(inc - exp)}</b></div>
  </div>`;

  if (!list.length) {
    html += `<div class="empty"><p>이번 달 내역이 아직 없어요.</p><p>오른쪽 아래 <b>+</b> 버튼으로 추가해 보세요.</p></div>`;
  }

  const groups = new Map();
  list.forEach(t => { if (!groups.has(t.date)) groups.set(t.date, []); groups.get(t.date).push(t); });
  for (const [date, items] of groups) {
    const d = new Date(date + 'T00:00');
    const dayExp = sum(items, 'expense');
    html += `<div class="day-head"><span>${d.getMonth() + 1}월 ${d.getDate()}일 ${WEEK[d.getDay()]}요일</span><span>${dayExp ? '-' + won(dayExp) : ''}</span></div>
      <div class="card">${items.map(txRow).join('')}</div>`;
  }
  $('#view-list').innerHTML = html;
}

function barRow(label, value, ratio, color, extra = '', cls = '', meta = '') {
  return `<div class="bar-row">
    <div class="bar-top"><span>${label}</span><span>${value}${extra ? `<small>${extra}</small>` : ''}</span></div>
    <div class="track"><span class="fill ${cls}" style="width:${Math.min(100, Math.max(0, ratio * 100)).toFixed(1)}%;--c:${color}"></span></div>
    ${meta}
  </div>`;
}

function renderStats() {
  const list = txOfMonth(current);
  const exp = sum(list, 'expense');
  const prevExp = sum(txOfMonth(shiftMonth(current, -1)), 'expense');

  let compare = '지난달 기록이 없어요';
  if (prevExp > 0) {
    const diff = exp - prevExp;
    const pct = Math.round(Math.abs(diff) / prevExp * 100);
    compare = diff === 0 ? '지난달과 똑같이 썼어요' : `지난달보다 ${won(Math.abs(diff))} ${diff > 0 ? '더' : '덜'} 썼어요 (${diff > 0 ? '+' : '-'}${pct}%)`;
  }

  const byCat = new Map();
  list.filter(isSpend).forEach(t => byCat.set(spendCat(t), (byCat.get(spendCat(t)) || 0) + spendAmount(t)));

  const byPay = new Map();
  list.filter(isSpend).forEach(t => { const k = t.paymentId || ''; byPay.set(k, (byPay.get(k) || 0) + spendAmount(t)); });
  const payRows = [...byPay].sort((a, b) => b[1] - a[1]);
  const payMax = payRows[0]?.[1] || 1;
  const catRows = [...byCat].sort((a, b) => b[1] - a[1]);
  const catMax = catRows[0]?.[1] || 1;

  const byWho = WHO.map(w => [w, list.filter(t => isSpend(t) && t.who === w).reduce((a, t) => a + spendAmount(t), 0)]);
  const whoMax = Math.max(1, ...byWho.map(x => x[1]));

  const months = Array.from({ length: 6 }, (_, i) => shiftMonth(current, i - 5)).map(k => [k, sum(txOfMonth(k), 'expense')]);
  const mMax = Math.max(1, ...months.map(x => x[1]));

  $('#view-stats').innerHTML = `
    <div class="card pad">
      <h3>이번 달 지출</h3>
      <div class="big-number">${won(exp)}</div>
      <div class="compare">${compare}</div>
    </div>

    <div class="card pad">
      <h3>카테고리별 지출</h3>
      ${catRows.length ? catRows.map(([id, v]) => {
        const c = catById(id);
        return barRow(`${esc(c.emoji)} ${esc(c.name)}`, won(v), v / catMax, catColor(id), `${Math.round(v / exp * 100)}%`);
      }).join('') : '<p class="muted">아직 지출 내역이 없어요.</p>'}
    </div>

    ${payRows.length ? `<div class="card pad">
      <h3>결제수단별 지출</h3>
      ${payRows.map(([id, v], i) => barRow(id ? `${payById(id)?.kind === 'prepaid' ? '🎫' : '💳'} ${esc(payName(id))}` : '❔ 선택 안 함',
        won(v), v / payMax, PALETTE[(i + 2) % PALETTE.length], `${Math.round(v / exp * 100)}%`)).join('')}
    </div>` : ''}

    <div class="card pad">
      <h3>누가 썼나요</h3>
      ${byWho.map(([w, v], i) => barRow(esc(names()[w]), won(v), v / whoMax, i ? '#c4487f' : '#3f6fd0', exp ? `${Math.round(v / exp * 100)}%` : '')).join('')}
    </div>

    <div class="card pad">
      <h3>최근 6개월 지출</h3>
      <div class="cols">
        ${months.map(([k, v]) => `<div class="col ${k === current ? 'now' : ''}">
          <span class="col-val">${v ? short(v) : ''}</span>
          <div class="col-bar" style="height:${(v / mMax * 100).toFixed(1)}%"></div>
          <small>${Number(k.slice(5))}월</small>
        </div>`).join('')}
      </div>
    </div>`;
}

function renderBudget() {
  const b = D().budgets;
  const list = txOfMonth(current);
  const exp = sum(list, 'expense');
  const expCats = cats('expense');
  const el = $('#view-budget');

  if (budgetEditing) {
    const input = (key, label) => `<label class="budget-input"><span>${label}</span>
      <input class="money" inputmode="numeric" data-budget="${esc(key)}" value="${b[key] ? fmt(b[key]) : ''}" placeholder="없음"><b>원</b></label>`;
    el.innerHTML = `<div class="card pad">
      <h3>월 예산 정하기</h3>
      <p class="muted">한 번 정하면 매달 똑같이 적용돼요. 비워두면 예산 없음이에요.</p>
      ${input('total', '💰 <b>전체 예산</b>')}
      ${expCats.map(c => input(c.id, `${esc(c.emoji)} ${esc(c.name)}`)).join('')}
      <div class="row-actions">
        <button class="btn" data-act="budget-cancel">취소</button>
        <button class="btn primary" data-act="budget-save">저장</button>
      </div>
    </div>`;
    return;
  }

  const status = r => (r > 1 ? 'over' : r >= 0.8 ? 'warn' : '');
  let html = '';

  if (b.total) {
    const remain = b.total - exp;
    const ratio = exp / b.total;
    let tip = '';
    if (current === monthKey(new Date())) {
      const daysLeft = daysInMonth(current) - new Date().getDate() + 1;
      tip = remain > 0
        ? `남은 ${daysLeft}일 동안 하루에 <b>${won(remain / daysLeft)}</b>씩 쓸 수 있어요.`
        : `이번 달 예산을 <b>${won(-remain)}</b> 넘었어요.`;
    }
    html += `<div class="card pad">
      <div class="budget-head"><h3>전체 예산</h3><span class="muted">${won(b.total)}</span></div>
      <div class="big-number ${remain < 0 ? 'expense' : ''}">${remain >= 0 ? `${won(remain)} 남음` : `${won(-remain)} 초과`}</div>
      <div class="track" style="margin-top:10px"><span class="fill ${status(ratio)}" style="width:${Math.min(100, ratio * 100).toFixed(1)}%"></span></div>
      <div class="budget-meta"><span>${won(exp)} 사용</span><span>${Math.round(ratio * 100)}%</span></div>
      ${tip ? `<div class="tip">${tip}</div>` : ''}
    </div>`;
  }

  const withBudget = expCats.filter(c => b[c.id] > 0);
  if (withBudget.length) {
    html += `<div class="card pad"><h3>카테고리별 예산</h3>
      ${withBudget.map(c => {
        const used = list.filter(t => isSpend(t) && t.categoryId === c.id).reduce((a, t) => a + t.amount, 0);
        const r = used / b[c.id];
        const left = b[c.id] - used;
        const meta = `<div class="budget-meta"><span>${won(used)} 사용 · ${Math.round(r * 100)}%</span><span class="${left < 0 ? 'expense' : ''}">${left >= 0 ? `${won(left)} 남음` : `${won(-left)} 초과`}</span></div>`;
        return barRow(`${esc(c.emoji)} ${esc(c.name)}`, won(b[c.id]), r, catColor(c.id), '', status(r), meta);
      }).join('')}
    </div>`;
  }

  if (!html) {
    html = `<div class="empty"><p>아직 예산이 없어요.</p><p>한 달에 얼마까지 쓸지 정해두면 남은 돈을 알려드려요.</p></div>`;
  }
  html += `<button class="btn primary block" data-act="budget-edit">${b.total || withBudget.length ? '예산 수정' : '예산 정하기'}</button>`;
  el.innerHTML = html;
}

function renderAssets() {
  const el = $('#view-assets');
  const list = D().assets;
  const mLabel = `${Number(current.slice(5))}월`;
  const monthEnd = `${current}-31`;

  // 상품권·선불카드 잔액 (충전 − 사용, 자동 계산)
  const prepaids = pays().filter(p => p.kind === 'prepaid').map(p => ({ p, bal: prepaidBalance(p, monthEnd) }));
  const prepaidTotal = prepaids.reduce((s, x) => s + x.bal, 0);
  const prepaidHtml = `
    ${prepaids.length ? `<div class="day-head"><span>🎫 상품권·선불 잔액</span><span>${won(prepaidTotal)}</span></div>
      <div class="card">${prepaids.map(({ p, bal }) => {
        const lastCharge = D().transactions.filter(t => t.type === 'charge' && t.paymentId === p.id).sort((a, b) => b.date.localeCompare(a.date))[0];
        const used = txOfMonth(current).filter(t => t.type === 'expense' && t.paymentId === p.id).reduce((s, t) => s + t.amount, 0);
        const sub = [`${mLabel} ${won(used)} 사용`, lastCharge ? `마지막 충전 ${Number(lastCharge.date.slice(5, 7))}/${Number(lastCharge.date.slice(8))}` : ''].filter(Boolean).join(' · ');
        return `<div class="prepaid-row">
          <span class="dot" style="--c:#8a5cc7">🎫</span>
          <span class="tx-main"><b>${esc(p.name)}</b><small>${esc(sub)}</small></span>
          <span class="tx-amt ${bal < 0 ? 'expense' : ''}">${fmt(bal)}원</span>
          <button class="btn small" data-act="charge" data-pay="${esc(p.id)}">충전</button>
        </div>`;
      }).join('')}</div>` : ''}
    <button class="btn block" data-act="add-prepaid" style="margin:0 0 14px">+ 상품권·선불카드 추가</button>`;

  if (!list.length && !prepaids.length) {
    el.innerHTML = `<div class="empty">
        <p>아직 등록한 자산이 없어요.</p>
        <p>통장, 적금, 주식, 보증금, 대출 등을 등록하면<br>우리 집 총 재산을 한눈에 볼 수 있어요.</p>
      </div>
      <button class="btn primary block" data-act="add-asset" style="margin-bottom:8px">+ 자산 추가</button>
      ${prepaidHtml}`;
    return;
  }

  const now = netWorth(current);
  const prev = netWorth(shiftMonth(current, -1));
  const monthTx = txOfMonth(current);
  const flow = sum(monthTx, 'income') - sum(monthTx, 'expense');

  let change = '';
  if (prev.known) {
    const diff = now.net - prev.net;
    change = diff === 0 ? '지난달과 같아요' : `지난달보다 <b class="${diff > 0 ? 'income' : 'expense'}">${diff > 0 ? '+' : '-'}${won(Math.abs(diff))}</b>`;
  }

  // 종류별 (부채 제외)
  let byKind = KINDS.filter(k => k[0] !== 'debt').map(([k, emoji, label]) => {
    const v = list.filter(a => a.kind === k).reduce((s, a) => s + (balanceAt(a, current)?.value || 0), 0);
    return { k, emoji, label, v };
  });
  byKind.push({ k: 'prepaid', emoji: '🎫', label: '상품권·선불', v: prepaidTotal });
  byKind = byKind.filter(x => x.v > 0).sort((a, b) => b.v - a.v);
  const kindColor = k => (k === 'prepaid' ? '#8a5cc7' : PALETTE[KINDS.findIndex(x => x[0] === k) % PALETTE.length]);

  // 누구 것 (순자산)
  const byOwner = ['a', 'b', 'both'].map(o => [o, list.filter(a => a.owner === o).reduce((s, a) => {
    const v = balanceAt(a, current)?.value || 0;
    return s + (a.kind === 'debt' ? -v : v);
  }, 0)]).filter(([o, v]) => v !== 0 || list.some(a => a.owner === o));
  const ownerMax = Math.max(1, ...byOwner.map(x => Math.abs(x[1])));

  const months = Array.from({ length: 6 }, (_, i) => shiftMonth(current, i - 5)).map(k => [k, netWorth(k)]);
  const mMax = Math.max(1, ...months.map(([, w]) => Math.max(0, w.net)));

  const stale = list.filter(a => { const b = balanceAt(a, current); return !b || b.month !== current; });

  const row = a => {
    const b = balanceAt(a, current);
    const [, emoji, label] = kindOf(a.kind);
    const note = !b ? `${mLabel} 금액 없음` : b.month !== current ? `${Number(b.month.slice(5))}월 금액` : '';
    return `<button class="tx" data-asset="${esc(a.id)}">
      <span class="dot" style="--c:${kindColor(a.kind)}">${emoji}</span>
      <span class="tx-main"><b>${esc(a.name)}</b><small>${esc(label)} · ${esc(ownerName(a.owner))}${note ? ` · <span class="stale">${note}</span>` : ''}</small></span>
      <span class="tx-amt ${a.kind === 'debt' ? 'expense' : ''}">${b ? (a.kind === 'debt' ? '-' : '') + fmt(b.value) : '-'}</span>
    </button>`;
  };
  const assetList = list.filter(a => a.kind !== 'debt');
  const debtList = list.filter(a => a.kind === 'debt');

  el.innerHTML = `
    <div class="card pad">
      <h3>${mLabel} 우리 집 총 재산</h3>
      <div class="big-number ${now.net < 0 ? 'expense' : ''}">${now.net < 0 ? '-' : ''}${won(Math.abs(now.net))}</div>
      ${change ? `<div class="compare">${change}</div>` : ''}
      <div class="net-split">
        <div><small>자산</small><b>${won(now.assets)}</b></div>
        <div><small>부채</small><b class="expense">${now.debts ? '-' : ''}${won(now.debts)}</b></div>
        <div><small>이번 달 수입−지출</small><b class="${flow >= 0 ? 'income' : 'expense'}">${flow >= 0 ? '+' : '-'}${won(Math.abs(flow))}</b></div>
      </div>
      ${stale.length ? `<div class="tip">${stale.length}개 항목에 ${mLabel} 금액이 아직 없어요. 아래 목록에서 눌러서 업데이트해 주세요.</div>` : ''}
    </div>

    ${assetList.length ? `<div class="day-head"><span>자산</span><span>${won(now.assets - prepaidTotal)}</span></div>
      <div class="card">${assetList.map(row).join('')}</div>` : ''}
    ${debtList.length ? `<div class="day-head"><span>대출·부채</span><span>-${won(now.debts)}</span></div>
      <div class="card">${debtList.map(row).join('')}</div>` : ''}
    <button class="btn primary block" data-act="add-asset" style="margin-bottom:14px">+ 자산 추가</button>
    ${prepaidHtml}

    ${byKind.length ? `<div class="card pad"><h3>종류별 자산</h3>
      ${byKind.map(x => barRow(`${x.emoji} ${esc(x.label)}`, won(x.v), x.v / byKind[0].v, kindColor(x.k), `${Math.round(x.v / now.assets * 100)}%`)).join('')}
    </div>` : ''}

    ${byOwner.length ? `<div class="card pad"><h3>누구 재산인가요</h3>
      ${byOwner.map(([o, v]) => barRow(esc(ownerName(o)), `${v < 0 ? '-' : ''}${won(Math.abs(v))}`, Math.abs(v) / ownerMax, ['#3f6fd0', '#c4487f', '#2f7d6d'][['a', 'b', 'both'].indexOf(o)], '', v < 0 ? 'over' : '')).join('')}
    </div>` : ''}

    <div class="card pad">
      <h3>최근 6개월 총 재산</h3>
      <div class="cols">
        ${months.map(([k, w]) => `<div class="col ${k === current ? 'now' : ''}">
          <span class="col-val">${w.known ? short(w.net) : ''}</span>
          <div class="col-bar" style="height:${(Math.max(0, w.net) / mMax * 100).toFixed(1)}%"></div>
          <small>${Number(k.slice(5))}월</small>
        </div>`).join('')}
      </div>
      <p class="muted" style="margin-bottom:0">매달 한 번씩 금액만 업데이트하면 재산이 어떻게 변하는지 볼 수 있어요.</p>
    </div>`;
}

/* ---------- 이 폰에서 푸시 알림 받기 ---------- */
// unsupported | ios-browser | denied | on | off | busy
let pushState = 'off';
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

async function refreshPushState() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    pushState = isIOS && !isStandalone ? 'ios-browser' : 'unsupported';
  } else if (Notification.permission === 'denied') {
    pushState = 'denied';
  } else {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && await reg.pushManager.getSubscription();
    pushState = sub && Notification.permission === 'granted' ? 'on' : 'off';
    // 다시 로그인했을 때 등을 대비해 서버에도 다시 저장
    if (sub && pushState === 'on' && store.status === 'ready') store.savePushSubscription(sub).catch(console.error);
  }
  if (view === 'settings') render();
}

function pushBlock() {
  const partner = esc(names()[other()]);
  const msg = {
    'ios-browser': `아이폰은 Safari에서 <b>공유 → 홈 화면에 추가</b>로 설치한 앱을 열어야 알림을 켤 수 있어요.`,
    unsupported: '이 브라우저에서는 알림을 받을 수 없어요. 폰에 설치한 앱에서 켜 주세요.',
    denied: '알림이 차단돼 있어요. 폰 <b>설정 → 알림</b>에서 가계부 알림을 허용해 주세요.',
    on: `✅ 이 폰에서 ${partner}의 변경 알림을 받고 있어요.`,
    off: `이 폰에서 ${partner}의 변경 알림을 받으려면 켜 주세요.`,
    busy: '설정하는 중…',
  }[pushState];
  const btn = pushState === 'on' ? `<button class="btn block" data-act="push-off">이 폰 알림 끄기</button>`
    : pushState === 'off' ? `<button class="btn primary block" data-act="push-on">🔔 이 폰에서 알림 받기</button>` : '';
  return `<div class="tip" style="margin-top:12px">${msg}</div>${btn}`;
}

const b64ToBytes = s => {
  const b = atob((s + '='.repeat((4 - s.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, c => c.charCodeAt(0));
};

async function pushOn() {
  pushState = 'busy'; render();
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { await refreshPushState(); return toast('알림이 허용되지 않았어요'); }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription()
      || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(VAPID_PUBLIC_KEY) });
    await store.savePushSubscription(sub);
    toast('알림을 켰어요');
  } catch (err) {
    console.error(err);
    toast('알림을 켜지 못했어요: ' + err.message);
  }
  await refreshPushState();
}

async function pushOff() {
  pushState = 'busy'; render();
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && await reg.pushManager.getSubscription();
    if (sub) { await store.removePushSubscription(sub.endpoint); await sub.unsubscribe(); }
    toast('이 폰 알림을 껐어요');
  } catch (err) {
    toast('알림을 끄지 못했어요: ' + err.message);
  }
  await refreshPushState();
}

function renderAuth() {
  const s = store.status;
  let html;
  if (s === 'signed-out') {
    html = `<div class="auth">
      <div class="auth-logo">📒</div>
      <h2>우리집 가계부</h2>
      <p class="muted">둘이 함께 쓰는 가계부예요. 로그인해 주세요.</p>
      <form id="auth-form" class="card pad" novalidate>
        <label class="field"><span class="field-label">이메일</span>
          <input id="auth-email" type="email" autocomplete="email" inputmode="email"></label>
        <label class="field"><span class="field-label">비밀번호 (6자 이상)</span>
          <input id="auth-pw" type="password" autocomplete="current-password"></label>
        <button type="submit" class="btn primary block">로그인</button>
        <button type="button" class="btn block" data-auth="signup">처음이에요 (회원가입)</button>
        <p id="auth-msg" class="muted" style="margin-bottom:0"></p>
      </form>
    </div>`;
  } else if (s === 'no-household') {
    html = `<div class="auth">
      <h2>가계부 연결하기</h2>
      <p class="muted">${esc(store.email)} 로 로그인했어요.</p>
      <div class="card pad">
        <h3>먼저 시작하는 사람</h3>
        <p class="muted">새 가계부를 만들면 초대 코드가 나와요. 그 코드를 상대방에게 알려주세요.</p>
        <button class="btn primary block" data-act="create-household">새 가계부 만들기</button>
      </div>
      <div class="card pad">
        <h3>초대 코드를 받은 사람</h3>
        <input id="join-code" maxlength="6" placeholder="예: A1B2C3" autocapitalize="characters" autocomplete="off" style="margin-top:10px;text-transform:uppercase;letter-spacing:.2em">
        <button class="btn primary block" data-act="join-household">들어가기</button>
      </div>
      <button class="btn block" data-act="sign-out">다른 계정으로 로그인</button>
    </div>`;
  } else {
    html = `<div class="empty"><p>불러오는 중…</p></div>`;
  }
  $('#view-auth').innerHTML = html;
}

document.addEventListener('submit', async e => {
  if (e.target.id !== 'auth-form') return;
  e.preventDefault();
  await doAuth('signin');
});
async function doAuth(kind) {
  const email = $('#auth-email').value.trim();
  const pw = $('#auth-pw').value;
  const msg = $('#auth-msg');
  if (!email.includes('@')) { msg.textContent = '이메일을 확인해 주세요'; return; }
  if (pw.length < 6) { msg.textContent = '비밀번호는 6자 이상이에요'; return; }
  msg.textContent = kind === 'signup' ? '가입하는 중…' : '로그인하는 중…';
  try {
    if (kind === 'signup') {
      const { needsConfirm } = await store.signUp(email, pw);
      if (needsConfirm) msg.innerHTML = `<b>${esc(email)}</b> 메일함에 인증 메일을 보냈어요.<br>메일의 링크를 누른 뒤, 여기로 돌아와 <b>로그인</b>을 눌러 주세요.`;
    } else {
      await store.signIn(email, pw);
    }
  } catch (err) {
    msg.textContent = err.message;
  }
}

function renderSettings() {
  const n = names();
  const rec = D().recurring;
  const chips = type => cats(type).map(c =>
    `<span class="chip">${esc(c.emoji)} ${esc(c.name)}<button class="x" data-act="del-cat" data-id="${esc(c.id)}" aria-label="${esc(c.name)} 삭제">×</button></span>`
  ).join('') + `<button class="chip add" data-act="add-cat" data-type="${type}">+ 추가</button>`;

  $('#view-settings').innerHTML = `
    <h2 class="view-title">설정</h2>

    ${store.mode === 'cloud' ? `<div class="card pad">
      <h3>👫 함께 쓰기</h3>
      ${store.partnerJoined
        ? `<p class="muted">${esc(n.a)}, ${esc(n.b)} 두 사람이 함께 쓰고 있어요.</p>`
        : `<p class="muted">상대방이 이 앱에서 회원가입한 뒤 아래 초대 코드를 넣으면 연결돼요.</p>
           <div class="invite">${esc(store.inviteCode)}</div>`}
      <p class="muted">로그인: ${esc(store.email)} (${esc(n[me])})</p>
      <button class="btn block" data-act="sign-out">로그아웃</button>
    </div>` : `<div class="card pad">
      <h3>이 폰은 누구 폰인가요?</h3>
      <p class="muted">내역을 추가할 때 이 사람이 기본으로 선택돼요.</p>
      <div class="seg">${WHO.map(w => `<button data-act="set-me" data-who="${w}" class="${me === w ? 'active' : ''}">${esc(n[w])}</button>`).join('')}</div>
    </div>`}

    <div class="card pad">
      <h3>🔔 변경 알림</h3>
      <p class="muted">내가 내역을 추가·수정·삭제하면 바로 알리지 않고 모아 두었다가,
        <b>마지막으로 바꾼 뒤 ${QUIET_MINUTES}분 동안 더 바뀐 게 없으면</b> ${esc(n[other()])}에게 요약 알림을 한 번만 보내요.</p>
      ${(() => {
        const mine = D().activity.filter(i => i.by === me && !i.notifiedAt);
        if (!mine.length) return `<div class="preview muted" style="margin:0">아직 보낼 변경 내용이 없어요.</div>`;
        const d = buildDigest(mine, n[me]);
        return `<div class="preview"><b>${esc(n[other()])}에게 갈 알림 미리보기</b>${esc(d.title)}\n${esc(d.body)}</div>`;
      })()}
      ${store.mode === 'cloud' ? pushBlock() : '<p class="muted" style="margin-bottom:0">⚠️ 실제 폰 알림은 두 폰 공유를 연결한 뒤에 켤 수 있어요.</p>'}
      <button class="btn block" data-act="open-news">최근 변경 기록 보기</button>
    </div>

    <div class="card pad">
      <h3>이름</h3>
      <div class="name-row">
        <input id="name-a" value="${esc(n.a)}" maxlength="10" aria-label="첫 번째 사람 이름">
        <input id="name-b" value="${esc(n.b)}" maxlength="10" aria-label="두 번째 사람 이름">
        <button class="btn" data-act="save-names">저장</button>
      </div>
    </div>

    <div class="card pad">
      <div class="card-head"><h3>매달 고정 지출·수입</h3><button class="btn small" data-act="add-recurring">+ 추가</button></div>
      <p class="muted">월세, 통신비, 월급처럼 매달 같은 날 생기는 돈을 등록하면 그날 자동으로 내역에 들어가요.</p>
      ${rec.length ? `<div class="card" style="box-shadow:none;border:1px solid var(--line);margin:0">${rec.map(r => {
        const c = catById(r.categoryId);
        return `<div class="rec-row">
          <span class="dot" style="--c:${catColor(c.id)}">${esc(c.emoji)}</span>
          <span class="tx-main"><b>${esc(r.memo || c.name)}</b><small>매달 ${r.day}일 · ${esc(n[r.who])}</small></span>
          <span class="tx-amt ${r.type}">${r.type === 'expense' ? '-' : '+'}${fmt(r.amount)}</span>
          <button class="icon-btn" data-act="del-recurring" data-id="${esc(r.id)}" aria-label="삭제">✕</button>
        </div>`;
      }).join('')}</div>` : ''}
    </div>

    <div class="card pad">
      <h3>결제수단</h3>
      <p class="muted">🎫 표시는 충전해서 쓰는 상품권·선불카드예요. 잔액은 자산 탭에서 볼 수 있어요.</p>
      <div class="chips">${pays().map(p =>
        `<span class="chip">${p.kind === 'prepaid' ? '🎫' : '💳'} ${esc(p.name)}<button class="x" data-act="del-pay" data-id="${esc(p.id)}" aria-label="${esc(p.name)} 삭제">×</button></span>`
      ).join('')}<button class="chip add" data-act="add-pay">+ 추가</button></div>
    </div>

    <div class="card pad">
      <h3>카테고리</h3>
      <h4>지출</h4><div class="chips">${chips('expense')}</div>
      <h4>수입</h4><div class="chips">${chips('income')}</div>
    </div>

    <div class="card pad">
      <h3>데이터</h3>
      <p class="muted">${store.mode === 'local'
        ? '지금은 이 기기에만 저장돼요. 다음 단계에서 두 폰이 같은 데이터를 보도록 연결할 거예요.'
        : '두 폰이 같은 데이터를 함께 보고 있어요.'}</p>
      <button class="btn" data-act="export-csv">엑셀용 파일(CSV)로 내보내기</button>
    </div>`;
}

/* ---------- 내역 입력 시트 ---------- */
const dlg = $('#tx-dialog');
let form = null;

$('#tx-day').innerHTML = Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}">${i + 1}일</option>`).join('');

function openTx({ mode = 'tx', tx = null, type = null, paymentId = null } = {}) {
  form = {
    mode, id: tx?.id || null, type: tx?.type || type || 'expense', categoryId: tx?.categoryId || null, who: tx?.who || me,
    paymentId: tx?.paymentId || paymentId || null,
  };
  $('#tx-title').textContent = mode === 'recurring' ? '고정 지출·수입 추가' : tx ? '내역 수정' : '내역 추가';
  $('#tx-amount').value = tx ? fmt(tx.amount) : '';
  $('#tx-memo').value = tx?.memo || '';
  $('#tx-paid').value = tx?.paidAmount ? fmt(tx.paidAmount) : '';
  $('#tx-excluded').checked = !!tx?.excluded;
  $('#seg-charge').hidden = mode === 'recurring';
  $('#tx-date').value = tx?.date || (current === monthKey(new Date()) ? todayStr() : `${current}-01`);
  $('#tx-day').value = String(new Date().getDate());
  $('#field-date').hidden = mode === 'recurring';
  $('#field-day').hidden = mode !== 'recurring';
  $('#tx-delete').hidden = !form.id;
  renderForm();
  dlg.showModal();
  if (!tx) $('#tx-amount').focus();
}

function renderForm() {
  const charge = form.type === 'charge';
  $$('#tx-type button').forEach(b => b.classList.toggle('active', b.dataset.type === form.type));
  $('#charge-hint').hidden = !charge;
  $('#field-cat').hidden = charge;
  $('#field-paid').hidden = !charge;
  $('#field-pay').hidden = form.type === 'income';
  const prepaidUse = form.type === 'expense' && payById(form.paymentId)?.kind === 'prepaid';
  $('#prepaid-hint').hidden = !prepaidUse;
  $('#field-excluded').hidden = charge || prepaidUse;

  if (!charge) {
    const list = cats(form.type);
    if (!list.some(c => c.id === form.categoryId)) form.categoryId = list[0]?.id || null;
    $('#tx-cats').innerHTML = list.map(c =>
      `<button type="button" class="chip ${c.id === form.categoryId ? 'active' : ''}" data-cat="${esc(c.id)}">${esc(c.emoji)} ${esc(c.name)}</button>`
    ).join('');
  }

  // 결제수단: 충전일 땐 충전식만, 지출일 땐 전부 (자주 쓴 순서)
  const payList = paysByUse(charge ? 'prepaid' : null);
  if (charge && !payList.some(p => p.id === form.paymentId)) form.paymentId = payList[0]?.id || null;
  $('#pay-label').textContent = charge ? '어디에 충전했나요?' : '결제수단 (다시 누르면 선택 해제)';
  $('#tx-pays').innerHTML = payList.map(p => {
    const bal = p.kind === 'prepaid' ? ` <span class="bal">${fmt(prepaidBalance(p))}원</span>` : '';
    return `<button type="button" class="chip ${p.id === form.paymentId ? 'active' : ''}" data-pay="${esc(p.id)}">${p.kind === 'prepaid' ? '🎫' : '💳'} ${esc(p.name)}${bal}</button>`;
  }).join('') + `<button type="button" class="chip add" data-addpay="${charge ? 'prepaid' : ''}">+ ${charge ? '상품권 추가' : '새 결제수단'}</button>`;
  $('#tx-who').innerHTML = WHO.map(w => `<button type="button" data-who="${w}" class="${form.who === w ? 'active' : ''}">${esc(names()[w])}</button>`).join('');
}

dlg.addEventListener('click', e => {
  if (e.target === dlg) return dlg.close();          // 바깥 어두운 부분을 누르면 닫기
  const t = e.target.closest('button');
  if (!t) return;
  if (t.hasAttribute('data-close')) return dlg.close();
  if (t.dataset.type) { form.type = t.dataset.type; renderForm(); }
  else if (t.dataset.cat) { form.categoryId = t.dataset.cat; renderForm(); }
  else if (t.dataset.who) { form.who = t.dataset.who; renderForm(); }
  else if (t.dataset.pay) {
    // 지출일 땐 다시 누르면 선택 해제
    form.paymentId = form.paymentId === t.dataset.pay && form.type !== 'charge' ? null : t.dataset.pay;
    renderForm();
  }
  else if (t.hasAttribute('data-addpay')) {
    addPaymentMethod(t.dataset.addpay || null).then(p => { if (p) { form.paymentId = p.id; renderForm(); } });
  }
});

// 새 결제수단 등록 (kind 를 정해서 부르면 묻지 않는다)
async function addPaymentMethod(kind = null) {
  const name = prompt(kind === 'prepaid'
    ? '상품권·선불카드 이름을 입력하세요.\n(예: 성남사랑상품권, 온누리상품권)'
    : '결제수단 이름을 입력하세요.\n(예: 현대카드, 하나카드, 현금, 성남사랑상품권)');
  if (!name || !name.trim()) return null;
  const clean = name.trim().slice(0, 20);
  if (pays().some(p => p.name === clean)) { toast('이미 있는 이름이에요'); return pays().find(p => p.name === clean); }
  const k = kind || (confirm(`'${clean}'은(는) 충전해서 쓰는 상품권·선불카드인가요?\n\n확인 = 충전식 (잔액 관리)\n취소 = 일반 카드·현금`) ? 'prepaid' : 'card');
  let initialBalance = 0;
  if (k === 'prepaid') {
    const v = prompt(`'${clean}'에 지금 남아 있는 잔액이 있으면 입력하세요.\n(없으면 0, 앞으로 '충전'으로 기록하면 돼요)`, '0');
    initialBalance = Number(String(v || '0').replace(/\D/g, '')) || 0;
  }
  try {
    const p = await store.addPaymentMethod({ name: clean, kind: k, initialBalance });
    await log('add', 'payment', `${k === 'prepaid' ? '🎫' : '💳'} 결제수단 ${clean}${initialBalance ? ` (잔액 ${won(initialBalance)})` : ''}`);
    toast('결제수단을 추가했어요');
    return p;
  } catch (err) {
    toast('추가하지 못했어요: ' + err.message);
    return null;
  }
}

$('#tx-form').addEventListener('submit', async e => {
  e.preventDefault();
  const amount = Number($('#tx-amount').value.replace(/\D/g, ''));
  if (!amount) return toast('금액을 입력해 주세요');
  const charge = form.type === 'charge';
  if (charge && !form.paymentId) return toast('충전한 상품권을 골라 주세요');
  if (!charge && !form.categoryId) return toast('카테고리를 골라 주세요');
  const paid = Number($('#tx-paid').value.replace(/\D/g, ''));
  const base = {
    type: form.type, amount, who: form.who, memo: $('#tx-memo').value.trim(),
    categoryId: charge ? null : form.categoryId,
    paymentId: form.type === 'income' ? null : form.paymentId,
    // 상품권 사용은 규칙으로 자동 제외되므로 체크값은 저장하지 않는다
    excluded: charge || (form.type === 'expense' && payById(form.paymentId)?.kind === 'prepaid') ? false : $('#tx-excluded').checked,
    paidAmount: charge && paid && paid !== amount ? paid : null,
  };

  try {
    if (form.mode === 'recurring') {
      const { type, amount: amt, who, memo, categoryId, paymentId } = base;
      await store.addRecurring({ type, amount: amt, who, memo, categoryId, paymentId, day: Number($('#tx-day').value), startMonth: monthKey(new Date()), lastApplied: null });
      await log('add', 'recurring', `고정 항목 ${txText(base)} (매달 ${$('#tx-day').value}일)`);
      await applyRecurring();
      toast('고정 항목을 등록했어요');
    } else {
      const date = $('#tx-date').value || todayStr();
      if (form.id) {
        const old = D().transactions.find(t => t.id === form.id);
        await store.updateTx(form.id, { ...base, date });
        await log('update', 'tx', txText(base) + (old && old.amount !== amount ? ` (원래 ${won(old.amount)})` : ''));
        toast('수정했어요');
      } else {
        await store.addTx({ ...base, date });
        await log('add', 'tx', txText(base));
        toast('저장했어요');
      }
      if (date.slice(0, 7) !== current) { current = date.slice(0, 7); render(); }
    }
    dlg.close();
  } catch (err) {
    toast('저장하지 못했어요: ' + err.message);
  }
});

$('#tx-delete').addEventListener('click', async () => {
  if (!form.id || !confirm('이 내역을 삭제할까요?')) return;
  const old = D().transactions.find(t => t.id === form.id);
  await store.deleteTx(form.id);
  if (old) await log('delete', 'tx', txText(old));
  dlg.close();
  toast('삭제했어요');
});

/* ---------- 자산 입력 시트 ---------- */
const adlg = $('#asset-dialog');
let aform = null;

function openAsset(asset = null) {
  aform = { id: asset?.id || null, kind: asset?.kind || 'saving', owner: asset?.owner || 'both' };
  const b = asset ? balanceAt(asset, current) : null;
  $('#asset-title').textContent = asset ? '자산 수정' : '자산 추가';
  $('#asset-name').value = asset?.name || '';
  $('#asset-balance').value = b ? fmt(b.value) : '';
  $('#asset-delete').hidden = !asset;
  renderAssetForm();
  adlg.showModal();
  if (!asset) $('#asset-name').focus();
}

function renderAssetForm() {
  $('#asset-kinds').innerHTML = KINDS.map(([k, emoji, label]) =>
    `<button type="button" class="chip ${k === aform.kind ? 'active' : ''}" data-kind="${k}">${emoji} ${esc(label)}</button>`).join('');
  $('#asset-owner').innerHTML = ['a', 'b', 'both'].map(o =>
    `<button type="button" data-owner="${o}" class="${aform.owner === o ? 'active' : ''}">${esc(ownerName(o))}</button>`).join('');
  $('#asset-balance-label').textContent =
    `${Number(current.slice(5))}월 기준 ${aform.kind === 'debt' ? '남은 대출 금액' : '금액'}`;
}

adlg.addEventListener('click', e => {
  if (e.target === adlg) return adlg.close();
  const t = e.target.closest('button');
  if (!t) return;
  if (t.hasAttribute('data-close')) return adlg.close();
  if (t.dataset.kind) { aform.kind = t.dataset.kind; renderAssetForm(); }
  else if (t.dataset.owner) { aform.owner = t.dataset.owner; renderAssetForm(); }
});

$('#asset-form').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('#asset-name').value.trim();
  if (!name) return toast('이름을 입력해 주세요');
  const raw = $('#asset-balance').value.replace(/\D/g, '');
  if (raw === '') return toast('금액을 입력해 주세요');
  const value = Number(raw);
  try {
    if (aform.id) {
      const old = D().assets.find(a => a.id === aform.id);
      const before = old ? balanceAt(old, current)?.value : undefined;
      await store.updateAsset(aform.id, { name, kind: aform.kind, owner: aform.owner, balances: { ...(old?.balances || {}), [current]: value } });
      await log('update', 'asset', `💎 ${name} ${won(value)}` + (before !== undefined && before !== value ? ` (원래 ${won(before)})` : ''));
      toast('업데이트했어요');
    } else {
      await store.addAsset({ name, kind: aform.kind, owner: aform.owner, balances: { [current]: value } });
      await log('add', 'asset', `💎 ${name} ${won(value)}`);
      toast('자산을 추가했어요');
    }
    adlg.close();
  } catch (err) {
    toast('저장하지 못했어요: ' + err.message);
  }
});

$('#asset-delete').addEventListener('click', async () => {
  if (!aform.id || !confirm('이 자산을 삭제할까요?\n지난 달 기록도 함께 지워져요.')) return;
  const old = D().assets.find(a => a.id === aform.id);
  await store.deleteAsset(aform.id);
  if (old) await log('delete', 'asset', `💎 ${old.name}`);
  adlg.close();
  toast('삭제했어요');
});

$('#view-assets').addEventListener('click', e => {
  const row = e.target.closest('[data-asset]');
  if (!row) return;
  const a = D().assets.find(x => x.id === row.dataset.asset);
  if (a) openAsset(a);
});

/* ---------- 변경 기록 시트 ---------- */
const ndlg = $('#news-dialog');
function openNews() {
  const since = Number(lsGet(seenKey(), 0));
  const items = [...D().activity].sort((a, b) => b.at - a.at).slice(0, 60);
  let html = '';
  let lastDay = '';
  for (const i of items) {
    const d = new Date(i.at);
    const day = `${d.getMonth() + 1}월 ${d.getDate()}일 ${WEEK[d.getDay()]}요일`;
    if (day !== lastDay) { html += `<div class="day-head"><span>${day}</span></div>`; lastDay = day; }
    const isNew = i.by !== me && i.at > since;
    html += `<div class="news-item ${isNew ? 'new' : ''}">
      <span class="who-tag">${esc(names()[i.by])}</span>
      <span class="tx-main"><b>${ACTION_LABEL[i.action]} · ${esc(i.text)}</b><small>${pad(d.getHours())}:${pad(d.getMinutes())}${isNew ? ' · 새 소식' : ''}</small></span>
    </div>`;
  }
  $('#news-list').innerHTML = html || '<p class="muted">아직 변경 기록이 없어요.</p>';
  ndlg.showModal();
  lsSet(seenKey(), String(Date.now()));   // 열어 본 순간 '읽음'
}
ndlg.addEventListener('click', e => {
  if (e.target === ndlg || e.target.closest('[data-close]')) ndlg.close();
});
ndlg.addEventListener('close', render);

/* ---------- 버튼 동작 ---------- */
$('#prev-month').addEventListener('click', () => { current = shiftMonth(current, -1); render(); });
$('#next-month').addEventListener('click', () => { current = shiftMonth(current, 1); render(); });
$('#fab').addEventListener('click', () => openTx());

$$('.tabbar button').forEach(b => b.addEventListener('click', () => {
  view = b.dataset.view;
  budgetEditing = false;
  render();
  window.scrollTo(0, 0);
}));

$('#view-list').addEventListener('click', e => {
  const row = e.target.closest('.tx');
  if (!row) return;
  const tx = D().transactions.find(t => t.id === row.dataset.id);
  if (tx) openTx({ tx });
});

// 금액 입력칸: 입력하는 동안 세 자리마다 쉼표
document.addEventListener('input', e => {
  if (!e.target.classList.contains('money')) return;
  const digits = e.target.value.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 12);
  e.target.value = digits ? Number(digits).toLocaleString('ko-KR') : '';
});

document.addEventListener('click', async e => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;

  if (act === 'budget-edit') { budgetEditing = true; render(); }
  else if (act === 'budget-cancel') { budgetEditing = false; render(); }
  else if (act === 'budget-save') {
    const budgets = {};
    $$('[data-budget]').forEach(i => { const v = Number(i.value.replace(/\D/g, '')); if (v > 0) budgets[i.dataset.budget] = v; });
    budgetEditing = false;
    await store.setBudgets(budgets);
    await log('update', 'budget', `🎯 월 예산${budgets.total ? ` (전체 ${won(budgets.total)})` : ''}`);
    toast('예산을 저장했어요');
  }
  else if (act === 'set-me') {
    me = btn.dataset.who;
    lsSet('gagyebu-me', me);
    render();
  }
  else if (act === 'save-names') {
    const a = $('#name-a').value.trim() || '나';
    const b = $('#name-b').value.trim() || '아내';
    await store.saveNames({ a, b });
    toast('이름을 저장했어요');
  }
  else if (act === 'add-recurring') openTx({ mode: 'recurring' });
  else if (act === 'add-asset') openAsset();
  else if (act === 'open-news') openNews();
  else if (act === 'charge') openTx({ type: 'charge', paymentId: btn.dataset.pay });
  else if (act === 'add-prepaid') addPaymentMethod('prepaid');
  else if (act === 'add-pay') addPaymentMethod();
  else if (act === 'del-pay') {
    const p = payById(btn.dataset.id);
    if (p && confirm(`'${p.name}' 결제수단을 삭제할까요?\n이미 적은 내역은 지워지지 않아요.`)) {
      await store.deletePaymentMethod(p.id);
      await log('delete', 'payment', `결제수단 ${p.name}`);
    }
  }
  else if (act === 'push-on') pushOn();
  else if (act === 'push-off') pushOff();
  else if (act === 'go-settings') { view = 'settings'; render(); window.scrollTo(0, 0); }
  else if (act === 'sign-out') { if (confirm('로그아웃할까요?')) await store.signOut(); }
  else if (act === 'create-household') {
    btn.disabled = true;
    try { await store.createHousehold(); toast('새 가계부를 만들었어요'); }
    catch (err) { toast(err.message); btn.disabled = false; }
  }
  else if (act === 'join-household') {
    const code = $('#join-code').value.trim();
    if (code.length < 6) return toast('초대 코드 6자리를 넣어 주세요');
    btn.disabled = true;
    try { await store.joinHousehold(code); toast('연결됐어요!'); }
    catch (err) { toast(err.message); btn.disabled = false; }
  }
  else if (act === 'del-recurring') {
    const r = D().recurring.find(x => x.id === btn.dataset.id);
    if (r && confirm('이 고정 항목을 삭제할까요?\n이미 들어간 내역은 그대로 남아요.')) {
      await store.deleteRecurring(r.id);
      await log('delete', 'recurring', `고정 항목 ${txText(r)}`);
    }
  }
  else if (act === 'add-cat') {
    const input = prompt('새 카테고리 이름을 입력하세요.\n앞에 이모지를 붙여도 돼요. (예: 🐶 반려동물)');
    if (!input || !input.trim()) return;
    const m = input.trim().match(/^(\p{Extended_Pictographic}[️‍\p{Extended_Pictographic}]*)\s*(.+)$/u);
    await store.addCategory({ type: btn.dataset.type, emoji: m ? m[1] : '🏷️', name: (m ? m[2] : input).trim().slice(0, 12) });
    toast('카테고리를 추가했어요');
  }
  else if (act === 'del-cat') {
    const c = catById(btn.dataset.id);
    if (confirm(`'${c.name}' 카테고리를 삭제할까요?\n이 카테고리로 적은 내역은 지워지지 않아요.`)) await store.deleteCategory(c.id);
  }
  else if (act === 'export-csv') exportCsv();
});

function exportCsv() {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['날짜', '구분', '카테고리', '금액', '결제수단', '누가', '메모', '통계 제외']];
  const TYPE = { expense: '지출', income: '수입', charge: '충전' };
  [...D().transactions].sort((a, b) => a.date.localeCompare(b.date)).forEach(t => {
    rows.push([t.date, TYPE[t.type], t.type === 'charge' ? '' : catById(t.categoryId).name, t.amount,
      payName(t.paymentId), names()[t.who], t.memo, t.excluded ? 'O' : '']);
  });
  const csv = '﻿' + rows.map(r => r.map(q).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `가계부_${todayStr()}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- 시작 ---------- */
let recurringChecked = false;
const checkRecurring = () => {
  if (store.status !== 'ready' || recurringChecked) return;
  recurringChecked = true;
  applyRecurring().catch(err => console.error(err));
  if (store.mode === 'cloud') refreshPushState().catch(console.error);
};
store.subscribe(() => { render(); checkRecurring(); });
document.addEventListener('click', e => {
  if (e.target.closest('[data-auth="signup"]')) doAuth('signup');
});
(async () => {
  try {
    await store.init();
  } catch (err) {
    console.error(err);
    toast('연결하지 못했어요. 인터넷을 확인해 주세요');
  }
  render();
  checkRecurring();
})();

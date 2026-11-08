// Supabase Edge Function: send-digests
// 1분마다 자동으로 실행되어, 마지막 변경 후 5분 동안 조용한 사람의 변경 내용을
// 한 번에 요약해서 상대방 폰으로 푸시 알림을 보낸다.
//
// 필요한 Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, CRON_SECRET
// (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY 는 Supabase가 자동으로 넣어 준다)
// 설정에서 'Verify JWT' 는 꺼 둔다. 대신 CRON_SECRET 으로 확인한다.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

// Supabase Secrets 의 QUIET_MINUTES 로 바꿀 수 있다 (없으면 5분)
const QUIET_MINUTES = Number(Deno.env.get('QUIET_MINUTES') ?? '5');
const ACTION_LABEL: Record<string, string> = { add: '추가', update: '수정', delete: '삭제' };

type Activity = { id: string; household_id: string; author: string; action: string; summary: string; at: string };
type Sub = { endpoint: string; who: string; subscription: webpush.PushSubscription };

// 앱의 digest.js 와 같은 규칙
function buildDigest(items: Activity[], name: string) {
  const counts: Record<string, number> = {};
  for (const i of items) counts[i.action] = (counts[i.action] ?? 0) + 1;
  const parts = ['add', 'update', 'delete'].filter(a => counts[a]).map(a => `${ACTION_LABEL[a]} ${counts[a]}건`);
  const shown = items.slice(-3).reverse().map(i => `· ${ACTION_LABEL[i.action]}: ${i.summary}`);
  if (items.length > 3) shown.push(`· 외 ${items.length - 3}건`);
  return { title: `${name}님이 가계부를 바꿨어요 (${parts.join(', ')})`, body: shown.join('\n') };
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async req => {
  const secret = Deno.env.get('CRON_SECRET');
  if (!secret || req.headers.get('x-cron-secret') !== secret) return json({ error: 'forbidden' }, 403);

  webpush.setVapidDetails(
    Deno.env.get('VAPID_SUBJECT')!,
    Deno.env.get('VAPID_PUBLIC_KEY')!,
    Deno.env.get('VAPID_PRIVATE_KEY')!,
  );
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });

  async function sendAll(subs: Sub[], payload: { title: string; body: string }) {
    let sent = 0, removed = 0, failed = 0;
    for (const s of subs) {
      try {
        await webpush.sendNotification(s.subscription, JSON.stringify(payload), { TTL: 60 * 60 * 12 });
        sent++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) {
          // 앱을 지웠거나 알림을 끈 폰: 주소 정리
          await sb.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
          removed++;
        } else {
          console.error('push failed', code, e);
          failed++;
        }
      }
    }
    return { sent, removed, failed };
  }

  const body = await req.json().catch(() => ({}));

  // 연결 확인용: 등록된 모든 폰에 테스트 알림
  if (body?.test) {
    const { data: subs, error } = await sb.from('push_subscriptions').select('endpoint, who, subscription');
    if (error) return json({ error: error.message }, 500);
    const result = await sendAll(subs as Sub[], { title: '🔔 우리집 가계부', body: '알림이 잘 연결됐어요!' });
    return json({ test: true, phones: subs?.length ?? 0, ...result });
  }

  const { data: pending, error } = await sb
    .from('activity')
    .select('id, household_id, author, action, summary, at')
    .is('notified_at', null)
    .order('at', { ascending: true })
    .limit(2000);
  if (error) return json({ error: error.message }, 500);

  // 가구 + 바꾼 사람 별로 묶기
  const groups = new Map<string, Activity[]>();
  for (const a of (pending ?? []) as Activity[]) {
    const key = `${a.household_id}|${a.author}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(a);
  }

  const now = Date.now();
  const report: unknown[] = [];
  for (const [key, items] of groups) {
    const last = Date.parse(items[items.length - 1].at);
    if (now - last < QUIET_MINUTES * 60 * 1000) continue; // 아직 입력 중일 수 있으니 기다린다

    const [householdId, author] = key.split('|');
    const { data: hh } = await sb.from('households').select('names').eq('id', householdId).single();
    const names = (hh?.names ?? { a: '나', b: '아내' }) as Record<string, string>;
    const { data: subs } = await sb
      .from('push_subscriptions')
      .select('endpoint, who, subscription')
      .eq('household_id', householdId)
      .neq('who', author);

    const digest = buildDigest(items, names[author] ?? '');
    const result = await sendAll((subs ?? []) as Sub[], digest);

    // 보냈든(받을 폰이 없었든) 같은 내용을 또 보내지 않도록 표시
    const ids = items.map(i => i.id);
    for (let i = 0; i < ids.length; i += 200) {
      await sb.from('activity').update({ notified_at: new Date().toISOString() }).in('id', ids.slice(i, i + 200));
    }
    report.push({ author, changes: items.length, ...result });
  }

  return json({ ok: true, digests: report });
});

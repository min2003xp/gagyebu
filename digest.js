// 변경 기록을 모아 알림 한 개짜리 요약으로 만든다.
// 앱 안의 '새 소식'과, 나중에 서버에서 보낼 푸시 알림이 같은 규칙을 쓴다.

// 마지막 변경 후 이만큼 조용하면 요약 알림을 보낸다 (사용자가 정한 값: 30분)
export const QUIET_MINUTES = 30;

export const ACTION_LABEL = { add: '추가', update: '수정', delete: '삭제' };

/**
 * @param {Array} items  한 사람이 만든 변경 기록들 (시간순)
 * @param {string} name  그 사람 이름
 * @returns {{ title: string, body: string }}
 */
export function buildDigest(items, name) {
  const counts = { add: 0, update: 0, delete: 0 };
  items.forEach(i => { counts[i.action] = (counts[i.action] || 0) + 1; });
  const parts = Object.entries(counts).filter(([, n]) => n).map(([a, n]) => `${ACTION_LABEL[a]} ${n}건`);

  const shown = items.slice(-3).reverse().map(i => `· ${ACTION_LABEL[i.action]}: ${i.text}`);
  if (items.length > 3) shown.push(`· 외 ${items.length - 3}건`);

  return {
    title: `${name}님이 가계부를 바꿨어요 (${parts.join(', ')})`,
    body: shown.join('\n'),
  };
}

/**
 * 지금 알림을 보내야 하는 묶음을 찾는다.
 * 아직 알리지 않은 변경 중, 마지막 변경 후 QUIET_MINUTES가 지난 사람의 것만 고른다.
 * @returns {Array<{ by: string, items: Array }>}
 */
export function dueDigests(activity, now = Date.now()) {
  const result = [];
  for (const by of ['a', 'b']) {
    const pending = activity.filter(i => i.by === by && !i.notifiedAt).sort((x, y) => x.at - y.at);
    if (!pending.length) continue;
    const last = pending[pending.length - 1].at;
    if (now - last >= QUIET_MINUTES * 60 * 1000) result.push({ by, items: pending });
  }
  return result;
}

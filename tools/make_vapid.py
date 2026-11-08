"""푸시 알림용 VAPID 키와 자동 실행용 비밀값을 만든다.

실행: python tools/make_vapid.py
결과: supabase/secrets.local.txt  (git에 올라가지 않는다. 남에게 보여주지 말 것)
화면에는 공개 키만 출력한다.
"""
import base64
import secrets
from pathlib import Path

# P-256 타원곡선
P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF
A = P - 3
N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
G = (0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296,
     0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5)


def add(p, q):
    if p is None:
        return q
    if q is None:
        return p
    if p[0] == q[0] and (p[1] + q[1]) % P == 0:
        return None
    if p == q:
        lam = (3 * p[0] * p[0] + A) * pow(2 * p[1], -1, P) % P
    else:
        lam = (q[1] - p[1]) * pow(q[0] - p[0], -1, P) % P
    x = (lam * lam - p[0] - q[0]) % P
    return x, (lam * (p[0] - x) - p[1]) % P


def mul(k, pt):
    out = None
    while k:
        if k & 1:
            out = add(out, pt)
        pt = add(pt, pt)
        k >>= 1
    return out


def b64url(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


root = Path(__file__).resolve().parent.parent
out = root / "supabase" / "secrets.local.txt"
if out.exists():
    print("이미 있어요:", out)
    for line in out.read_text(encoding="utf-8").splitlines():
        if line.startswith("VAPID_PUBLIC_KEY="):
            print(line)
    raise SystemExit

d = secrets.randbelow(N - 1) + 1
x, y = mul(d, G)
public = b"\x04" + x.to_bytes(32, "big") + y.to_bytes(32, "big")

out.write_text(
    "# Supabase > Edge Functions > Secrets 에 아래 4개를 그대로 등록하세요. 남에게 보여주지 마세요.\n"
    f"VAPID_PUBLIC_KEY={b64url(public)}\n"
    f"VAPID_PRIVATE_KEY={b64url(d.to_bytes(32, 'big'))}\n"
    "VAPID_SUBJECT=mailto:min2003xp@gmail.com\n"
    f"CRON_SECRET={secrets.token_urlsafe(32)}\n",
    encoding="utf-8",
)
print("만들었어요:", out)
print(f"VAPID_PUBLIC_KEY={b64url(public)}")

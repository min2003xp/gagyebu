"""앱 아이콘(PNG)을 만든다.  실행: python tools/make_icons.py"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "icons"
OUT.mkdir(exist_ok=True)

GREEN = (47, 125, 109)
WHITE = (255, 255, 255)
SOFT = (191, 224, 216)


def font(px):
    for name in ("malgunbd.ttf", "malgun.ttf", "arialbd.ttf", "arial.ttf"):
        try:
            return ImageFont.truetype(name, px)
        except OSError:
            continue
    return ImageFont.load_default()


def make(size, pad, name):
    s = 4  # 크게 그린 뒤 줄여서 테두리를 부드럽게
    big = size * s
    img = Image.new("RGB", (big, big), GREEN)
    d = ImageDraw.Draw(img)
    inner = big * (1 - pad * 2)
    o = big * pad
    bx, by = o + inner * 0.18, o + inner * 0.12
    bw, bh = inner * 0.64, inner * 0.76
    d.rounded_rectangle([bx, by, bx + bw, by + bh], radius=inner * 0.08, fill=WHITE)
    f = font(int(inner * 0.36))
    d.text((bx + bw / 2, by + bh * 0.42), "₩", font=f, fill=GREEN, anchor="mm")
    for i in range(2):
        y = by + bh * (0.70 + i * 0.12)
        d.rounded_rectangle([bx + bw * 0.2, y, bx + bw * 0.8, y + inner * 0.04], radius=inner * 0.02, fill=SOFT)
    img.resize((size, size), Image.LANCZOS).save(OUT / name, optimize=True)


def make_badge(size, name):
    """폰 맨 위 상태표시줄용 알림 아이콘.
    안드로이드는 색을 버리고 '모양(불투명한 부분)'만 흰색으로 보여 주므로,
    투명 바탕에 가계부 장부 모양을 흰색으로 그리고 ₩와 줄은 구멍을 뚫는다."""
    s = 8
    big = size * s
    img = Image.new("L", (big, big), 0)  # 0 = 투명
    d = ImageDraw.Draw(img)
    bx, by, bw, bh = big * 0.16, big * 0.06, big * 0.68, big * 0.88
    d.rounded_rectangle([bx, by, bx + bw, by + bh], radius=big * 0.1, fill=255)
    d.text((bx + bw / 2, by + bh * 0.40), "₩", font=font(int(big * 0.46)), fill=0, anchor="mm")
    for i in range(2):
        y = by + bh * (0.71 + i * 0.12)
        d.rounded_rectangle([bx + bw * 0.2, y, bx + bw * 0.8, y + big * 0.055], radius=big * 0.03, fill=0)
    alpha = img.resize((size, size), Image.LANCZOS)
    out = Image.new("RGBA", (size, size), (255, 255, 255, 0))
    out.putalpha(alpha)
    out.save(OUT / name, optimize=True)


make(192, 0.06, "icon-192.png")
make_badge(96, "badge-96.png")
make(512, 0.06, "icon-512.png")
make(180, 0.06, "apple-touch-icon.png")
make(512, 0.16, "icon-maskable-512.png")  # 안드로이드가 둥글게 잘라도 안전한 여백
print("ok")

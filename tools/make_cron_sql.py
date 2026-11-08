"""secrets.local.txt 의 CRON_SECRET 을 넣은 cron.local.sql 을 만든다 (git에 올라가지 않음)."""
from pathlib import Path

root = Path(__file__).resolve().parent.parent / "supabase"
secrets = dict(
    line.split("=", 1)
    for line in (root / "secrets.local.txt").read_text(encoding="utf-8").splitlines()
    if "=" in line and not line.startswith("#")
)
sql = (root / "cron.sql").read_text(encoding="utf-8").replace("__CRON_SECRET__", secrets["CRON_SECRET"])
(root / "cron.local.sql").write_text(sql, encoding="utf-8")
print("ok")

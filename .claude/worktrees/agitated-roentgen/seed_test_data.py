#!/usr/bin/env python3
"""SaaSプロジェクト（fewuonnrgqnxtopkjudt）にテストデータを投入
正確なスキーマ:
  casts: id, store_id, name, pin, sort_order, is_active, created_at
  courses: id, store_id, name, duration, price, sort_order, is_active, created_at
  options: id, store_id, name, price, sort_order, is_active, created_at
  shifts: id, store_id, cast_id, date, start_time, end_time, note, status, created_at
  reservations: id, store_id, cast_id, customer_id, course_id, date, start_time, end_time, checkout_time, status, source, payment, options, extension_count, nomination_fee, note, created_at
  customers: id, store_id, name, phone, email, notes, is_blocked, created_at
  customer_visits: id, store_id, customer_id, cast_id, visited_at, course_name, note
  works: id, store_id, cast_id, customer_id, reservation_id, date, course_name, course_duration, course_price, options, payment, nomination_fee, extension_count, note, created_at
  cast_fees: id, store_id, cast_id, month, fee_amount, note, created_at
  daily_notes: id, store_id, date, body, created_at
  monthly_sales: id, store_id, cast_id, month, total_sales, total_count, created_at
  rooms: id, store_id, name, color_bg, color_tx, color_bd, color_card, sort_order, active, created_at
"""
import json
import urllib.request
import uuid
import random
from datetime import datetime, timedelta, date

SB_URL = "https://fewuonnrgqnxtopkjudt.supabase.co"
SRK = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZld3Vvbm5yZ3FueHRvcGtqdWR0Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3OTAyNzQwNiwiZXhwIjoyMDk0NjAzNDA2fQ.iScVWF7chpuQ-W-7ZSrJ34wK1G6Hx3AB2POpczAutXM"

HEADERS = {
    "apikey": SRK,
    "Authorization": f"Bearer {SRK}",
    "Content-Type": "application/json",
    "Prefer": "return=representation",
}

def api(method, table, data=None, params=""):
    url = f"{SB_URL}/rest/v1/{table}{params}"
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, headers=HEADERS, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode())
    except urllib.request.HTTPError as e:
        err = e.read().decode()
        print(f"ERROR {e.code} on {method} {table}: {err[:300]}")
        raise

def insert(table, data):
    return api("POST", table, data)

def insert_batch(table, data, batch_size=100, label=""):
    results = []
    for i in range(0, len(data), batch_size):
        batch = data[i:i+batch_size]
        result = insert(table, batch)
        results.extend(result)
        done = i + len(batch)
        if done % 500 == 0 or done == len(data):
            print(f"  {done}/{len(data)} {label}")
    return results

STORE_ID = str(uuid.uuid4())
TODAY = date.today()
START_DATE = TODAY - timedelta(days=29)

CAST_NAMES = [
    "あかり", "ひまり", "みお", "ゆい", "さくら",
    "はな", "りん", "めい", "なな", "ここ",
    "ゆず", "あおい", "れん", "まい", "しおり",
    "かのん", "ひなた", "えま", "すず", "みゆ",
]

COURSE_NAMES = ["50分コース", "80分コース", "100分コース", "130分コース", "延長30分"]
COURSE_PRICES = [12000, 18000, 24000, 30000, 5000]
COURSE_DURATIONS = [50, 80, 100, 130, 30]

OPTION_NAMES = ["ゴクエキ", "衣装チェンジ", "衣装チェンジ2", "ホットオイル", "パウダー"]
OPTION_PRICES = [2000, 1000, 1000, 1500, 1000]

ROOM_NAMES = ["Aルーム", "Bルーム", "Cルーム", "Dルーム", "Eルーム",
              "Fルーム", "Gルーム", "Hルーム", "Iルーム", "Jルーム"]
ROOM_COLORS = [
    ("#fff0f6", "#be185d", "#fbcfe8", "#fce7f3"),
    ("#eff6ff", "#1d4ed8", "#bfdbfe", "#dbeafe"),
    ("#f0fdf4", "#15803d", "#bbf7d0", "#dcfce7"),
    ("#fefce8", "#854d0e", "#fef08a", "#fef9c3"),
    ("#fdf2f8", "#9d174d", "#f9a8d4", "#fce7f3"),
    ("#ecfdf5", "#065f46", "#6ee7b7", "#d1fae5"),
    ("#f5f3ff", "#5b21b6", "#c4b5fd", "#ede9fe"),
    ("#fff7ed", "#9a3412", "#fed7aa", "#ffedd5"),
    ("#f0f9ff", "#075985", "#7dd3fc", "#e0f2fe"),
    ("#fef2f2", "#991b1b", "#fecaca", "#fee2e2"),
]

LAST_NAMES = ["田中", "佐藤", "鈴木", "高橋", "伊藤", "山田", "中村", "小林", "加藤", "吉田",
              "渡辺", "山本", "松本", "井上", "木村", "林", "斎藤", "清水", "山口", "池田"]

MEMOS = [
    "丁寧な対応を心がけた", "前回と同じメニューを希望", "肩こりがひどいとのこと",
    "次回は80分コースを検討中", "オプション追加あり", "会話が好きなお客様",
    "静かな施術を好む", "アロマの香りを気に入っていた", "リピート確定",
    "友人紹介あり", "時間厳守のお客様", "延長希望あり",
    "次回予約済み", "特に問題なし", "指名変更の相談あり", "新規オプションに興味あり",
]

PAYMENT_METHODS = ["cash", "card", "paypay"]
SHIMEI_TYPES = ["free", "net", "hon"]

print("=== テストデータ投入開始 ===")

# 1. Store
print("\n1. テスト店舗作成...")
store = insert("stores", [{
    "id": STORE_ID,
    "name": "テスト店舗（負荷テスト用）",
    "slug": "load-test-store",
    "owner_email": "loadtest@shiftlink.jp",
    "plan": "free",
    "subscription_status": "trialing",
    "trial_ends_at": (datetime.now() + timedelta(days=14)).isoformat(),
    "settings": {},
}])
print(f"  Store: {STORE_ID}")

# 2. Courses
print("\n2. コース作成（5件）...")
courses = insert("courses", [
    {"name": n, "price": p, "duration": d, "sort_order": i+1, "is_active": True, "store_id": STORE_ID}
    for i, (n, p, d) in enumerate(zip(COURSE_NAMES, COURSE_PRICES, COURSE_DURATIONS))
])
course_map = {c["name"]: c for c in courses}
print(f"  {len(courses)} courses")

# 3. Options
print("\n3. オプション作成（5件）...")
options = insert("options", [
    {"name": n, "price": p, "sort_order": i+1, "is_active": True, "store_id": STORE_ID}
    for i, (n, p) in enumerate(zip(OPTION_NAMES, OPTION_PRICES))
])
print(f"  {len(options)} options")

# 4. Rooms
print("\n4. ルーム作成（10件）...")
rooms = insert("rooms", [
    {"name": n, "store_id": STORE_ID, "sort_order": i+1,
     "color_bg": c[0], "color_tx": c[1], "color_bd": c[2], "color_card": c[3]}
    for i, (n, c) in enumerate(zip(ROOM_NAMES, ROOM_COLORS))
])
print(f"  {len(rooms)} rooms")

# 5. Casts（20名）
print("\n5. セラピスト作成（20名）...")
casts = insert("casts", [
    {"name": n, "pin": str(1000 + i), "is_active": True, "sort_order": i+1, "store_id": STORE_ID}
    for i, n in enumerate(CAST_NAMES)
])
cast_ids = [c["id"] for c in casts]
print(f"  {len(casts)} casts")

# 6. Customers（500名）
print("\n6. 顧客作成（500名）...")
customers_data = []
for i in range(500):
    customers_data.append({
        "name": f"{random.choice(LAST_NAMES)}様{i+1:03d}",
        "phone": f"090{random.randint(10000000, 99999999)}",
        "email": f"customer{i+1:03d}@example.com" if random.random() < 0.3 else None,
        "notes": random.choice(["", "", "", "常連", "VIP", "初回割引済", ""]),
        "is_blocked": i >= 495,
        "store_id": STORE_ID,
    })
all_customers = insert_batch("customers", customers_data, label="customers")
customer_ids = [c["id"] for c in all_customers]
print(f"  {len(all_customers)} customers total")

# 7. Shifts（20名 × 30日）
print("\n7. シフト作成...")
shifts_data = []
for day_offset in range(30):
    d = START_DATE + timedelta(days=day_offset)
    for cid in cast_ids:
        if random.random() < 0.15:
            continue
        start_h = random.choice([10, 11, 12, 13])
        end_h = start_h + random.choice([6, 7, 8, 9])
        shifts_data.append({
            "cast_id": cid,
            "date": d.isoformat(),
            "start_time": f"{start_h:02d}:00",
            "end_time": f"{min(end_h, 23):02d}:00",
            "status": random.choice(["approved", "approved", "approved", "requested"]),
            "note": "",
            "store_id": STORE_ID,
        })
all_shifts = insert_batch("shifts", shifts_data, label="shifts")
print(f"  {len(all_shifts)} shifts total")

# 8. Reservations（1日100件 × 30日 = 3000件）
print("\n8. 予約作成（3000件）...")
reservations_data = []
for day_offset in range(30):
    d = START_DATE + timedelta(days=day_offset)
    day_shifts = [s for s in all_shifts if s["date"] == d.isoformat()]
    if not day_shifts:
        continue
    for _ in range(100):
        shift = random.choice(day_shifts)
        cust = random.choice(all_customers)
        course_idx = random.choice([0, 0, 1, 1, 2, 3])
        course = courses[course_idx]
        dur = COURSE_DURATIONS[course_idx]
        start_h = random.randint(10, 20)
        start_m = random.choice([0, 15, 30, 45])
        end_total = start_h * 60 + start_m + dur
        end_h = min(end_total // 60, 23)
        end_m = end_total % 60
        checkout_total = end_total + random.choice([0, 5, 10])
        co_h = min(checkout_total // 60, 23)
        co_m = checkout_total % 60

        sel_opts = random.sample(OPTION_NAMES[:3], k=random.choice([0, 0, 1, 1, 2]))
        opt_json = json.dumps([{"name": o, "price": OPTION_PRICES[OPTION_NAMES.index(o)]} for o in sel_opts])

        reservations_data.append({
            "cast_id": shift["cast_id"],
            "customer_id": cust["id"],
            "course_id": course["id"],
            "date": d.isoformat(),
            "start_time": f"{start_h:02d}:{start_m:02d}",
            "end_time": f"{end_h:02d}:{end_m:02d}",
            "checkout_time": f"{co_h:02d}:{co_m:02d}",
            "status": random.choice(["confirmed", "confirmed", "confirmed", "completed"]),
            "source": random.choice(["phone", "web", "walk-in"]),
            "payment": random.choice(PAYMENT_METHODS),
            "options": opt_json,
            "extension_count": random.choice([0, 0, 0, 0, 1]),
            "nomination_fee": random.choice([0, 0, 1000, 2000]),
            "note": "",
            "store_id": STORE_ID,
        })
all_reservations = insert_batch("reservations", reservations_data, label="reservations")
print(f"  {len(all_reservations)} reservations total")

# 9. Customer Visits / 接客メモ（1000件）
print("\n9. 接客メモ作成（1000件）...")
visits_data = []
for i in range(1000):
    d = START_DATE + timedelta(days=random.randint(0, 29))
    visits_data.append({
        "customer_id": random.choice(customer_ids),
        "cast_id": random.choice(cast_ids),
        "visited_at": f"{d.isoformat()}T{random.randint(10,20):02d}:00:00",
        "course_name": random.choice(COURSE_NAMES[:4]),
        "note": random.choice(MEMOS),
        "store_id": STORE_ID,
    })
all_visits = insert_batch("customer_visits", visits_data, label="visits")
print(f"  {len(all_visits)} visits total")

# 10. Works（日報: 20名 × 30日）
print("\n10. 日報データ作成...")
works_data = []
for day_offset in range(30):
    d = START_DATE + timedelta(days=day_offset)
    day_reservations = [r for r in all_reservations if r["date"] == d.isoformat()]
    for cid in cast_ids:
        cast_res = [r for r in day_reservations if r["cast_id"] == cid]
        if not cast_res and random.random() < 0.5:
            continue
        if not cast_res:
            continue
        for r in cast_res[:random.randint(1, 4)]:
            ci = random.choice([0, 0, 1, 1, 2, 3])
            works_data.append({
                "cast_id": cid,
                "customer_id": r["customer_id"],
                "reservation_id": r["id"],
                "date": d.isoformat(),
                "course_name": COURSE_NAMES[ci],
                "course_duration": COURSE_DURATIONS[ci],
                "course_price": COURSE_PRICES[ci],
                "options": r["options"],
                "payment": r["payment"],
                "nomination_fee": r.get("nomination_fee", 0),
                "extension_count": r.get("extension_count", 0),
                "note": "",
                "store_id": STORE_ID,
            })

all_works = insert_batch("works", works_data, label="works")
print(f"  {len(all_works)} works total")

# 11. Cast Fees（報酬: 20名 × 1ヶ月）
print("\n11. 報酬データ作成...")
month_str = TODAY.strftime("%Y-%m")
cast_fees_data = [
    {
        "cast_id": cid,
        "month": month_str,
        "fee_amount": random.randint(200000, 800000),
        "note": "",
        "store_id": STORE_ID,
    }
    for cid in cast_ids
]
all_fees = insert("cast_fees", cast_fees_data)
print(f"  {len(all_fees)} cast_fees")

# 12. Daily Notes（30日分）
print("\n12. 日次メモ作成（30日分）...")
daily_notes_data = [
    {
        "date": (START_DATE + timedelta(days=i)).isoformat(),
        "body": f"問合せ{random.randint(5,30)}件。{'天候:晴れ' if random.random()>0.3 else '天候:雨で客足少なめ'}。",
        "store_id": STORE_ID,
    }
    for i in range(30)
]
dn = insert("daily_notes", daily_notes_data)
print(f"  {len(dn)} daily_notes")

# 13. Monthly Sales
print("\n13. 月次売上データ作成...")
ms = insert("monthly_sales", [{
    "cast_id": None,
    "month": month_str,
    "total_sales": sum(w.get("course_price", 0) for w in all_works),
    "total_count": len(all_works),
    "store_id": STORE_ID,
}])
print(f"  Monthly sales for {month_str}")

# === 結果サマリー ===
print("\n" + "=" * 50)
print("  テストデータ投入完了")
print("=" * 50)
print(f"  Store ID:         {STORE_ID}")
print(f"  Rooms:            {len(rooms)}")
print(f"  Casts:            {len(casts)}")
print(f"  Courses:          {len(courses)}")
print(f"  Options:          {len(options)}")
print(f"  Customers:        {len(all_customers)}")
print(f"  Shifts:           {len(all_shifts)}")
print(f"  Reservations:     {len(all_reservations)}")
print(f"  Customer Visits:  {len(all_visits)}")
print(f"  Works:            {len(all_works)}")
print(f"  Cast Fees:        {len(all_fees)}")
print(f"  Daily Notes:      {len(dn)}")
print(f"  Monthly Sales:    1")

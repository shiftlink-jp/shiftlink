// set-pin: オーナーPIN / キャストPIN を auth_pins（RLS全拒否テーブル）へ
// bcrypt で保存する（ハッシュ化は Postgres 関数 set_pin_hash 内で実施）。
// クライアントは service_role を持たないため、PINの設定・変更は必ずこの関数を経由する
// （平文を casts.pin / store_settings.owner_pin へ直接書かない＝#1 権限昇格対策）。
//
// 認証: 呼び出し元のセッションJWTを検証し、store_members で当該店舗の role='owner'
//       であることを確認する。キャスト(staff)は他人/自分のPINを変更できない。
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ALLOWED_ORIGINS = [
  "https://kyoukano.vercel.app",
  "https://app.shiftlink.jp",
  "https://shiftlink-app.jp",
  "https://www.shiftlink-app.jp",
  "http://localhost:3100",
  "http://localhost:3200",
  "http://localhost:3300",
];
const VERCEL_PREVIEW_RE = /^https:\/\/kyoukano-[a-z0-9-]+-sawaki-nagoyas-projects\.vercel\.app$/;

function cors(origin: string | null) {
  const ok = origin && (ALLOWED_ORIGINS.includes(origin) || VERCEL_PREVIEW_RE.test(origin));
  return {
    "Access-Control-Allow-Origin": ok ? origin! : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, content-type, apikey",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}
function json(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", ...cors(origin) },
  });
}

serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, origin);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    // 1) 呼び出し元のセッションを検証
    const token = (req.headers.get("authorization") ?? "").replace("Bearer ", "").trim();
    if (!token) return json({ error: "認証が必要です" }, 401, origin);
    const { data: { user }, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !user) return json({ error: "認証エラー" }, 401, origin);

    const { store_id, target, cast_id, pin } = await req.json();
    if (!store_id) return json({ error: "store_id は必須です" }, 400, origin);

    // 2) PIN形式チェック（クライアントと同条件: 4〜8桁の数字）
    //    短すぎるPIN（1〜3桁）はハッシュでも保護不能なため設定時に拒否する。
    const pinStr = String(pin ?? "");
    if (!/^\d{4,8}$/.test(pinStr)) return json({ error: "PINは4〜8桁の数字で入力してください" }, 400, origin);

    // 3) 当該店舗のオーナーであることを確認（キャストは設定不可）
    const { data: mem } = await admin
      .from("store_members").select("role")
      .eq("user_id", user.id).eq("store_id", store_id).maybeSingle();
    if (!mem || mem.role !== "owner") return json({ error: "権限がありません" }, 403, origin);

    // 4) principal を決定
    let principal: string;
    if (target === "owner") {
      principal = "owner";
    } else {
      const cid = cast_id ?? (typeof target === "number" ? target : null);
      if (!cid) return json({ error: "cast_id または target が必要です" }, 400, origin);
      // 当該店舗に属する cast か検証（他店のPINを書けないように）
      const { data: c } = await admin
        .from("casts").select("id").eq("id", cid).eq("store_id", store_id).maybeSingle();
      if (!c) return json({ error: "対象キャストが見つかりません" }, 404, origin);
      principal = `cast.${cid}`;

      // 重複PIN防止: 同店舗の他キャストが同じPINを使っていないか確認
      // （名前なしPINログインのため、店舗内でPINは一意である必要がある）
      const { data: others } = await admin
        .from("casts").select("id,pin").eq("store_id", store_id).neq("id", cid);
      for (const o of (others ?? [])) {
        const { data: dup, error: dupErr } = await admin.rpc("verify_pin", {
          p_store_id: store_id, p_principal: `cast.${o.id}`, p_pin: pinStr,
        });
        const isDup = (!dupErr && dup === true) || (o?.pin != null && String(o.pin) === pinStr);
        if (isDup) {
          return json({ error: "このPINは他のセラピストが使用中です。別の番号にしてください" }, 409, origin);
        }
      }
    }

    // 5) auth_pins へ保存（ハッシュ化=bcrypt は Postgres 関数内で実施）
    const { error: rpcErr } = await admin.rpc("set_pin_hash", {
      p_store_id: store_id, p_principal: principal, p_pin: pinStr,
    });
    if (rpcErr) throw rpcErr;

    // オーナー要望により、キャスト管理画面のバッジに現在のPIN数字を表示するため、
    // 旧 casts.pin 列にも同じ数字を反映する（auth_pins=bcrypt は不可逆で読めないため）。
    // ※平文保存のため、DBを直接閲覧できる者にはPINが見える点に留意（利便性優先の運用判断）。
    if (target !== "owner") {
      const cid = cast_id ?? (typeof target === "number" ? target : null);
      const { error: upErr } = await admin
        .from("casts").update({ pin: pinStr }).eq("id", cid).eq("store_id", store_id);
      if (upErr) throw upErr;
    }

    return json({ ok: true, principal }, 200, origin);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500, origin);
  }
});

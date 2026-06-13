// passkey: 生体認証(パスキー/WebAuthn)をサーバ側で検証し、認証成功時に pin-login と同じ
//          店舗スコープの認証セッションを発行する。
//
// なぜ必要か: 旧パスキーはサーバ検証が無く(公開鍵=clientDataJSONのゴミ)、anonが開いていた前提の
//   簡易ロックに過ぎなかった。PIN認証カットオーバー後はセッションが必須で、かつPhase B(anon遮断)後も
//   安全である必要がある。本関数は実績ある @simplewebauthn/server で署名を厳密検証する。
//
// アクション(POST body の action):
//   reg-options  : (要セッション) 登録用チャレンジ発行。ログイン中の本人にのみ発行。
//   reg-verify   : (要セッション) 登録応答(attestation)を検証し、本物のCOSE公開鍵を保存。
//   auth-options : (匿名可)       ログイン用チャレンジ＋allowCredentials発行。
//   auth-verify  : (匿名可)       認証応答(assertion)を検証→検証成功時のみセッション発行。
//
// 安全性: ①検証成功時のみセッション発行(秘密鍵を持つ端末以外は偽造不可) ②challengeは単回・5分TTL
//   (リプレイ防止) ③登録はセッション必須=他人のパスキーを登録できない ④全て store_id スコープ。

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "npm:@simplewebauthn/server@13";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const ALLOWED_ORIGINS = [
  "https://kyoukano.vercel.app",
  "https://shiftlink-app.jp",
  "https://www.shiftlink-app.jp",
  "https://app.shiftlink.jp",
  "http://localhost:3100",
  "http://localhost:3200",
  "http://localhost:3300",
];

function cors(origin: string | null) {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "authorization, content-type, apikey",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}
function json(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors(origin) },
  });
}

// Uint8Array <-> base64url（DBはtextで保持）
function bufToB64url(buf: Uint8Array): string {
  let s = "";
  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBuf(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64url.length % 4)) % 4);
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// pin-login と同じ手順で、指定 principal の内部Authユーザーを用意しセッションを発行する。
// role: 'owner' | 'staff' / castId: ownerはnull
// deno-lint-ignore no-explicit-any
async function mintSession(admin: any, store_id: string, role: string, castId: number | null) {
  const principalKey = role === "owner" ? `owner.${store_id}` : `cast.${castId}.${store_id}`;
  const email = `pin.${principalKey}@shiftlink.internal`;
  let userId: string | null = null;

  // 既存は store_members から決定的に引く
  let memberKnown = false; // store_members 経由で確定したら ensure 再取得を省略できる
  let q = admin.from("store_members").select("user_id").eq("store_id", store_id).eq("role", role).limit(1);
  q = castId == null ? q.is("cast_id", null) : q.eq("cast_id", castId);
  const { data: smRows } = await q;
  if (smRows && smRows[0]?.user_id) { userId = smRows[0].user_id as string; memberKnown = true; }

  if (!userId) {
    const { data: created } = await admin.auth.admin.createUser({
      email, email_confirm: true, user_metadata: { store_id, role, cast_id: castId },
    });
    if (created?.user) userId = created.user.id;
  }
  if (!userId) {
    // 異常系: Authユーザーは在るが store_members 未登録 → 全ページ走査
    const perPage = 200;
    for (let page = 1; page <= 100 && !userId; page++) {
      const { data } = await admin.auth.admin.listUsers({ page, perPage });
      const users = data?.users ?? [];
      // deno-lint-ignore no-explicit-any
      const found = users.find((u: any) => (u.email || "").toLowerCase() === email.toLowerCase());
      if (found) userId = found.id;
      if (users.length < perPage) break;
    }
  }
  if (!userId) throw new Error("認証ユーザーの準備に失敗しました");

  // store_members を保証（lookupで確定済みなら存在は自明なので再取得を省略＝1往復削減）
  if (!memberKnown) {
    const { data: mem } = await admin
      .from("store_members").select("id").eq("user_id", userId).eq("store_id", store_id).maybeSingle();
    if (!mem) {
      await admin.from("store_members").insert({ store_id, user_id: userId, role, cast_id: castId });
    }
  }

  // 使い捨てパスワード→サインイン（#6対策のリトライ）
  const anon = createClient(SUPABASE_URL, ANON_KEY);
  // deno-lint-ignore no-explicit-any
  let session: any = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const ephemeral = crypto.randomUUID() + crypto.randomUUID();
    await admin.auth.admin.updateUserById(userId, { password: ephemeral });
    const { data: signIn } = await anon.auth.signInWithPassword({ email, password: ephemeral });
    if (signIn?.session) { session = signIn.session; break; }
    await new Promise((r) => setTimeout(r, 40 + Math.floor(Math.random() * 120)));
  }
  if (!session) throw new Error("セッション発行に失敗しました");
  return { session, userId };
}

// セッションの user から store_members を引いて、登録すべき principal(=passkeyのcast_id)を決める。
// owner/manager は cast_id=0(慣習) で保存する。
// deno-lint-ignore no-explicit-any
async function principalFromSession(admin: any, token: string, store_id: string) {
  const { data: { user }, error } = await admin.auth.getUser(token);
  if (error || !user) return null;
  const { data: mem } = await admin
    .from("store_members").select("role,cast_id").eq("user_id", user.id).eq("store_id", store_id).maybeSingle();
  if (!mem) return null;
  const isOwner = mem.role === "owner" || mem.role === "manager";
  return { user_id: user.id, pkCastId: isOwner ? 0 : Number(mem.cast_id), role: isOwner ? "owner" : "staff" };
}

serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, origin);

  // rpID/expectedOrigin は検証済みのOriginヘッダから導出（クライアント申告は信用しない）
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return json({ error: "origin not allowed" }, 403, origin);
  const rpID = new URL(origin).hostname;
  const expectedOrigin = origin;
  const rpName = "ShiftLink";

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    const body = await req.json();
    const action = String(body?.action ?? "");
    const store_id = body?.store_id ? String(body.store_id) : "";
    if (!store_id) return json({ error: "store_id は必須です" }, 400, origin);

    // ───────── 登録(要セッション) ─────────
    if (action === "reg-options" || action === "reg-verify") {
      const token = (req.headers.get("authorization") ?? "").replace("Bearer ", "").trim();
      const pr = await principalFromSession(admin, token, store_id);
      if (!pr) return json({ error: "ログインが必要です" }, 401, origin);

      if (action === "reg-options") {
        // 既存のv2認証情報は除外（重複登録防止）
        const { data: existing } = await admin.from("passkeys")
          .select("credential_id").eq("store_id", store_id).eq("cast_id", pr.pkCastId).eq("pk_format", "v2");
        const options = await generateRegistrationOptions({
          rpName, rpID,
          userName: pr.role === "owner" ? "店舗オーナー" : `cast-${pr.pkCastId}`,
          userID: new TextEncoder().encode(`${store_id}:${pr.pkCastId}`),
          attestationType: "none",
          authenticatorSelection: { residentKey: "preferred", userVerification: "required", authenticatorAttachment: "platform" },
          excludeCredentials: (existing ?? []).map((e: { credential_id: string }) => ({ id: e.credential_id })),
        });
        const { data: ch } = await admin.from("webauthn_challenges")
          .insert({ challenge: options.challenge, purpose: "register", store_id, cast_id: pr.pkCastId, user_id: pr.user_id })
          .select("id").single();
        return json({ options, challenge_id: ch?.id }, 200, origin);
      }

      // reg-verify
      const { response, challenge_id } = body;
      if (!response || !challenge_id) return json({ error: "response, challenge_id は必須です" }, 400, origin);
      const { data: ch } = await admin.from("webauthn_challenges")
        .select("*").eq("id", challenge_id).maybeSingle();
      await admin.from("webauthn_challenges").delete().eq("id", challenge_id);
      if (!ch || ch.purpose !== "register" || ch.user_id !== pr.user_id || new Date(ch.expires_at) < new Date()) {
        return json({ error: "チャレンジが無効です。やり直してください" }, 400, origin);
      }
      const verification = await verifyRegistrationResponse({
        response, expectedChallenge: ch.challenge, expectedOrigin, expectedRPID: rpID, requireUserVerification: true,
      });
      if (!verification.verified || !verification.registrationInfo) {
        return json({ error: "登録の検証に失敗しました" }, 400, origin);
      }
      const cred = verification.registrationInfo.credential;
      await admin.from("passkeys").insert({
        store_id, cast_id: pr.pkCastId,
        credential_id: cred.id,
        public_key: bufToB64url(cred.publicKey),
        counter: cred.counter ?? 0,
        transports: cred.transports ? JSON.stringify(cred.transports) : null,
        pk_format: "v2",
      });
      return json({ ok: true }, 200, origin);
    }

    // ───────── ログイン(匿名可) ─────────
    if (action === "auth-options" || action === "auth-verify") {
      const cast_id = (body?.cast_id == null) ? null : Number(body.cast_id); // owner=0
      if (cast_id == null || Number.isNaN(cast_id)) return json({ error: "cast_id は必須です" }, 400, origin);

      if (action === "auth-options") {
        const { data: pks } = await admin.from("passkeys")
          .select("credential_id,transports").eq("store_id", store_id).eq("cast_id", cast_id).eq("pk_format", "v2");
        if (!pks || pks.length === 0) return json({ credentials: 0 }, 200, origin);
        const options = await generateAuthenticationOptions({
          rpID, userVerification: "required",
          allowCredentials: pks.map((p: { credential_id: string; transports: string | null }) => ({
            id: p.credential_id,
            transports: p.transports ? JSON.parse(p.transports) : undefined,
          })),
        });
        const { data: ch } = await admin.from("webauthn_challenges")
          .insert({ challenge: options.challenge, purpose: "authenticate", store_id, cast_id })
          .select("id").single();
        return json({ options, challenge_id: ch?.id, credentials: pks.length }, 200, origin);
      }

      // auth-verify
      const { response, challenge_id } = body;
      if (!response || !challenge_id) return json({ error: "response, challenge_id は必須です" }, 400, origin);
      // 高速化: チャレンジ取得・チャレンジ削除(単回使用)・パスキー取得は互いに独立なので並行実行。
      //   削除はチャレンジ内容に依存せず必ず実行される＝単回使用保証は不変。妥当性は下で検証する。
      const [{ data: ch }, , { data: pk }] = await Promise.all([
        admin.from("webauthn_challenges").select("*").eq("id", challenge_id).maybeSingle(),
        admin.from("webauthn_challenges").delete().eq("id", challenge_id),
        admin.from("passkeys").select("*").eq("store_id", store_id).eq("cast_id", cast_id).eq("pk_format", "v2")
          .eq("credential_id", String(response.id)).maybeSingle(),
      ]);
      if (!ch || ch.purpose !== "authenticate" || ch.store_id !== store_id || ch.cast_id !== cast_id ||
          new Date(ch.expires_at) < new Date()) {
        return json({ error: "チャレンジが無効です。やり直してください" }, 400, origin);
      }
      if (!pk) return json({ error: "認証情報が見つかりません" }, 400, origin);

      const verification = await verifyAuthenticationResponse({
        response, expectedChallenge: ch.challenge, expectedOrigin, expectedRPID: rpID,
        requireUserVerification: true,
        credential: {
          id: pk.credential_id,
          publicKey: b64urlToBuf(pk.public_key),
          counter: Number(pk.counter ?? 0),
          transports: pk.transports ? JSON.parse(pk.transports) : undefined,
        },
      });
      if (!verification.verified) return json({ error: "生体認証の検証に失敗しました" }, 401, origin);

      // 検証成功 → カウンタ更新(クローン検知)とセッション発行は独立なので並行実行（owner=cast_id 0）。
      const role = cast_id === 0 ? "owner" : "staff";
      const memberCastId = cast_id === 0 ? null : cast_id;
      const [, minted] = await Promise.all([
        admin.from("passkeys").update({ counter: verification.authenticationInfo.newCounter }).eq("id", pk.id),
        mintSession(admin, store_id, role, memberCastId),
      ]);
      const { session, userId } = minted;
      return json({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_at: session.expires_at,
        store_id, role, cast_id: memberCastId, user_id: userId,
      }, 200, origin);
    }

    return json({ error: "unknown action" }, 400, origin);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500, origin);
  }
});

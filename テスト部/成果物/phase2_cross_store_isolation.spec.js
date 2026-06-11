// ============================================================
// Phase2 認証モード E2E（店舗間相互不可視確認）
// テスト部 作成: 2026-06-11
//
// 対象: PIN認証モード(?pinauth=<store_id>) + 実Supabase(本番プロジェクト)
// 店舗A: 79b27c03-1ec2-44c0-a61f-a581b0143836（オーナーPIN: 123456）
// 店舗B: 9da06d61-78d0-4094-a742-8267e3efc9a2（オーナーPIN: 654321、識別データ:
//        customers.「テスト店舗B顧客」(customer_no=1)、rooms.「テスト店舗Bルーム」のみ）
//
// 安全策:
// - 各テストでcurrentStoreIdが対象store_idと一致することを確認
// - 書き込みは行わない（既存データの可視性確認のみ）
//
// 実行: npx playwright test テスト部/成果物/phase2_cross_store_isolation.spec.js --browser chromium
// ============================================================

const { test, expect } = require('@playwright/test');

const STORE_A = '79b27c03-1ec2-44c0-a61f-a581b0143836';
const STORE_B = '9da06d61-78d0-4094-a742-8267e3efc9a2';
const PIN_A = '123456';
const PIN_B = '654321';

async function mockSw(page) {
  await page.route('**/sw.js', async route => {
    await route.fulfill({ status: 200, contentType: 'application/javascript', body: '// mock sw' });
  });
}

async function ownerLogin(page, storeId, pin) {
  const url = `http://localhost:3100/index.html?pinauth=${storeId}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);

  await expect(page.locator('#s-top')).toHaveClass(/on/, { timeout: 15000 });
  await page.locator('#s-top button', { hasText: '店舗ログイン' }).click();
  await expect(page.locator('#s-owner-login')).toHaveClass(/on/, { timeout: 5000 });

  await page.locator('#owner-pin').fill(pin);
  await page.locator('#btn-owner').click();

  await expect(page.locator('#s-app')).toHaveClass(/on/, { timeout: 15000 });
}

async function getCustomerAreaText(page) {
  await page.evaluate(() => window.tabMgmt());
  await page.evaluate(() => window.tabMgmtSub('owner-customer'));
  await page.waitForFunction(() => {
    const area = document.getElementById('customer-area');
    return !!area && !area.querySelector('.spin');
  }, { timeout: 15000 });
  const badge = await page.locator('#customer-count-badge').innerText();
  const list = await page.locator('#customer-area').innerText();
  return { badge, list };
}

async function getRoomListText(page) {
  await page.evaluate(() => window.openStoreSettings());
  await expect(page.locator('#store-overlay')).toHaveClass(/on/, { timeout: 10000 });
  await page.waitForTimeout(300);
  const text = await page.locator('#store-room-list').innerText();
  await page.evaluate(() => window.closeSheet('store'));
  return text;
}

test.describe('Phase2 店舗間相互不可視確認（店舗A vs 店舗B）', () => {

  test.beforeEach(async ({ page }) => {
    await mockSw(page);
  });

  // ─── T06: 店舗BログインでcurrentStoreIdが店舗Bと一致（安全確認） ───
  test('T06: currentStoreIdが店舗BのIDと一致する', async ({ page }) => {
    await ownerLogin(page, STORE_B, PIN_B);
    const storeId = await page.evaluate(() => window.currentStoreId ?? currentStoreId);
    expect(storeId).toBe(STORE_B);
    console.log('[T06] currentStoreId:', storeId);
  });

  // ─── T07: 店舗Aから店舗Bのデータが見えない ───
  test('T07: 店舗Aから店舗Bの顧客・ルームが見えない', async ({ page }) => {
    await ownerLogin(page, STORE_A, PIN_A);
    const storeId = await page.evaluate(() => window.currentStoreId ?? currentStoreId);
    expect(storeId).toBe(STORE_A);

    const { badge, list } = await getCustomerAreaText(page);
    console.log('[T07] 店舗Aの顧客バッジ:', badge);
    expect(list).not.toContain('テスト店舗B顧客');

    const roomText = await getRoomListText(page);
    console.log('[T07] 店舗Aのルーム一覧:', roomText.replace(/\n/g, ' / '));
    expect(roomText).not.toContain('テスト店舗Bルーム');

    console.log('[T07] 店舗A→店舗Bデータ非表示: OK');
  });

  // ─── T08: 店舗Bは自店データのみ表示（店舗A・KYOUKANOのデータが混入しない） ───
  test('T08: 店舗Bは自店データのみ表示される', async ({ page }) => {
    await ownerLogin(page, STORE_B, PIN_B);
    const storeId = await page.evaluate(() => window.currentStoreId ?? currentStoreId);
    expect(storeId).toBe(STORE_B);

    const { badge, list } = await getCustomerAreaText(page);
    console.log('[T08] 店舗Bの顧客バッジ:', badge);
    console.log('[T08] 店舗Bの顧客一覧:', list.replace(/\n/g, ' / '));
    // 自店データ(テスト店舗B顧客)のみ1件表示される（店舗A・KYOUKANOのデータが混入していれば2件以上になる）
    expect(badge).toBe('1名登録');
    expect(list).toContain('テスト店舗B顧客');

    const roomText = await getRoomListText(page);
    console.log('[T08] 店舗Bのルーム一覧:', roomText.replace(/\n/g, ' / '));
    expect(roomText).toContain('テスト店舗Bルーム');
    // 店舗Aのルーム名（堀田/金山系）が混入していないか
    expect(roomText).not.toMatch(/堀田|金山/);

    console.log('[T08] 店舗B自店データのみ表示: OK');
  });

});

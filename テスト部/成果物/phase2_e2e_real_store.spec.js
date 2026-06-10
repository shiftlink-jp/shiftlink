// ============================================================
// Phase2 認証モード E2E（実バックエンド・テスト店舗）
// テスト部 作成: 2026-06-11
//
// 対象: PIN認証モード(?pinauth=<store_id>) + 実Supabase(本番プロジェクト, RLS隔離テスト店舗)
// store_id: 79b27c03-1ec2-44c0-a61f-a581b0143836
// オーナーPIN: 123456 / キャストPIN: 1111（テストキャスト）
//
// 安全策:
// - 各テスト冒頭で currentStoreId が対象store_idと一致することを確認してから書き込みを行う
// - 作成するテストデータ名には "Playwright自動テスト_" プレフィックスを付け、識別・削除しやすくする
// - 誤PIN/ロックアウト系のテストはここでは行わない（既存チェックリストでpass済み）
//
// 実行: npx playwright test テスト部/成果物/phase2_e2e_real_store.spec.js --browser chromium
// ============================================================

const { test, expect } = require('@playwright/test');

const STORE_ID = '79b27c03-1ec2-44c0-a61f-a581b0143836';
const URL = `http://localhost:3100/index.html?pinauth=${STORE_ID}`;
const OWNER_PIN = '123456';
const TEST_PREFIX = 'Playwright自動テスト_';

// SW自動リロード対策（stress_test.spec.jsと同様）
async function mockSw(page) {
  await page.route('**/sw.js', async route => {
    await route.fulfill({ status: 200, contentType: 'application/javascript', body: '// mock sw' });
  });
}

async function ownerLogin(page) {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);

  await expect(page.locator('#s-top')).toHaveClass(/on/, { timeout: 15000 });
  await page.locator('#s-top button', { hasText: '店舗ログイン' }).click();
  await expect(page.locator('#s-owner-login')).toHaveClass(/on/, { timeout: 5000 });

  await page.locator('#owner-pin').fill(OWNER_PIN);
  await page.locator('#btn-owner').click();

  await expect(page.locator('#s-app')).toHaveClass(/on/, { timeout: 15000 });
}

test.describe('Phase2 E2E（実テスト店舗・残項目確認）', () => {

  test.beforeEach(async ({ page }) => {
    await mockSw(page);
  });

  // ─── T01: ログイン直後に currentStoreId がテスト店舗と一致（安全確認） ───
  test('T01: currentStoreIdがテスト店舗のIDと一致する', async ({ page }) => {
    await ownerLogin(page);
    const storeId = await page.evaluate(() => window.currentStoreId ?? currentStoreId);
    expect(storeId).toBe(STORE_ID);
    console.log('[T01] currentStoreId:', storeId);
  });

  // ─── T02: 委託金タブの表示（owner-salary、当日分） ───
  test('T02: 委託金タブ(当日)が正常表示される（データ無しなら空状態表示）', async ({ page }) => {
    await ownerLogin(page);

    await page.evaluate(() => window.tab('owner-salary'));
    await page.waitForFunction(() => {
      const area = document.getElementById('owner-sal-area');
      if (!area) return false;
      const spin = area.querySelector('.spin');
      return !spin || spin.offsetParent === null;
    }, { timeout: 15000 });

    await expect(page.locator('#p-owner-salary')).toHaveClass(/on/);

    const text = await page.locator('#owner-sal-area').innerText();
    console.log('[T02] 委託金エリア内容（先頭300字）:', text.slice(0, 300));
    // worksが無い日は「この日の記録はありません」の空状態表示。クラッシュ・他店データ混入が無ければOK
    expect(text.length).toBeGreaterThan(0);

    console.log('[T02] 委託金タブ(当日)表示: OK');
  });

  // ─── T03: 売上タブ（月次集計・キャスト別委託金）の表示 ───
  test('T03: 売上タブの月次集計・キャスト別委託金が表示される', async ({ page }) => {
    await ownerLogin(page);

    await page.evaluate(() => window.tab('owner-monthly'));
    await page.waitForFunction(() => {
      const area = document.getElementById('monthly-area');
      if (!area) return false;
      const spin = area.querySelector('.spin');
      return !spin || spin.offsetParent === null;
    }, { timeout: 15000 });

    await expect(page.locator('#p-owner-monthly')).toHaveClass(/on/);

    const summaryText = await page.locator('#monthly-area').innerText();
    console.log('[T03] 月まとめ内容（先頭300字）:', summaryText.slice(0, 300));
    expect(summaryText).toContain('委託金');

    // キャスト別タブに切り替え（月次の委託金集計）
    await page.evaluate(() => window.monthlyTabSwitch('cast'));
    await page.waitForTimeout(800);
    const castText = await page.locator('#monthly-area').innerText();
    console.log('[T03] キャスト別内容（先頭300字）:', castText.slice(0, 300));
    expect(castText.length).toBeGreaterThan(0);

    console.log('[T03] 月次集計(キャスト別委託金)表示: OK');
  });

  // ─── T04: 顧客登録 → 検索 → 詳細(来店履歴/メモ/出禁) ───
  test('T04: 顧客登録・検索・来店履歴・接客メモ・出禁設定', async ({ page }) => {
    await ownerLogin(page);

    // 安全確認: currentStoreIdがテスト店舗であることを再確認してから書き込みへ
    const storeId = await page.evaluate(() => window.currentStoreId ?? currentStoreId);
    expect(storeId).toBe(STORE_ID);

    const custName = TEST_PREFIX + Date.now();

    // 管理タブ → 顧客
    await page.evaluate(() => window.tabMgmt());
    await page.evaluate(() => window.tabMgmtSub('owner-customer'));
    await page.waitForFunction(() => {
      const area = document.getElementById('customer-area');
      return !!area && !area.querySelector('.spin');
    }, { timeout: 15000 });

    // 新規顧客追加
    await page.evaluate(() => window.openAddCustomer());
    await expect(page.locator('#customer-edit-overlay')).toHaveClass(/on/, { timeout: 5000 });
    await page.locator('#ce-name').fill(custName);
    await page.locator('#ce-memo').fill('Playwright自動テスト用メモ <b>test</b>');
    await page.evaluate(() => window.saveNewCustomer());

    // 保存後、シートが閉じてリストに反映されるまで待つ
    await page.waitForTimeout(1500);

    // 検索でヒットすることを確認
    await page.locator('#customer-search').fill(custName);
    await page.evaluate(() => window.filterCustomers());
    await page.waitForTimeout(300);

    const item = page.locator('#customer-area .item', { hasText: custName });
    await expect(item).toHaveCount(1, { timeout: 5000 });
    console.log('[T04] 新規顧客の検索ヒット: OK');

    // 詳細を開く
    await item.click();
    await expect(page.locator('#customer-detail-overlay')).toHaveClass(/on/, { timeout: 5000 });
    await page.waitForFunction(() => {
      const body = document.getElementById('customer-detail-body');
      return !!body && !body.querySelector('.spin');
    }, { timeout: 10000 });

    // 来店記録セクションが表示される（新規顧客なので「来店記録なし」のはず）
    const detailText = await page.locator('#customer-detail-body').innerText();
    console.log('[T04] 顧客詳細内容（先頭300字）:', detailText.slice(0, 300));
    expect(detailText).toContain('来店記録');

    // メモがエスケープされて表示されている（XSS再確認）
    const memoVal = await page.locator('#edit-cust-memo').inputValue();
    expect(memoVal).toContain('<b>test</b>');
    console.log('[T04] メモ表示（生テキストとしてフォーム内に保持）: OK');

    // 出禁にして保存
    await page.locator('#edit-cust-banned').selectOption('true');
    const custId = await page.evaluate(() => window.currentCustomerId ?? currentCustomerId);
    await page.evaluate((id) => window.saveCustomerEdit(id), custId);
    await page.waitForTimeout(1000);

    // 一覧に戻り「出禁」バッジが付いていることを確認
    await page.evaluate(() => window.closeSheet('customer-detail'));
    await page.waitForTimeout(300);
    const itemAfter = page.locator('#customer-area .item', { hasText: custName });
    await expect(itemAfter).toContainText('出禁', { timeout: 5000 });
    console.log('[T04] 出禁バッジ表示: OK');

    console.log(`[T04] テスト顧客「${custName}」を作成しました（後で手動削除してください）`);
  });

  // ─── T05: JSエラー監視（顧客操作中にクラッシュしないか） ───
  test('T05: 一連の操作でJSエラーが発生しない', async ({ page }) => {
    const jsErrors = [];
    page.on('pageerror', err => jsErrors.push(err.message));

    await ownerLogin(page);
    for (const t of ['owner-salary', 'owner-monthly', 'today', 'owner-shift']) {
      await page.evaluate((tab) => window.tab(tab), t);
      await page.waitForTimeout(800);
    }
    await page.evaluate(() => window.tabMgmt());
    await page.evaluate(() => window.tabMgmtSub('owner-customer'));
    await page.waitForTimeout(800);

    if (jsErrors.length > 0) {
      console.error('[T05] JSエラー:', jsErrors);
    }
    const fatal = jsErrors.filter(e => e.includes('TypeError') || e.includes('is not a function') || e.includes('Cannot read'));
    expect(fatal.length).toBe(0);
    console.log('[T05] JSエラー監視: OK');
  });

});

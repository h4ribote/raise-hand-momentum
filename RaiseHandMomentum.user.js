// ==UserScript==
// @name         Teams Raise Hand Momentum
// @namespace    https://github.com/h4ribote/hand-momentum
// @version      1.0.0
// @description  Teams 会議で他の参加者が挙手したら自動的に自分も挙手するスクリプト
// @author       h4ribote
// @match        https://teams.live.com/*
// @match        https://teams.microsoft.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * ── 調査で判明した Teams のDOM/スタイル構造（teams.live.com light client で確認） ──
 *
 * 1. 挙手ボタン: <button id="raisehands-button" aria-label="手を挙げる">
 *    - .click() で挙手/挙手解除をトグル（直接実行可、メニューは出ない）。
 *    - 自分の挙手状態は「ボタン下部の線」で判定する：
 *        ボタンの ::after 疑似要素が下線で、背景色は常に
 *        --colorCompoundBrandForeground1 (#7f85f5) で固定。
 *        挙手中: transform = matrix(1,0,0,1,0,0)  → scaleX(1)（線が表示）
 *        未挙手: transform = matrix(0,0,0,1,0,0)  → scaleX(0)（線が幅0で非表示）
 *      ※ 色は状態で変わらないため「色」では判定できないが、「線の表示(scaleX)」で判定できる。
 *      ※ ホバー/フォーカスでは scaleX は変化しない（挙手状態専用）ので誤検知しない。
 *      ※ フォールバック: ::after が 'none' のクライアントでは data-track-action-scenario を見る。
 *
 * 2. 参加者一覧(ロスター)パネル ＝ ON/OFFスイッチ ＆ 挙手者カウント源:
 *      [data-tid="calling-roster-attendees"][role="tree"]   … パネルが開いている時のみ存在
 *    - パネル開閉の判定: 上記要素の有無（roster-button の aria-pressed 等は変化しないので不可）。
 *    - 挙手者の数: 挙手中の参加者ごとに
 *          <span id="roster-raise-hand-icon-<参加者ID>" aria-label="手で挙げた位置 N">
 *      が1つ出現する。よって [id^="roster-raise-hand-icon-"] の個数 ＝ 挙手者数（言語非依存）。
 *
 * ── このスクリプトの仕様（ユーザー指定） ──
 *  - 参加者一覧パネルの表示/非表示 = スクリプトのON/OFFスイッチ（開いている間だけ動作）。
 *  - 挙手者の人数は roster-raise-hand-icon-* の数で把握する。
 *  - 自分の挙手状態は挙手ボタン下線(::after)の表示状態で判定する。
 *  - 「他人の挙手数」 = (挙手者数) − (自分が挙手していれば1)。自分の表示名は不要。
 *  - 他人の挙手数 >= しきい値 かつ 自分が未挙手 なら、ボタンを click して挙手する。
 *  - しきい値は左下パネルの "+"/"-" ボタンで調整できる（localStorage に保存）。
 */

(function () {
  'use strict';

  // ─────────────── 設定（必要に応じて変更） ───────────────
  const CONFIG = {
    pollMs: 1500,              // 監視間隔(ms)
    requireOthers: 1,          // 他の何人が挙手したら自分も挙げるか（初期値。画面の +/- で変更可）
    cooldownMs: 3000,          // 操作後のクールダウン(ms)。連打/誤検知防止
    autoLower: true,          // 挙手数が閾値を下回ったら、自分が自動で挙げた手も下げる
    lowerOnDisable: false,     // 参加者一覧を閉じた(OFF)とき、自動で挙げた手を下げる
    showStatus: true,          // 左下に小さなステータス/操作パネルを出すか
  };
  const STORAGE_KEY = 'autoRaiseThreshold';
  // ──────────────────────────────────────────────────────

  const log = (...a) => console.log('%c[AutoRaise]', 'color:#6264a7;font-weight:bold', ...a);

  // しきい値（実行中に +/- で変更。localStorage から復元）
  let threshold = (() => {
    const saved = parseInt(localStorage.getItem(STORAGE_KEY), 10);
    return Number.isFinite(saved) && saved >= 1 ? saved : CONFIG.requireOthers;
  })();
  function setThreshold(v) {
    threshold = Math.max(1, v | 0);
    try { localStorage.setItem(STORAGE_KEY, String(threshold)); } catch (e) {}
    renderThreshold();
    log('しきい値を変更: 他' + threshold + '人以上');
  }

  let autoRaisedByScript = false;   // スクリプトが挙げた手かどうか
  let lastActionAt = 0;

  // 挙手ボタンを取得（ライトクライアント優先、フォールバックあり）
  function getRaiseButton() {
    const b = document.getElementById('raisehands-button');
    if (b) return b;
    return Array.from(document.querySelectorAll('button[aria-label]'))
      .find(x => /手を挙げる|手を下げる|raise.*hand|lower.*hand|挙手/i.test(x.getAttribute('aria-label') || '')) || null;
  }

  // 参加者一覧パネルが開いているか ＝ ON/OFF スイッチ
  function isRosterOpen() {
    return !!document.querySelector('[data-tid="calling-roster-attendees"]');
  }

  // 挙手者数 ＝ roster-raise-hand-icon-* の個数（ロスターが開いている時のみ存在）
  function countRaisedHands() {
    return document.querySelectorAll('[id^="roster-raise-hand-icon-"]').length;
  }

  // 自分の手が挙がっているか ＝ 挙手ボタン下線(::after)が表示されているか
  function isMyHandUp(btn) {
    if (!btn) return false;
    // ::after の transform=scaleX で判定（挙手時のみ scaleX(1) で線が出る。色は常に #7f85f5）
    const m = getComputedStyle(btn, '::after').transform.match(/matrix\(\s*([-\d.]+)/);
    if (m) return parseFloat(m[1]) > 0.5;
    // フォールバック（::after が無いクライアント、例: teams.microsoft.com フル版）
    const sc = btn.getAttribute('data-track-action-scenario') || '';
    if (/lower/i.test(sc)) return true;   // 「手を下げる」シナリオ＝現在挙手中
    if (/raise/i.test(sc)) return false;  // 「手を挙げる」シナリオ＝現在未挙手
    return false;
  }

  function raiseMyHand(btn, reason) {
    btn.click();
    autoRaisedByScript = true;
    lastActionAt = Date.now();
    log('✋ 挙手しました:', reason);
  }

  function lowerMyHand(btn, reason) {
    btn.click();
    autoRaisedByScript = false;
    lastActionAt = Date.now();
    log('🖐 手を下げました:', reason);
  }

  function tick() {
    const btn = getRaiseButton();
    const rosterOpen = isRosterOpen();

    // ── OFF（参加者一覧が閉じている）── 監視停止
    if (!rosterOpen) {
      if (CONFIG.lowerOnDisable && btn && autoRaisedByScript && isMyHandUp(btn)) {
        lowerMyHand(btn, 'OFF化(参加者一覧を閉じた)');
      }
      updateStatus({ rosterOpen: false });
      return;
    }
    if (!btn) { updateStatus({ rosterOpen: true, noButton: true }); return; }

    if (Date.now() - lastActionAt < CONFIG.cooldownMs) {
      updateStatus({ rosterOpen: true, others: '…', mine: null });
      return;
    }

    const myHandUp = isMyHandUp(btn);
    const raisedCount = countRaisedHands();
    const othersRaised = Math.max(0, raisedCount - (myHandUp ? 1 : 0));

    if (othersRaised >= threshold && !myHandUp) {
      raiseMyHand(btn, `他${othersRaised}人が挙手（しきい値${threshold}）`);
    } else if (CONFIG.autoLower && myHandUp && autoRaisedByScript) {
      lowerMyHand(btn, '他の全員が手を下げた');
    }

    updateStatus({ rosterOpen: true, others: othersRaised, mine: myHandUp });
  }

  // ─────────────── 左下のステータス/操作パネル ───────────────
  let statusEl = null, titleLine = null, othersLine = null, mineLine = null, thrValueEl = null, minusBtn = null;
  function makeBtn(label, onClick) {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText =
      'width:22px;height:22px;line-height:1;cursor:pointer;border:0;border-radius:5px;' +
      'background:#5b5fc7;color:#fff;font:bold 14px/1 system-ui,sans-serif;' +
      'display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto';
    b.onmouseenter = () => { b.style.background = '#6f74e0'; };
    b.onmouseleave = () => { b.style.background = minusBtn === b && threshold <= 1 ? '#444' : '#5b5fc7'; };
    b.onclick = onClick;
    return b;
  }
  function ensureStatusEl() {
    if (!CONFIG.showStatus || statusEl) return;
    statusEl = document.createElement('div');
    statusEl.id = '__autoRaiseStatus';
    statusEl.style.cssText =
      'position:fixed;left:14px;bottom:14px;z-index:2147483647;' +
      'background:rgba(43,43,58,.94);color:#fff;font:12px/1.5 system-ui,sans-serif;' +
      'padding:8px 11px;border-radius:9px;box-shadow:0 3px 12px rgba(0,0,0,.45);' +
      'white-space:pre-line;max-width:260px;user-select:none';

    titleLine = document.createElement('div');
    titleLine.style.fontWeight = 'bold';

    // しきい値調整行： 閾値 他 [−] N人以上 [＋]
    const thrRow = document.createElement('div');
    thrRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin:5px 0';
    const thrLabel = document.createElement('span');
    thrLabel.textContent = '閾値 他';
    minusBtn = makeBtn('−', () => setThreshold(threshold - 1));
    thrValueEl = document.createElement('span');
    thrValueEl.style.cssText = 'min-width:42px;text-align:center;font-weight:bold';
    const plusBtn = makeBtn('＋', () => setThreshold(threshold + 1));
    thrRow.append(thrLabel, minusBtn, thrValueEl, plusBtn);

    othersLine = document.createElement('div');
    mineLine = document.createElement('div');

    statusEl.append(titleLine, thrRow, othersLine, mineLine);
    document.body.appendChild(statusEl);
    renderThreshold();
  }
  function renderThreshold() {
    if (thrValueEl) thrValueEl.textContent = threshold + '人以上';
    if (minusBtn) { minusBtn.disabled = threshold <= 1; minusBtn.style.background = threshold <= 1 ? '#444' : '#5b5fc7'; minusBtn.style.cursor = threshold <= 1 ? 'default' : 'pointer'; }
  }
  function updateStatus(s) {
    if (!CONFIG.showStatus) return;
    ensureStatusEl();
    if (!statusEl) return;
    if (!s.rosterOpen) {
      statusEl.style.opacity = '.75';
      titleLine.textContent = '✋ 自動挙手: OFF（参加者一覧を開くと開始）';
      othersLine.textContent = '';
      mineLine.textContent = '';
      return;
    }
    statusEl.style.opacity = '1';
    titleLine.textContent = '✋ 自動挙手: 監視中';
    if (s.noButton) { othersLine.textContent = '（会議外）'; mineLine.textContent = ''; return; }
    othersLine.textContent = (s.others !== undefined && s.others !== null) ? ('他の挙手: ' + s.others + '人') : '';
    mineLine.textContent = (s.mine !== null && s.mine !== undefined) ? ('自分: ' + (s.mine ? '挙手中' : '未挙手')) : '';
  }

  setInterval(tick, CONFIG.pollMs);
  log('起動 v5: 参加者一覧の開閉でON/OFF。pollMs=' + CONFIG.pollMs + ', しきい値=他' + threshold + '人以上');
})();

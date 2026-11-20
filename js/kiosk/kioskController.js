/**
 * ==============================================================================
 * [NodOrder Kiosk] kioskController.js  v2.0  (4단계 주문 흐름 + 2D 그리드)
 * ------------------------------------------------------------------------------
 * 주문 단계 (step):
 *   'dine_in'   → STEP 1: 매장/포장 선택  (LEFT=포장, RIGHT=매장, MOUTH_OPEN 1초=확정)
 *   'menu'      → STEP 2: 메뉴 선택       (LEFT/RIGHT/UP/DOWN 2D 그리드,
 *                                           MOUTH_OPEN 1초=담기, TILT_CW=확인단계, TILT_CCW=이전단계)
 *   'confirm'   → STEP 3: 주문 확인       (LEFT=아니오, RIGHT=예, MOUTH_OPEN 1초=확정)
 *   'complete'  → STEP 4: 주문 완료       (5초 뒤 자동 초기화)
 *
 * 그리드: 메뉴 8개, COLS=2 → 4행 2열
 * ==============================================================================
 */

export const KIOSK_MENU = [
  { id: 'm1', name: '아메리카노',  category: 'coffee',   price: 3000, desc: '고소하고 깔끔한 에스프레소',           icon: '☕' },
  { id: 'm2', name: '카페라떼',   category: 'coffee',   price: 3800, desc: '부드러운 스팀밀크와 커피의 조화',       icon: '🥛' },
  { id: 'm3', name: '바닐라라떼', category: 'coffee',   price: 4300, desc: '달콤한 바닐라 향 가득한 라떼',         icon: '🍨' },
  { id: 'm4', name: '자몽에이드', category: 'beverage', price: 4500, desc: '상큼하고 톡 쏘는 생자몽 스파클링',     icon: '🍹' },
  { id: 'm5', name: '녹차라떼',   category: 'beverage', price: 4200, desc: '제주 유기농 녹차의 진한 풍미',         icon: '🍵' },
  { id: 'm6', name: '치즈케이크', category: 'dessert',  price: 5000, desc: '꾸덕하고 진한 뉴욕 스타일 치즈케이크', icon: '🍰' },
  { id: 'm7', name: '초코쿠키',   category: 'dessert',  price: 2500, desc: '벨기에 초콜릿 칩이 듬뿍 박힌 쿠키',   icon: '🍪' },
  { id: 'm8', name: '크로플',     category: 'dessert',  price: 4500, desc: '바삭하고 쫄깃한 버터 크루아상 와플',   icon: '🧇' },
];

const COLS = 2;

export class KioskController {
  constructor(options = {}) {
    this.menu         = KIOSK_MENU;
    this.focusIndex   = 0;
    this.confirmFocus = 1; // 0=아니오, 1=예
    this.cart         = [];
    this.totalPrice   = 0;
    this.dineInType   = null; // 'DINE_IN' | 'TAKEOUT'
    this.step         = 'dine_in';

    this.isLocked      = false;
    this.lastActionTime = 0;
    this.cooldownMs    = options.cooldownMs   || 600;
    this.minConfidence = options.minConfidence || 0.60;

    // MOUTH_OPEN 1초 유지
    this.mouthHoldMs     = options.mouthHoldMs ?? 1000;
    this.mouthOpenStart  = null;
    this.mouthProgress   = 0;
    this.mouthHoldLocked = false;

    this.lastActionMessage = '잠시만요, 로딩 중입니다...';
    this.onActionTriggered = options.onActionTriggered || (() => {});
    this.onStateChange     = options.onStateChange     || (() => {});
    this.audioCtx = null;
  }

  /* ───── Audio ───── */
  _getAudioContext() {
    if (!this.audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.audioCtx = new AC();
    }
    if (this.audioCtx && this.audioCtx.state === 'suspended') this.audioCtx.resume();
    return this.audioCtx;
  }

  _playSound(type) {
    try {
      const ctx = this._getAudioContext();
      if (!ctx) return;
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      const t = ctx.currentTime;
      if (type === 'move') {
        osc.frequency.setValueAtTime(480, t);
        gain.gain.setValueAtTime(0.12, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
        osc.start(t); osc.stop(t + 0.08);
      } else if (type === 'select') {
        osc.frequency.setValueAtTime(784, t); osc.frequency.setValueAtTime(1046, t + 0.07);
        gain.gain.setValueAtTime(0.18, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
        osc.start(t); osc.stop(t + 0.22);
      } else if (type === 'clear') {
        osc.frequency.setValueAtTime(300, t);
        osc.frequency.exponentialRampToValueAtTime(180, t + 0.18);
        gain.gain.setValueAtTime(0.14, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
        osc.start(t); osc.stop(t + 0.18);
      } else if (type === 'checkout') {
        osc.frequency.setValueAtTime(523, t); osc.frequency.setValueAtTime(659, t + 0.08);
        osc.frequency.setValueAtTime(784, t + 0.16);
        gain.gain.setValueAtTime(0.20, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
        osc.start(t); osc.stop(t + 0.35);
      }
    } catch (_) {}
  }

  /* ───── 메인 제스처 핸들러 ───── */
  handleGesture(prediction) {
    if (!prediction) return null;
    const { label, confidence } = prediction;
    const now = performance.now();

    if (label === 'NEUTRAL') {
      this.isLocked = false;
      this._resetMouthTimer();
      return null;
    }

    // MOUTH_OPEN은 updateMouthProgress()가 처리
    if (label === 'MOUTH_OPEN') return null;

    if (this.isLocked) return null;
    if (now - this.lastActionTime < this.cooldownMs) return null;
    if (confidence < this.minConfidence) return null;

    let result = null;
    if      (this.step === 'dine_in') result = this._handleDineIn(label);
    else if (this.step === 'menu')    result = this._handleMenu(label);
    else if (this.step === 'confirm') result = this._handleConfirm(label);

    if (result) {
      this.isLocked = true;
      this.lastActionTime = now;
      this.onActionTriggered(result);
      this.onStateChange(this.getState());
    }
    return result;
  }

  /* ───── MOUTH_OPEN 1초 타이머 (매 프레임 호출) ───── */
  updateMouthProgress(isMouthOpen, now) {
    if (!isMouthOpen) {
      this._resetMouthTimer();
      return { progress: 0, fired: false };
    }
    if (this.mouthHoldLocked) return { progress: 0, fired: false };

    if (this.mouthOpenStart === null) this.mouthOpenStart = now;
    const elapsed = now - this.mouthOpenStart;
    const progress = Math.min(elapsed / this.mouthHoldMs, 1.0);
    this.mouthProgress = progress;

    if (progress >= 1.0) {
      this.mouthHoldLocked = true;
      const result = this._executeMouthAction();
      if (result) {
        this.onActionTriggered(result);
        this.onStateChange(this.getState());
      }
      return { progress: 1, fired: true, action: result };
    }
    return { progress, fired: false };
  }

  _resetMouthTimer() {
    this.mouthOpenStart  = null;
    this.mouthProgress   = 0;
    this.mouthHoldLocked = false;
  }

  _executeMouthAction() {
    if (this.step === 'dine_in') return this._confirmDineIn();
    if (this.step === 'menu')    return this._addFocusedToCart();
    if (this.step === 'confirm') return this.confirmFocus === 1 ? this._placeOrder() : this._backToMenu();
    return null;
  }

  /* ───── STEP 1: 매장/포장 ───── */
  _handleDineIn(label) {
    if (label === 'LEFT') {
      this.dineInType = 'TAKEOUT';
      this.lastActionMessage = '🥡 [포장] 선택됨 — 입을 1초 벌려 확정하세요';
      this._playSound('move');
      return { action: 'DINE_IN_SELECT', value: 'TAKEOUT' };
    }
    if (label === 'RIGHT') {
      this.dineInType = 'DINE_IN';
      this.lastActionMessage = '🏠 [매장] 선택됨 — 입을 1초 벌려 확정하세요';
      this._playSound('move');
      return { action: 'DINE_IN_SELECT', value: 'DINE_IN' };
    }
    if (label === 'TILT_CW') return this._confirmDineIn();
    return null;
  }

  _confirmDineIn() {
    if (!this.dineInType) this.dineInType = 'DINE_IN';
    this.step = 'menu';
    this.focusIndex = 0;
    const lbl = this.dineInType === 'DINE_IN' ? '매장' : '포장';
    this.lastActionMessage = `✅ [${lbl}] 선택 완료 — 메뉴를 고르세요!`;
    this._playSound('select');
    return { action: 'STEP_MENU', dineInType: this.dineInType };
  }

  /* ───── STEP 2: 메뉴 선택 ───── */
  _handleMenu(label) {
    const rows = Math.ceil(this.menu.length / COLS);
    const col  = this.focusIndex % COLS;
    const row  = Math.floor(this.focusIndex / COLS);

    if (label === 'LEFT') {
      if (col > 0) {
        this.focusIndex = row * COLS + col - 1;
        this._playSound('move');
        this.lastActionMessage = `👈 ${this.menu[this.focusIndex].name}`;
        return { action: 'FOCUS_MOVE', direction: 'LEFT', item: this.menu[this.focusIndex] };
      }
      return null;
    }
    if (label === 'RIGHT') {
      const ni = row * COLS + col + 1;
      if (col + 1 < COLS && ni < this.menu.length) {
        this.focusIndex = ni;
        this._playSound('move');
        this.lastActionMessage = `👉 ${this.menu[this.focusIndex].name}`;
        return { action: 'FOCUS_MOVE', direction: 'RIGHT', item: this.menu[this.focusIndex] };
      }
      return null;
    }
    if (label === 'UP') {
      if (row > 0) {
        this.focusIndex = (row - 1) * COLS + col;
        this._playSound('move');
        this.lastActionMessage = `👆 ${this.menu[this.focusIndex].name}`;
        return { action: 'FOCUS_MOVE', direction: 'UP', item: this.menu[this.focusIndex] };
      }
      return null;
    }
    if (label === 'DOWN') {
      const ni = (row + 1) * COLS + col;
      if (row + 1 < rows && ni < this.menu.length) {
        this.focusIndex = ni;
        this._playSound('move');
        this.lastActionMessage = `👇 ${this.menu[this.focusIndex].name}`;
        return { action: 'FOCUS_MOVE', direction: 'DOWN', item: this.menu[this.focusIndex] };
      }
      return null;
    }
    if (label === 'TILT_CW') {
      if (this.cart.length === 0) {
        this.lastActionMessage = '⚠️ 장바구니가 비어 있습니다. 먼저 메뉴를 담아주세요!';
        return null;
      }
      return this._goToConfirm();
    }
    if (label === 'TILT_CCW') return this._backToDineIn();
    return null;
  }

  _addFocusedToCart() {
    const item = this.menu[this.focusIndex];
    const ex   = this.cart.find(c => c.item.id === item.id);
    if (ex) ex.count++; else this.cart.push({ item, count: 1 });
    this._calculateTotal();
    this._playSound('select');
    this.lastActionMessage = `🛒 ${item.name} 추가! (총 ${this.totalPrice.toLocaleString()}원)`;
    return { action: 'ITEM_ADDED', item };
  }

  /* ───── STEP 3: 주문 확인 ───── */
  _handleConfirm(label) {
    if (label === 'LEFT') {
      this.confirmFocus = 0;
      this._playSound('move');
      this.lastActionMessage = '❌ [아니오] 선택 — 입을 1초 벌려 확정 시 메뉴로 돌아갑니다';
      return { action: 'CONFIRM_FOCUS', value: 'NO' };
    }
    if (label === 'RIGHT') {
      this.confirmFocus = 1;
      this._playSound('move');
      this.lastActionMessage = '✅ [예] 선택 — 입을 1초 벌려 확정 시 주문 완료';
      return { action: 'CONFIRM_FOCUS', value: 'YES' };
    }
    // 마지막 확인 단계에는 다음 주문 단계가 없으므로 기울임으로 주문을 확정하지 않습니다.
    if (label === 'TILT_CW')  return null;
    if (label === 'TILT_CCW') return this._backToMenu();
    return null;
  }

  _placeOrder() {
    const orderId = `ORD-${Date.now().toString().slice(-4)}`;
    const summary = { orderId, items: [...this.cart], totalPrice: this.totalPrice, dineInType: this.dineInType };
    this.lastActionMessage = `🎉 주문 완료! 주문번호: ${orderId}  총 ${this.totalPrice.toLocaleString()}원`;
    this._playSound('checkout');
    this.step = 'complete';
    return { action: 'ORDER_COMPLETED', summary };
  }

  _backToMenu() {
    this.step = 'menu';
    this.confirmFocus = 1;
    this.lastActionMessage = '↩️ 메뉴 선택으로 돌아왔습니다.';
    this._playSound('clear');
    return { action: 'STEP_MENU_BACK' };
  }

  _goToConfirm() {
    this.step = 'confirm';
    this.confirmFocus = 1;
    this.lastActionMessage = '📋 주문 확인 — 고개 오른쪽(예) / 왼쪽(아니오), 입 벌려 확정';
    this._playSound('move');
    return { action: 'STEP_CONFIRM' };
  }

  _backToDineIn() {
    this.step = 'dine_in';
    this.lastActionMessage = '↩️ 매장/포장 선택으로 돌아왔습니다.';
    this._playSound('clear');
    return { action: 'STEP_DINE_IN_BACK' };
  }

  /* ───── 전체 초기화 ───── */
  resetAll() {
    this.cart = []; this.totalPrice = 0;
    this.focusIndex = 0; this.confirmFocus = 1;
    this.dineInType = null; this.step = 'dine_in';
    this.isLocked = false;
    // 입을 계속 벌린 상태에서 자동 초기화되어도 재선택되지 않도록 잠금 유지
    if (!this.mouthHoldLocked) this._resetMouthTimer();
    this.lastActionMessage = '새 주문을 시작합니다. 매장/포장을 선택해 주세요.';
    this.onStateChange(this.getState());
  }

  clearCart() {
    this.cart = []; this.totalPrice = 0;
    this.lastActionMessage = '🗑 장바구니를 모두 비웠습니다.';
    this._playSound('clear');
  }

  _calculateTotal() {
    this.totalPrice = this.cart.reduce((s, e) => s + e.item.price * e.count, 0);
  }

  getState() {
    return {
      step: this.step, dineInType: this.dineInType,
      menu: this.menu, focusIndex: this.focusIndex, focusedItem: this.menu[this.focusIndex],
      confirmFocus: this.confirmFocus,
      cart: [...this.cart],
      totalCount: this.cart.reduce((s, c) => s + c.count, 0),
      totalPrice: this.totalPrice,
      lastMessage: this.lastActionMessage,
      isLocked: this.isLocked,
      mouthProgress: this.mouthProgress,
    };
  }
}

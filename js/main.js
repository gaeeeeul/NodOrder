/**
 * ==============================================================================
 * [NodOrder Main Controller] main.js  v2.1
 * - 선택 시간: 1초 (1000ms)
 * - 고객 화면: KNN 수치 숨김, 한국어 동작 라벨
 * - 게이지: 키오스크 콘텐츠 중앙 오버레이
 * - TILT 방향: CCW(왼쪽기울임)=이전단계, CW(오른쪽기울임)=다음단계
 * ==============================================================================
 */

import { CameraManager }         from './core/camera.js';
import { FaceLandmarkerService } from './core/faceLandmarker.js';
import { FeatureExtractor }      from './core/featureExtractor.js';
import { GestureDetector, GESTURE_CONFIG } from './core/gestureDetector.js';
import { AutoCalibrationCountdown } from './core/autoCalibration.js';
import { KNNClassifier }         from './classifiers/knnClassifier.js';
import { KioskController }       from './kiosk/kioskController.js';

// 고객에게 보이는 한국어 동작 이름 (영어 라벨 노출 없음)
const LABEL_KO = {
  NEUTRAL:    '정면 응시 중',
  LEFT:       '고개 왼쪽으로 돌리기',
  RIGHT:      '고개 오른쪽으로 돌리기',
  UP:         '고개 위로 들기',
  DOWN:       '고개 아래로 내리기',
  TILT_CCW:   '고개 왼쪽으로 기울이기',
  TILT_CW:    '고개 오른쪽으로 기울이기',
  MOUTH_OPEN: '입 1초 벌리기',
};

const LABEL_COLOR = {
  NEUTRAL:    '#10b981',
  LEFT:       '#38bdf8',
  RIGHT:      '#38bdf8',
  UP:         '#818cf8',
  DOWN:       '#818cf8',
  TILT_CCW:   '#f59e0b',
  TILT_CW:    '#f59e0b',
  MOUTH_OPEN: '#ec4899',
};

class NodOrderApp {
  constructor() {
    // ── 코어 서비스 ──
    this.cameraManager    = new CameraManager();
    this.faceLandmarker   = new FaceLandmarkerService();
    this.featureExtractor = new FeatureExtractor();
    this.gestureDetector  = new GestureDetector(GESTURE_CONFIG);
    this.knnClassifier    = new KNNClassifier(5);
    this.kioskController  = new KioskController({
      mouthHoldMs: 1000,   // ★ 선택 시간 1초
    });

    // ── DOM ──
    this.videoElement  = document.getElementById('webcam-video');
    this.canvasElement = document.getElementById('overlay-canvas');
    this.ctx           = this.canvasElement.getContext('2d');

    // 링 게이지
    this.gaugeOverlay  = document.getElementById('mouth-gauge-overlay');
    this.gaugeCanvas   = document.getElementById('gauge-canvas');
    this.gaugeCtx      = this.gaugeCanvas ? this.gaugeCanvas.getContext('2d') : null;
    this.gaugeLabel    = document.getElementById('gauge-label');

    // 버튼
    this.btnStartCamera    = document.getElementById('btn-start-camera');
    this.btnStopCamera     = document.getElementById('btn-stop-camera');
    this.btnCalibrate      = document.getElementById('btn-calibrate');
    this.btnResetCalibrate = document.getElementById('btn-reset-calibrate');
    this.autoCalibOverlay = document.getElementById('auto-calib-overlay');
    this.autoCalibCount = document.getElementById('auto-calib-count');
    this.autoCalibText = document.getElementById('auto-calib-text');
    this.autoCalibCountdown = new AutoCalibrationCountdown();
    this._autoCalibDisplayed = '';

    // 상태 뱃지
    this.statusBadge       = document.getElementById('status-badge');
    this.calibBadge        = document.getElementById('calib-badge');
    this.fpsDisplay        = document.getElementById('fps-display');
    this.resolutionDisplay = document.getElementById('resolution-display');
    this.knnLatencyDisplay = document.getElementById('knn-latency-display');
    this.knnModelStatus    = document.getElementById('knn-model-status');

    // AI 판정 (한국어 — 고객용)
    this.knnPredictedLabel = document.getElementById('knn-predicted-label');
    this.knnConfidenceText = document.getElementById('knn-confidence-text');
    this.aiConfBar         = document.getElementById('ai-conf-bar');

    // 숨겨진 개발자 DOM (JS에서 갱신하지만 화면에 안 보임)
    this.valNoseDx        = document.getElementById('val-nose-dx');
    this.valNoseDy        = document.getElementById('val-nose-dy');
    this.valHeadTilt      = document.getElementById('val-head-tilt');
    this.valMouthMar      = document.getElementById('val-mouth-mar');
    this.dirNoseDx        = document.getElementById('dir-nose-dx');
    this.dirNoseDy        = document.getElementById('dir-nose-dy');
    this.dirHeadTilt      = document.getElementById('dir-head-tilt');
    this.dirMouthMar      = document.getElementById('dir-mouth-mar');
    this.valFeatureVector = document.getElementById('val-feature-vector');
    this.knnNeighborVotesContainer = document.getElementById('knn-neighbor-votes-container');

    // 키오스크 단계 패널
    this.stepPanels = {
      dine_in:  document.getElementById('step-dine-in'),
      menu:     document.getElementById('step-menu'),
      confirm:  document.getElementById('step-confirm'),
      complete: document.getElementById('step-complete'),
    };

    this.kioskToastText   = document.getElementById('kiosk-toast-text');
    this.kioskMenuGrid    = document.getElementById('kiosk-menu-grid');
    this.kioskCartItems   = document.getElementById('kiosk-cart-items');
    this.kioskTotalPrice  = document.getElementById('kiosk-total-price');
    this.kioskTotalCount  = document.getElementById('kiosk-total-count');
    this.btnKioskCheckout = document.getElementById('btn-kiosk-checkout');

    // 렌더링 상태
    this.animationFrameId    = null;
    this.latestLandmarks     = null;
    this.latestFeatures      = null;
    this.latestKnnPrediction = null;
    this.frameCount          = 0;
    this.lastFpsUpdate       = performance.now();
    this.currentFps          = 0;
    this._completeTimer      = null;
    this._gaugeSuccessUntil  = 0;
    this._modelsReady = false;
    this._modelsPromise = null;
    this._starting = false;
    this._lastProcessedVideoTime = -1;
  }

  /* ═══════════════════════════════
     초기화
  ═══════════════════════════════ */
  async init() {
    window.__nodOrderApp = this; // 카메라 부트스트랩에서 기존 얼굴 인식 흐름 호출
    this._bindEvents();
    this._renderKioskMenu();
    this._updateKioskDisplay();
    this.cameraManager.onEnded = () => {
      this.stop();
      this._updateStatus('카메라 연결이 끊겼습니다. 다시 켜 주세요.', 'error');
    };
    // 카메라 권한 요청은 CDN 모델 다운로드와 독립적으로 시작할 수 있어야 합니다.
    this.btnStartCamera.disabled = false;
    this._updateStatus('카메라를 켜면 기준 자세가 자동으로 설정됩니다', 'ready');
    this._prepareModels();
  }

  _prepareModels() {
    if (this._modelsReady) return Promise.resolve();
    if (this._modelsPromise) return this._modelsPromise;
    this._modelsPromise = (async () => {
      await this.knnClassifier.loadModel('models/knn/knn_model.json');
      if (this.knnModelStatus) this.knnModelStatus.textContent = '얼굴 인식 준비 중';
      await this.faceLandmarker.init();
      this._modelsReady = true;
      if (this.knnModelStatus) this.knnModelStatus.textContent = '서비스 준비 완료';
    })().catch(error => {
      console.error('[NodOrderApp] 모델 초기화 실패:', error);
      this._modelsPromise = null; // 다음 카메라 시작에서 재시도 가능
      if (this.knnModelStatus) this.knnModelStatus.textContent = '모델 연결 확인 필요';
      if (this.cameraManager.getStreamingStatus()) {
        this._updateStatus('얼굴 인식 모델을 불러오지 못했습니다. 인터넷 연결 확인 후 다시 켜 주세요.', 'error');
      }
      return Promise.reject(error);
    });
    // 사용자가 버튼을 누르지 않아도 모델 로드를 시작하지만, 오류를 미처리 Promise로 남기지 않습니다.
    this._modelsPromise.catch(() => {});
    return this._modelsPromise;
  }

  /* ═══════════════════════════════
     이벤트 바인딩
  ═══════════════════════════════ */
  _bindEvents() {
    // 시작 버튼은 cameraBootstrap.js가 독립적으로 연결합니다.
    this.btnStopCamera.addEventListener('click',     () => this.stop());
    this.btnCalibrate.addEventListener('click',      () => this.calibrateNeutralPose());
    this.btnResetCalibrate.addEventListener('click', () => this.resetCalibration());

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && this.cameraManager.getStreamingStatus()) {
        e.preventDefault();
        this.calibrateNeutralPose();
      }
    });

    if (this.btnKioskCheckout) {
      this.btnKioskCheckout.addEventListener('click', () => {
        if (this.kioskController.cart.length > 0) {
          const result = this.kioskController._goToConfirm();
          this._updateKioskDisplay(result);
        } else {
          alert('장바구니가 비어 있습니다. 먼저 메뉴를 선택해 주세요.');
        }
      });
    }

    const btnNew = document.getElementById('btn-new-order');
    if (btnNew) btnNew.addEventListener('click', () => this._startNewOrder());

    window.addEventListener('resize', () => this._syncCanvasSize());
  }

  /* ═══════════════════════════════
     웹캠 시작 / 정지
  ═══════════════════════════════ */
  async start() {
    if (this._starting || this.cameraManager.getStreamingStatus()) return;
    this._starting = true;
    this.btnStartCamera.disabled = true;
    try {
      this._updateStatus('카메라 연결 중...', 'warning');
      await this.cameraManager.start(this.videoElement, { width: 640, height: 480, frameRate: 30 });
      this._syncCanvasSize();
      this.btnStopCamera.disabled = false;
      this.btnCalibrate.disabled = false;
      this.btnResetCalibrate.disabled = false;
      this._updateStatus('얼굴 인식 준비 중...', 'warning');
      // 영상 미리보기는 먼저 재생하고, 모델 로딩이 끝난 뒤에만 추론을 시작합니다.
      await this._prepareModels();
      if (!this.cameraManager.getStreamingStatus()) return;
      this.faceLandmarker.lastVideoTime = -1;
      this._lastProcessedVideoTime = -1;
      this.autoCalibCountdown.reset();
      this._updateStatus('얼굴을 찾고 있습니다 · 정면을 바라봐 주세요', 'running');
      this._startRenderLoop();
    } catch (err) {
      console.error('[NodOrderApp] 시작 실패:', err);
      const message = this.cameraManager.getStreamingStatus()
        ? `카메라는 켜졌지만 얼굴 인식 모델을 준비하지 못했습니다: ${err.message}`
        : err.message;
      this._updateStatus(message, 'error');
      this.stop();
      this._updateStatus(message, 'error');
      // 알림창 대신 화면의 상태 문구를 표시합니다.
    } finally {
      this._starting = false;
      if (!this.cameraManager.getStreamingStatus()) this.btnStartCamera.disabled = false;
    }
  }

  stop() {
    if (this.animationFrameId) { cancelAnimationFrame(this.animationFrameId); this.animationFrameId = null; }
    this.cameraManager.stop();
    this.latestLandmarks = null;
    this._lastProcessedVideoTime = -1;
    this.kioskController.updateMouthProgress(false, performance.now());
    this._gaugeSuccessUntil = 0;
    this._renderGauge(0, false);
    this._resetAutoCalibrationUi();
    this.btnStartCamera.disabled = false;
    this.btnStopCamera.disabled = true;
    this.btnCalibrate.disabled = true;
    this._clearCanvas();
    this._updateStatus('카메라 정지됨', 'ready');
  }

  /* ═══════════════════════════════
     캘리브레이션
  ═══════════════════════════════ */
  calibrateNeutralPose() {
    if (!this.latestLandmarks) {
      alert('화면에 얼굴이 감지되지 않았습니다. 카메라 정면을 바라본 후 다시 시도해 주세요.');
      return;
    }
    try {
      this.featureExtractor.calibrate(this.latestLandmarks);
      this._resetAutoCalibrationUi();
      this.gestureDetector.reset();
      this.kioskController.updateMouthProgress(false, performance.now());
      this._updateStatus('기준 자세 설정 완료 · 머리 움직임으로 주문해 주세요', 'running');
      if (this.calibBadge) {
        this.calibBadge.textContent = '기준 자세 설정 완료';
        this.calibBadge.className   = 'badge badge-success';
      }
      if (this.kioskToastText) {
        this.kioskToastText.textContent = '🎯 기준 자세 설정 완료! 이제 고개를 움직여 조작하세요.';
      }
    } catch (err) {
      alert(`기준 자세 설정 실패: ${err.message}`);
    }
  }

  resetCalibration() {
    this.featureExtractor.resetCalibration();
    this._resetAutoCalibrationUi();
    this.gestureDetector.reset();
    this.kioskController.updateMouthProgress(false, performance.now());
    this._renderGauge(0, false);
    if (this.calibBadge) {
      this.calibBadge.textContent = '기준 자세 설정 필요';
      this.calibBadge.className   = 'badge badge-warning';
    }
    this.latestKnnPrediction = null;
    if (this.knnPredictedLabel) {
      this.knnPredictedLabel.textContent = '대기 중';
      this.knnPredictedLabel.style.color = '#94a3b8';
    }
  }

  /* ═══════════════════════════════
     실시간 렌더링 루프
  ═══════════════════════════════ */
  _startRenderLoop() {
    const loop = () => {
      if (!this.cameraManager.getStreamingStatus()) return;
      // 화면 갱신 속도(보통 60Hz)와 카메라 프레임 속도(보통 30Hz)는 다릅니다.
      // 같은 영상 프레임을 얼굴 미검출로 오인하면 1초 입 벌림 타이머가 매번 초기화됩니다.
      if (this.videoElement.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
          this.videoElement.currentTime === this._lastProcessedVideoTime) {
        this.animationFrameId = requestAnimationFrame(loop);
        return;
      }
      this._lastProcessedVideoTime = this.videoElement.currentTime;
      this._calculateFps();

      const now       = performance.now();
      const landmarks = this.faceLandmarker.detect(this.videoElement, now);
      if (this.faceLandmarker.lastError) {
        this._updateStatus(`얼굴 인식 오류: ${this.faceLandmarker.lastError.message}`, 'error');
        this.faceLandmarker.lastError = null;
      }
      this.latestLandmarks = landmarks;
      this._clearCanvas();

      if (landmarks) {
        this._handleAutoCalibration(true, now);
        const features = this.featureExtractor.extractFeatures(landmarks, now);
        this.latestFeatures = features;

        let knnResult   = null;
        let kioskAction = null;

        if (features && features.isCalibrated && this.knnClassifier.isReady()) {
          knnResult = this.knnClassifier.predict(features.featureVector);
          this.latestKnnPrediction = knnResult;

          // MOUTH_OPEN 1초 타이머
          const isMouthOpen = knnResult && knnResult.label === 'MOUTH_OPEN' && knnResult.confidence >= 0.60;
          const mouthResult = this.kioskController.updateMouthProgress(isMouthOpen, now);
          if (mouthResult.fired) this._gaugeSuccessUntil = now + 650;
          const showSuccess = mouthResult.fired || now < this._gaugeSuccessUntil;
          this._renderGauge(showSuccess ? 1 : mouthResult.progress, showSuccess);

          // 일반 제스처 처리 (MOUTH_OPEN은 위에서 처리)
          if (!isMouthOpen) {
            kioskAction = this.kioskController.handleGesture(knnResult);
          }

          // UI 갱신
          this._updateKNNDisplay(knnResult);
          if (kioskAction || mouthResult.fired) {
            this._updateKioskDisplay(kioskAction || mouthResult.action);
          }
        } else {
          this.kioskController.updateMouthProgress(false, now);
          this._renderGauge(0, false);
        }

        // 숨겨진 수치 DOM 갱신 (기능 유지용)
        this._updateHiddenMetrics(features);
        // 캔버스 오버레이
        this._renderLandmarksOverlay(features, knnResult);
      } else {
        this._handleAutoCalibration(false, now);
        this.kioskController.updateMouthProgress(false, now);
        this._handleFaceNotDetected();
        this._renderGauge(0, false);
      }

      this.animationFrameId = requestAnimationFrame(loop);
    };
    this.animationFrameId = requestAnimationFrame(loop);
  }

  /* ═══════════════════════════════
     비접촉 자동 기준 자세 설정 (얼굴 인식 후 5초)
  ═══════════════════════════════ */
  _resetAutoCalibrationUi() {
    this.autoCalibCountdown.reset();
    this._autoCalibDisplayed = '';
    if (this.autoCalibOverlay) this.autoCalibOverlay.hidden = true;
  }

  _handleAutoCalibration(faceDetected, now) {
    if (this.featureExtractor.isCalibrated) {
      if (this.autoCalibOverlay && !this.autoCalibOverlay.hidden) this.autoCalibOverlay.hidden = true;
      return;
    }
    const result = this.autoCalibCountdown.update(faceDetected, now);
    if (result.state === 'complete') {
      // 호출 시점에는 최신 MediaPipe 랜드마크가 존재합니다.
      this.calibrateNeutralPose();
      return;
    }
    if (!this.autoCalibOverlay) return;
    const stateKey = `${result.state}:${result.seconds}`;
    if (stateKey === this._autoCalibDisplayed) return;
    this._autoCalibDisplayed = stateKey;
    this.autoCalibOverlay.hidden = false;
    if (result.state === 'counting') {
      this.autoCalibText.textContent = '정면을 보고 준비하세요';
      this.autoCalibCount.textContent = String(result.seconds);
      this._updateStatus(`기준 자세 자동 설정 중 · ${result.seconds}초`, 'warning');
    } else if (result.state === 'paused') {
      this.autoCalibText.textContent = '얼굴이 보이지 않습니다 · 정면을 바라봐 주세요';
      this.autoCalibCount.textContent = '…';
      this._updateStatus('얼굴 위치를 확인하고 있습니다', 'warning');
    } else {
      this.autoCalibText.textContent = '카메라 정면에 얼굴을 맞춰 주세요';
      this.autoCalibCount.textContent = '○';
      this._updateStatus('얼굴을 찾고 있습니다', 'warning');
    }
  }

  /* ═══════════════════════════════
     링 게이지 렌더링 (고객용 — 큰 오버레이)
  ═══════════════════════════════ */
  _renderGauge(progress, fired) {
    if (!this.gaugeOverlay || !this.gaugeCtx) return;

    if (progress <= 0 && !fired) {
      this.gaugeOverlay.style.display = 'none';
      return;
    }

    this.gaugeOverlay.style.display = 'flex';

    const ctx = this.gaugeCtx;
    const W = 200, H = 200, cx = W / 2, cy = H / 2, r = 82;
    ctx.clearRect(0, 0, W, H);

    // 반투명 배경 원
    ctx.beginPath(); ctx.arc(cx, cy, r + 14, 0, 2 * Math.PI);
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fill();

    // 배경 트랙
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 12; ctx.stroke();

    // 진행 호 (시계 방향)
    if (progress > 0) {
      const startAngle = -Math.PI / 2;
      const endAngle   = startAngle + progress * 2 * Math.PI;
      const color = fired ? '#10b981' : '#38bdf8';
      ctx.beginPath(); ctx.arc(cx, cy, r, startAngle, endAngle);
      ctx.strokeStyle = color; ctx.lineWidth = 12; ctx.lineCap = 'round'; ctx.stroke();
    }

    // 중앙 텍스트
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (fired) {
      ctx.fillStyle = '#10b981';
      ctx.font = 'bold 36px sans-serif';
      ctx.fillText('✓', cx, cy);
    } else {
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 28px sans-serif';
      ctx.fillText(`${Math.round(progress * 100)}%`, cx, cy);
    }

    this.gaugeLabel.textContent = fired ? '✅ 선택 완료!' : '선택 중...';
    this.gaugeLabel.style.color = fired ? '#10b981' : '#fff';
  }

  /* ═══════════════════════════════
     키오스크 UI 갱신 (단계 전환)
  ═══════════════════════════════ */
  _updateKioskDisplay(kioskAction) {
    const state = this.kioskController.getState();

    // 패널 전환
    Object.entries(this.stepPanels).forEach(([key, el]) => {
      if (!el) return;
      el.style.display = key === state.step ? '' : 'none';
    });

    // 단계 진행 바
    this._updateStepDots(state.step);

    // 토스트
    if (this.kioskToastText && state.lastMessage) {
      this.kioskToastText.textContent = state.lastMessage;
    }

    // 단계별 렌더링
    if      (state.step === 'dine_in')  this._renderDineIn(state);
    else if (state.step === 'menu')     this._renderMenu(state);
    else if (state.step === 'confirm')  this._renderConfirm(state);
    else if (state.step === 'complete') this._renderComplete(state, kioskAction);
  }

  _updateStepDots(currentStep) {
    const steps = ['dine_in', 'menu', 'confirm', 'complete'];
    const idx   = steps.indexOf(currentStep);
    steps.forEach((s, i) => {
      const dot = document.getElementById(`step-dot-${i + 1}`);
      if (!dot) return;
      dot.classList.remove('active', 'done');
      if (i < idx)       dot.classList.add('done');
      else if (i === idx) dot.classList.add('active');
    });
    for (let i = 1; i <= 3; i++) {
      const line = document.getElementById(`step-line-${i}${i + 1}`);
      if (line) line.classList.toggle('done', i < idx + 1);
    }
  }

  _renderDineIn(state) {
    const tbtn = document.getElementById('dine-btn-takeout');
    const dbtn = document.getElementById('dine-btn-dinein');
    if (tbtn) tbtn.classList.toggle('is-focused', state.dineInType === 'TAKEOUT');
    if (dbtn) dbtn.classList.toggle('is-focused', state.dineInType === 'DINE_IN');
  }

  _renderMenu(state) {
    if (this.kioskMenuGrid) {
      this.kioskMenuGrid.querySelectorAll('.menu-card').forEach((card, idx) => {
        card.classList.toggle('is-focused', idx === state.focusIndex);
      });
    }
    if (this.kioskCartItems) {
      this.kioskCartItems.innerHTML = state.cart.length === 0
        ? '<span class="cart-empty-text">장바구니가 비어 있습니다.</span>'
        : state.cart.map(c =>
            `<div class="cart-item-chip"><span>${c.item.icon} ${c.item.name}</span><span class="cart-item-count">×${c.count}</span></div>`
          ).join('');
    }
    if (this.kioskTotalPrice) this.kioskTotalPrice.textContent = `${state.totalPrice.toLocaleString()}원`;
    if (this.kioskTotalCount) this.kioskTotalCount.textContent = `(${state.totalCount}개)`;
  }

  _renderConfirm(state) {
    const summary = document.getElementById('confirm-order-summary');
    if (summary) {
      const dineLabel = state.dineInType === 'DINE_IN' ? '🏠 매장' : '🥡 포장';
      summary.innerHTML = `
        <div class="confirm-summary-row"><span>주문 방식</span><span>${dineLabel}</span></div>
        ${state.cart.map(c => `
          <div class="confirm-summary-row">
            <span>${c.item.icon} ${c.item.name} ×${c.count}</span>
            <span>${(c.item.price * c.count).toLocaleString()}원</span>
          </div>`).join('')}
        <div class="confirm-summary-row total"><span>총 합계</span><span>${state.totalPrice.toLocaleString()}원</span></div>
      `;
    }
    const noBtn  = document.getElementById('confirm-btn-no');
    const yesBtn = document.getElementById('confirm-btn-yes');
    if (noBtn)  noBtn.classList.toggle('is-focused',  state.confirmFocus === 0);
    if (yesBtn) yesBtn.classList.toggle('is-focused', state.confirmFocus === 1);
  }

  _renderComplete(state, kioskAction) {
    if (kioskAction && kioskAction.action === 'ORDER_COMPLETED') {
      const { summary } = kioskAction;
      const idEl  = document.getElementById('complete-order-id');
      const sumEl = document.getElementById('complete-summary');
      if (idEl)  idEl.textContent  = `주문번호: ${summary.orderId}`;
      if (sumEl) sumEl.textContent = `총 ${summary.totalPrice.toLocaleString()}원`;
      this._startCompleteCountdown();
    }
  }

  _startCompleteCountdown() {
    if (this._completeTimer) clearInterval(this._completeTimer);
    let remaining = 5;
    const el = document.getElementById('complete-countdown');
    if (el) el.textContent = remaining;
    this._completeTimer = setInterval(() => {
      remaining--;
      if (el) el.textContent = remaining;
      if (remaining <= 0) {
        clearInterval(this._completeTimer);
        this._completeTimer = null;
        this._startNewOrder();
      }
    }, 1000);
  }

  _startNewOrder() {
    if (this._completeTimer) { clearInterval(this._completeTimer); this._completeTimer = null; }
    this.kioskController.resetAll();
    // 이전 주문자의 기준 자세가 다음 주문자에게 적용되지 않도록 초기화합니다.
    this.resetCalibration();
    this._gaugeSuccessUntil = 0;
    this._renderGauge(0, false);
    this._updateKioskDisplay();
  }

  /* ═══════════════════════════════
     메뉴 그리드 초기 렌더링
  ═══════════════════════════════ */
  _renderKioskMenu() {
    if (!this.kioskMenuGrid) return;
    this.kioskMenuGrid.innerHTML = '';
    this.kioskController.menu.forEach((item, index) => {
      const isFocused = index === this.kioskController.focusIndex;
      const card = document.createElement('div');
      card.className     = `menu-card ${isFocused ? 'is-focused' : ''}`;
      card.dataset.index = index;
      card.innerHTML = `
        <div class="focus-indicator-badge">👉 현재 선택 대상</div>
        <div class="menu-card-top">
          <span class="menu-icon">${item.icon}</span>
          <span class="menu-price">${item.price.toLocaleString()}원</span>
        </div>
        <div class="menu-name">${item.name}</div>
        <div class="menu-desc">${item.desc}</div>
      `;
      card.addEventListener('click', () => {
        this.kioskController.focusIndex = index;
        this.kioskController._addFocusedToCart();
        this._updateKioskDisplay({ action: 'ITEM_ADDED', item });
      });
      this.kioskMenuGrid.appendChild(card);
    });
  }

  /* ═══════════════════════════════
     AI 판정 표시 (고객용 한국어, 개발 수치 없음)
  ═══════════════════════════════ */
  _updateKNNDisplay(knnResult) {
    if (!knnResult) return;

    const ko    = LABEL_KO[knnResult.label] || '동작을 인식하고 있습니다';
    const color = LABEL_COLOR[knnResult.label] || '#38bdf8';
    const pct   = Math.round(knnResult.confidence * 100);

    if (this.knnPredictedLabel) {
      this.knnPredictedLabel.textContent = ko;
      this.knnPredictedLabel.style.color = color;
    }
    if (this.knnConfidenceText) {
      this.knnConfidenceText.textContent = `${pct}%`;
    }
    if (this.aiConfBar) {
      this.aiConfBar.style.width = `${pct}%`;
    }
    if (this.knnLatencyDisplay) {
      this.knnLatencyDisplay.textContent = `AI: ${knnResult.inferenceTimeMs}ms`;
    }
  }

  /* ═══════════════════════════════
     숨겨진 수치 DOM 갱신 (기능 유지용 — 화면에 표시 안 됨)
  ═══════════════════════════════ */
  _updateHiddenMetrics(features) {
    if (!features) return;
    const { metrics, featureVector } = features;
    if (this.valNoseDx)        this.valNoseDx.textContent        = metrics.noseDeltaX.toFixed(4);
    if (this.valNoseDy)        this.valNoseDy.textContent        = metrics.noseDeltaY.toFixed(4);
    if (this.valHeadTilt)      this.valHeadTilt.textContent      = metrics.headTiltDeg.toFixed(2);
    if (this.valMouthMar)      this.valMouthMar.textContent      = metrics.mouthOpenRatio.toFixed(4);
    if (this.valFeatureVector) this.valFeatureVector.textContent = JSON.stringify(featureVector);
  }

  /* ═══════════════════════════════
     캔버스 오버레이 (랜드마크)
  ═══════════════════════════════ */
  _renderLandmarksOverlay(features, knnResult) {
    const w   = this.canvasElement.width;
    const h   = this.canvasElement.height;
    const ctx = this.ctx;
    const { keyLandmarks, baseline, isCalibrated } = features;

    // 두 눈
    const lEye = { x: keyLandmarks.rightEyeOuter.x * w, y: keyLandmarks.rightEyeOuter.y * h };
    const rEye = { x: keyLandmarks.leftEyeOuter.x  * w, y: keyLandmarks.leftEyeOuter.y  * h };
    ctx.beginPath(); ctx.moveTo(lEye.x, lEye.y); ctx.lineTo(rEye.x, rEye.y);
    ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 2.5; ctx.stroke();
    this._drawCircle(lEye.x, lEye.y, 4, '#60a5fa');
    this._drawCircle(rEye.x, rEye.y, 4, '#60a5fa');

    // 입
    const uLip = { x: keyLandmarks.upperLip.x * w, y: keyLandmarks.upperLip.y * h };
    const lLip = { x: keyLandmarks.lowerLip.x * w, y: keyLandmarks.lowerLip.y * h };
    ctx.beginPath(); ctx.moveTo(uLip.x, uLip.y); ctx.lineTo(lLip.x, lLip.y);
    ctx.strokeStyle = '#ec4899'; ctx.lineWidth = 2.5; ctx.stroke();
    this._drawCircle(uLip.x, uLip.y, 3, '#f472b6');
    this._drawCircle(lLip.x, lLip.y, 3, '#f472b6');

    // 코끝
    const curNose = { x: keyLandmarks.noseTip.x * w, y: keyLandmarks.noseTip.y * h };
    if (isCalibrated && baseline) {
      const baseNose = { x: baseline.noseX * w, y: baseline.noseY * h };
      this._drawCircle(baseNose.x, baseNose.y, 5, 'rgba(16,185,129,0.5)', true);
      ctx.beginPath(); ctx.moveTo(baseNose.x, baseNose.y); ctx.lineTo(curNose.x, curNose.y);
      ctx.strokeStyle = '#10b981'; ctx.lineWidth = 2; ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]);
    }
    this._drawTarget(curNose.x, curNose.y, 7, '#ef4444');
  }

  _drawCircle(x, y, r, color, fill = true) {
    this.ctx.beginPath(); this.ctx.arc(x, y, r, 0, 2 * Math.PI);
    if (fill) { this.ctx.fillStyle = color; this.ctx.fill(); }
    else       { this.ctx.strokeStyle = color; this.ctx.lineWidth = 2; this.ctx.stroke(); }
  }

  _drawTarget(x, y, r, color) {
    this.ctx.beginPath(); this.ctx.arc(x, y, r, 0, 2 * Math.PI);
    this.ctx.fillStyle = color; this.ctx.fill();
    this.ctx.strokeStyle = '#fff'; this.ctx.lineWidth = 1.5;
    this.ctx.beginPath();
    this.ctx.moveTo(x - r - 3, y); this.ctx.lineTo(x + r + 3, y);
    this.ctx.moveTo(x, y - r - 3); this.ctx.lineTo(x, y + r + 3);
    this.ctx.stroke();
  }

  /* ═══════════════════════════════
     기타 헬퍼
  ═══════════════════════════════ */
  _handleFaceNotDetected() {
    if (this.knnPredictedLabel) {
      this.knnPredictedLabel.textContent = '얼굴을 카메라에 맞춰주세요';
      this.knnPredictedLabel.style.color = '#ef4444';
    }
    if (this.knnConfidenceText) this.knnConfidenceText.textContent = '0%';
    if (this.aiConfBar)         this.aiConfBar.style.width = '0%';
  }

  _syncCanvasSize() {
    if (this.videoElement && this.videoElement.videoWidth) {
      this.canvasElement.width  = this.videoElement.videoWidth;
      this.canvasElement.height = this.videoElement.videoHeight;
      if (this.resolutionDisplay) {
        this.resolutionDisplay.textContent = `${this.videoElement.videoWidth}×${this.videoElement.videoHeight}`;
      }
    }
  }

  _calculateFps() {
    this.frameCount++;
    const now = performance.now(), elapsed = now - this.lastFpsUpdate;
    if (elapsed >= 1000) {
      this.currentFps = Math.round((this.frameCount * 1000) / elapsed);
      if (this.fpsDisplay) this.fpsDisplay.textContent = `${this.currentFps} FPS`;
      this.frameCount = 0; this.lastFpsUpdate = now;
    }
  }

  _clearCanvas() { this.ctx.clearRect(0, 0, this.canvasElement.width, this.canvasElement.height); }

  _updateStatus(text, type = 'ready') {
    if (this.statusBadge) { this.statusBadge.textContent = text; this.statusBadge.className = `badge badge-${type}`; }
  }
}

function bootNodOrderApp() {
  try {
    const app = new NodOrderApp();
    Promise.resolve(app.init()).catch(err => {
      console.error('[NodOrder] 앱 초기화 실패:', err);
      const info = document.getElementById('camera-connection-status');
      if (info) info.textContent = `앱 초기화 실패: ${err.message}`;
    });
  } catch (err) {
    console.error('[NodOrder] 앱 생성 실패:', err);
    const info = document.getElementById('camera-connection-status');
    if (info) info.textContent = `앱 초기화 실패: ${err.message}`;
  }
}

// 모듈 스크립트가 DOMContentLoaded 이후 실행되더라도 초기화가 누락되지 않게 합니다.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootNodOrderApp, { once: true });
} else {
  bootNodOrderApp();
}

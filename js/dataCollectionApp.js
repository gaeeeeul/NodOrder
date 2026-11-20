/**
 * ==============================================================================
 * [NodOrder Data] dataCollectionApp.js
 * ------------------------------------------------------------------------------
 * 역할:
 * 1. data-collection.html 페이지의 UI 이벤트 및 데이터 수집 파이프라인 조율
 * 2. 웹캠 및 MediaPipe 실시간 연동 (카메라 시작/중지, 랜드마크 캔버스 시각화)
 * 3. FeatureExtractor로부터 추출된 정규화 특징 벡터를 CollectorEngine에 실시간 공급
 * 4. 트라이얼 완료 시 IndexedDB에 실시간 자동 영구 저장
 * 5. 참가자별 및 전체 통합 JSON/CSV 다운로드 및 데이터베이스 관리
 * 6. 개인정보 보호 안내 및 동의 확인 처리
 * ==============================================================================
 */

import { CameraManager } from './core/camera.js';
import { FaceLandmarkerService } from './core/faceLandmarker.js';
import { FeatureExtractor } from './core/featureExtractor.js';
import { DatasetStorage } from './data/storage.js';
import { CollectorEngine, COLLECTION_ACTIONS } from './data/collectorEngine.js';

class DataCollectionApp {
  constructor() {
    // 코어 서비스 인스턴스
    this.cameraManager = new CameraManager();
    this.faceLandmarker = new FaceLandmarkerService();
    this.featureExtractor = new FeatureExtractor();
    this.storage = new DatasetStorage();

    // 최신 특징값 캐시
    this.latestFeatures = null;
    this.latestLandmarks = null;
    this.animationFrameId = null;

    // 수집 엔진
    this.collector = new CollectorEngine({
      participantId: 'P01',
      getCurrentFeatures: () => this.latestFeatures,
      onStateChange: (state) => this._handleStateChange(state),
      onSampleRecorded: (data) => this._handleSampleRecorded(data),
      onTrialComplete: (data) => this._handleTrialComplete(data),
      onAllComplete: (data) => this._handleAllComplete(data),
      onError: (msg) => alert(`오류 발생: ${msg}`)
    });

    // DOM 캐싱
    this._cacheDomElements();
  }

  /**
   * DOM 요소 참조 캐싱
   * @private
   */
  _cacheDomElements() {
    // 비디오 & 캔버스
    this.videoElement = document.getElementById('webcam-video');
    this.canvasElement = document.getElementById('overlay-canvas');
    this.ctx = this.canvasElement.getContext('2d');

    // 카메라 및 캘리브레이션 버튼
    this.btnStartCamera = document.getElementById('btn-start-camera');
    this.btnStopCamera = document.getElementById('btn-stop-camera');
    this.btnCalibrate = document.getElementById('btn-calibrate');
    this.calibBadge = document.getElementById('calib-badge');
    this.cameraStatusBadge = document.getElementById('camera-status-badge');

    // 참가자 설정 및 수집 제어 버튼
    this.inputParticipantId = document.getElementById('input-participant-id');
    this.btnStartCollection = document.getElementById('btn-start-collection');
    this.btnPauseCollection = document.getElementById('btn-pause-collection');
    this.btnStopCollection = document.getElementById('btn-stop-collection');

    // 시각적 안내 카드 요소
    this.actionName = document.getElementById('action-name');
    this.actionIcon = document.getElementById('action-icon');
    this.actionDesc = document.getElementById('action-desc');
    this.phaseBadge = document.getElementById('phase-badge');
    this.countdownDisplay = document.getElementById('countdown-display');
    this.actionRepetition = document.getElementById('action-repetition');
    this.overallProgressText = document.getElementById('overall-progress-text');
    this.overallProgressBar = document.getElementById('overall-progress-bar');
    this.collectionStatusMessage = document.getElementById('collection-status-message');

    // 실시간 수치 표시 DOM
    this.valNoseDx = document.getElementById('val-nose-dx');
    this.valNoseDy = document.getElementById('val-nose-dy');
    this.valHeadTilt = document.getElementById('val-head-tilt');
    this.valMouthMar = document.getElementById('val-mouth-mar');
    this.valFeatureVector = document.getElementById('val-feature-vector');

    // 샘플 카운터
    this.trialSampleCount = document.getElementById('trial-sample-count');
    this.totalSampleCount = document.getElementById('total-sample-count');

    // 데이터 관리 및 다운로드 버튼
    this.participantTableBody = document.getElementById('participant-table-body');
    this.btnDownloadJsonCurrent = document.getElementById('btn-download-json-current');
    this.btnDownloadCsvCurrent = document.getElementById('btn-download-csv-current');
    this.btnDownloadJsonAll = document.getElementById('btn-download-json-all');
    this.btnDownloadCsvAll = document.getElementById('btn-download-csv-all');
    this.btnClearAllData = document.getElementById('btn-clear-all-data');

    // 개인정보 보호 동의 모달
    this.consentModal = document.getElementById('consent-modal');
    this.consentCheckbox = document.getElementById('consent-checkbox');
    this.btnAgreeConsent = document.getElementById('btn-agree-consent');
  }

  /**
   * 앱 초기화
   */
  async init() {
    this._bindEvents();

    try {
      // 1. IndexedDB 연결
      await this.storage.init();
      await this._refreshParticipantTable();

      // 2. MediaPipe 모델 로드
      this.cameraStatusBadge.textContent = '모델 로딩 중...';
      this.cameraStatusBadge.className = 'badge badge-warning';
      await this.faceLandmarker.init();

      this.cameraStatusBadge.textContent = '준비 완료 (카메라를 켜주세요)';
      this.cameraStatusBadge.className = 'badge badge-ready';
      this.btnStartCamera.disabled = false;
    } catch (err) {
      console.error('[DataCollectionApp] 초기화 오류:', err);
      this.cameraStatusBadge.textContent = `초기화 실패: ${err.message}`;
      this.cameraStatusBadge.className = 'badge badge-error';
    }
  }

  /**
   * 이벤트 리스너 바인딩
   * @private
   */
  _bindEvents() {
    // 카메라 제어
    this.btnStartCamera.addEventListener('click', () => this.startCamera());
    this.btnStopCamera.addEventListener('click', () => this.stopCamera());
    this.btnCalibrate.addEventListener('click', () => this.calibratePose());

    // 단축키 (스페이스바: 캘리브레이션)
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && this.cameraManager.getStreamingStatus() && !this.collector.isRunning) {
        e.preventDefault();
        this.calibratePose();
      }
    });

    // 참가자 ID 변경
    this.inputParticipantId.addEventListener('change', () => {
      const pid = this.inputParticipantId.value.trim().toUpperCase() || 'P01';
      this.inputParticipantId.value = pid;
      this.collector.setParticipantId(pid);
    });

    // 수집 제어
    this.btnStartCollection.addEventListener('click', () => this.startCollection());
    this.btnPauseCollection.addEventListener('click', () => this.collector.togglePause());
    this.btnStopCollection.addEventListener('click', () => this.collector.stop());

    // 다운로드 및 데이터 관리
    this.btnDownloadJsonCurrent.addEventListener('click', () => this._downloadCurrent('json'));
    this.btnDownloadCsvCurrent.addEventListener('click', () => this._downloadCurrent('csv'));
    this.btnDownloadJsonAll.addEventListener('click', () => this._downloadAll('json'));
    this.btnDownloadCsvAll.addEventListener('click', () => this._downloadAll('csv'));
    this.btnClearAllData.addEventListener('click', () => this._clearAllData());

    // 개인정보 보호 동의 모달
    this.consentCheckbox.addEventListener('change', () => {
      this.btnAgreeConsent.disabled = !this.consentCheckbox.checked;
    });
    this.btnAgreeConsent.addEventListener('click', () => {
      this.consentModal.style.display = 'none';
      sessionStorage.setItem('nodorder_consent_agreed', 'true');
    });

    // 세션 내 이미 동의했다면 모달 숨김
    if (sessionStorage.getItem('nodorder_consent_agreed') === 'true') {
      this.consentModal.style.display = 'none';
    }
  }

  /**
   * 웹캠 시작
   */
  async startCamera() {
    try {
      this.btnStartCamera.disabled = true;
      this.cameraStatusBadge.textContent = '카메라 연결 중...';
      this.cameraStatusBadge.className = 'badge badge-warning';

      await this.cameraManager.start(this.videoElement, { width: 640, height: 480, frameRate: 30 });

      this.canvasElement.width = this.videoElement.videoWidth;
      this.canvasElement.height = this.videoElement.videoHeight;

      this.btnStopCamera.disabled = false;
      this.btnCalibrate.disabled = false;
      this.cameraStatusBadge.textContent = '카메라 작동 중';
      this.cameraStatusBadge.className = 'badge badge-running';

      this._startRenderLoop();
    } catch (err) {
      console.error('[DataCollectionApp] 카메라 시작 실패:', err);
      alert(`카메라 실행 오류: ${err.message}`);
      this.btnStartCamera.disabled = false;
      this.cameraStatusBadge.textContent = '카메라 연결 실패';
      this.cameraStatusBadge.className = 'badge badge-error';
    }
  }

  /**
   * 웹캠 정지
   */
  stopCamera() {
    if (this.collector.isRunning) {
      this.collector.stop();
    }
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    this.cameraManager.stop();
    this.btnStartCamera.disabled = false;
    this.btnStopCamera.disabled = true;
    this.btnCalibrate.disabled = true;
    this.btnStartCollection.disabled = true;
    this.cameraStatusBadge.textContent = '카메라 정지됨';
    this.cameraStatusBadge.className = 'badge badge-ready';
    this.ctx.clearRect(0, 0, this.canvasElement.width, this.canvasElement.height);
  }

  /**
   * 정면 중립 자세 캘리브레이션
   */
  calibratePose() {
    if (!this.latestLandmarks) {
      alert('얼굴이 인식되지 않았습니다. 카메라 정면을 바라본 후 다시 시도해 주세요.');
      return;
    }

    try {
      this.featureExtractor.calibrate(this.latestLandmarks);
      this.calibBadge.textContent = '설정 완료 (준비됨)';
      this.calibBadge.className = 'badge badge-success';
      this.btnStartCollection.disabled = false;
      this.collectionStatusMessage.textContent = '정면 캘리브레이션이 완료되었습니다. [수집 시작] 버튼을 누르세요.';
    } catch (err) {
      alert(`캘리브레이션 실패: ${err.message}`);
    }
  }

  /**
   * 실시간 영상 추적 루프
   * @private
   */
  _startRenderLoop() {
    const loop = () => {
      if (!this.cameraManager.getStreamingStatus()) return;

      const now = performance.now();
      const landmarks = this.faceLandmarker.detect(this.videoElement, now);
      this.latestLandmarks = landmarks;

      this.ctx.clearRect(0, 0, this.canvasElement.width, this.canvasElement.height);

      if (landmarks) {
        const features = this.featureExtractor.extractFeatures(landmarks, now);
        this.latestFeatures = features;

        this._updateTelemetry(features);
        this._renderOverlay(features);
      } else {
        this.latestFeatures = null;
      }

      this.animationFrameId = requestAnimationFrame(loop);
    };

    this.animationFrameId = requestAnimationFrame(loop);
  }

  /**
   * 실시간 특징값 수치 표시
   * @private
   */
  _updateTelemetry(features) {
    if (!features) return;
    const { metrics, featureVector } = features;

    const signX = metrics.noseDeltaX > 0 ? '+' : '';
    const signY = metrics.noseDeltaY > 0 ? '+' : '';
    const signTilt = metrics.headTiltDeg > 0 ? '+' : '';

    this.valNoseDx.textContent = `${signX}${metrics.noseDeltaX.toFixed(4)}`;
    this.valNoseDy.textContent = `${signY}${metrics.noseDeltaY.toFixed(4)}`;
    this.valHeadTilt.textContent = `${signTilt}${metrics.headTiltDeg.toFixed(2)}°`;
    this.valMouthMar.textContent = metrics.mouthOpenRatio.toFixed(4);
    this.valFeatureVector.textContent = JSON.stringify(featureVector);
  }

  /**
   * 캔버스 랜드마크 시각화
   * @private
   */
  _renderOverlay(features) {
    const w = this.canvasElement.width;
    const h = this.canvasElement.height;
    const { keyLandmarks, baseline, isCalibrated } = features;

    // 두 눈 연결선
    const leftEye = { x: keyLandmarks.rightEyeOuter.x * w, y: keyLandmarks.rightEyeOuter.y * h };
    const rightEye = { x: keyLandmarks.leftEyeOuter.x * w, y: keyLandmarks.leftEyeOuter.y * h };

    this.ctx.beginPath();
    this.ctx.moveTo(leftEye.x, leftEye.y);
    this.ctx.lineTo(rightEye.x, rightEye.y);
    this.ctx.strokeStyle = '#3b82f6';
    this.ctx.lineWidth = 2.5;
    this.ctx.stroke();

    // 입술 연결선
    const upperLip = { x: keyLandmarks.upperLip.x * w, y: keyLandmarks.upperLip.y * h };
    const lowerLip = { x: keyLandmarks.lowerLip.x * w, y: keyLandmarks.lowerLip.y * h };
    this.ctx.beginPath();
    this.ctx.moveTo(upperLip.x, upperLip.y);
    this.ctx.lineTo(lowerLip.x, lowerLip.y);
    this.ctx.strokeStyle = '#ec4899';
    this.ctx.lineWidth = 2.5;
    this.ctx.stroke();

    // 코끝 타겟 및 변위선
    const currentNose = { x: keyLandmarks.noseTip.x * w, y: keyLandmarks.noseTip.y * h };

    if (isCalibrated && baseline) {
      const baseNose = { x: baseline.noseX * w, y: baseline.noseY * h };
      // 기준점 고스트
      this.ctx.beginPath();
      this.ctx.arc(baseNose.x, baseNose.y, 6, 0, 2 * Math.PI);
      this.ctx.fillStyle = 'rgba(16, 185, 129, 0.4)';
      this.ctx.fill();

      // 변위 점선
      this.ctx.beginPath();
      this.ctx.moveTo(baseNose.x, baseNose.y);
      this.ctx.lineTo(currentNose.x, currentNose.y);
      this.ctx.strokeStyle = '#10b981';
      this.ctx.lineWidth = 2;
      this.ctx.setLineDash([4, 4]);
      this.ctx.stroke();
      this.ctx.setLineDash([]);
    }

    // 현재 코끝 타겟
    this.ctx.beginPath();
    this.ctx.arc(currentNose.x, currentNose.y, 7, 0, 2 * Math.PI);
    this.ctx.fillStyle = '#ef4444';
    this.ctx.fill();
  }

  /**
   * 수집 시퀀스 시작
   */
  startCollection() {
    if (!this.featureExtractor.isCalibrated) {
      alert('데이터 수집 전에 먼저 [중립 자세 캘리브레이션]을 완료해 주세요.');
      return;
    }

    const pid = this.inputParticipantId.value.trim().toUpperCase() || 'P01';
    this.collector.setParticipantId(pid);

    this.btnStartCollection.disabled = true;
    this.btnPauseCollection.disabled = false;
    this.btnStopCollection.disabled = false;
    this.inputParticipantId.disabled = true;

    this.collector.start();
  }

  /**
   * 수집 상태 변경 핸들러
   * @private
   */
  _handleStateChange(state) {
    const { phase, trial, currentTrialNum, totalTrials, currentRep, totalReps, remainingSec, message } = state;

    this.collectionStatusMessage.textContent = message || '';

    // 진행률 계산
    if (currentTrialNum && totalTrials) {
      const progressPct = Math.round(((currentTrialNum - 1) / totalTrials) * 100);
      this.overallProgressText.textContent = `${currentTrialNum} / ${totalTrials} 트라이얼 (${progressPct}%)`;
      this.overallProgressBar.style.width = `${progressPct}%`;
    }

    if (phase === 'PREPARING') {
      this.phaseBadge.textContent = '준비 카운트다운';
      this.phaseBadge.className = 'badge badge-warning';
      this.countdownDisplay.textContent = `${remainingSec}초`;
      this.countdownDisplay.style.color = '#f59e0b';

      if (trial) {
        this.actionName.textContent = trial.action.name;
        this.actionIcon.textContent = trial.action.icon;
        this.actionDesc.textContent = trial.action.desc;
        this.actionRepetition.textContent = `${currentRep} / ${totalReps} 회차`;
        this.actionName.style.color = trial.action.color;
      }
    } else if (phase === 'RECORDING') {
      this.phaseBadge.textContent = '🔴 수집 중 (자세 유지)';
      this.phaseBadge.className = 'badge badge-running';
      this.countdownDisplay.textContent = `${remainingSec}초`;
      this.countdownDisplay.style.color = '#ef4444';
    } else if (phase === 'RESTING') {
      this.phaseBadge.textContent = '🟢 중립 복귀 휴식';
      this.phaseBadge.className = 'badge badge-ready';
      this.countdownDisplay.textContent = `${remainingSec}초`;
      this.countdownDisplay.style.color = '#10b981';
      this.actionName.textContent = '정면 중립 자세로 돌아오세요';
      this.actionIcon.textContent = '🧘';
      this.actionDesc.textContent = '다음 동작 준비를 위해 고개를 편안하게 정면으로 유지하세요.';
      this.actionName.style.color = '#10b981';
    } else if (phase === 'PAUSED') {
      this.phaseBadge.textContent = '⏸ 일시정지됨';
      this.phaseBadge.className = 'badge badge-warning';
      this.btnPauseCollection.textContent = '▶ 재개';
    } else if (phase === 'COMPLETED') {
      this.phaseBadge.textContent = '🎉 수집 완료!';
      this.phaseBadge.className = 'badge badge-success';
      this.countdownDisplay.textContent = '완료';
      this.countdownDisplay.style.color = '#10b981';
      this.overallProgressText.textContent = '16 / 16 트라이얼 (100%)';
      this.overallProgressBar.style.width = '100%';

      this.btnStartCollection.disabled = false;
      this.btnPauseCollection.disabled = true;
      this.btnStopCollection.disabled = true;
      this.inputParticipantId.disabled = false;
    } else if (phase === 'IDLE') {
      this.phaseBadge.textContent = '대기 중';
      this.phaseBadge.className = 'badge badge-ready';
      this.countdownDisplay.textContent = '0.0초';
      this.countdownDisplay.style.color = '#94a3b8';
      this.btnStartCollection.disabled = false;
      this.btnPauseCollection.disabled = true;
      this.btnStopCollection.disabled = true;
      this.inputParticipantId.disabled = false;
    }

    if (phase !== 'PAUSED') {
      this.btnPauseCollection.textContent = '⏸ 일시정지';
    }
  }

  /**
   * 실시간 샘플 기록 시 카운터 갱신
   * @private
   */
  _handleSampleRecorded({ trialSampleCount, totalCollectedCount }) {
    this.trialSampleCount.textContent = `${trialSampleCount}개`;
    this.totalSampleCount.textContent = `${totalCollectedCount}개`;
  }

  /**
   * 트라이얼(동작 1회) 완료 시 IndexedDB에 영구 저장
   * @private
   */
  async _handleTrialComplete({ trial, trialSamples, totalSamples }) {
    if (trialSamples && trialSamples.length > 0) {
      await this.storage.saveSamples(trialSamples);
      await this._refreshParticipantTable();
    }
  }

  /**
   * 전체 16개 트라이얼 수집 완료 시
   * @private
   */
  async _handleAllComplete({ participantId, totalSamples }) {
    await this._refreshParticipantTable();
    alert(`🎉 [수집 완료] 참가자 ${participantId}의 전체 데이터(${totalSamples}개 샘플)가 브라우저에 안전하게 저장되었습니다.\n\n하단의 [JSON 다운로드] 또는 [CSV 다운로드] 버튼을 눌러 파일로 내려받으세요.`);
  }

  /**
   * 참가자 데이터 목록 테이블 갱신
   * @private
   */
  async _refreshParticipantTable() {
    const list = await this.storage.getParticipantSummary();
    this.participantTableBody.innerHTML = '';

    if (list.length === 0) {
      this.participantTableBody.innerHTML = `
        <tr>
          <td colspan="6" style="text-align: center; color: var(--text-muted); padding: 18px;">
            수집된 참가자 데이터가 없습니다. 상단에서 참가자 코드를 입력하고 수집을 시작해 보세요.
          </td>
        </tr>
      `;
      this.btnDownloadJsonCurrent.disabled = true;
      this.btnDownloadCsvCurrent.disabled = true;
      this.btnDownloadJsonAll.disabled = true;
      this.btnDownloadCsvAll.disabled = true;
      this.btnClearAllData.disabled = true;
      return;
    }

    this.btnDownloadJsonAll.disabled = false;
    this.btnDownloadCsvAll.disabled = false;
    this.btnClearAllData.disabled = false;

    const currentPid = this.inputParticipantId.value.trim().toUpperCase();
    const hasCurrent = list.some((p) => p.participantId === currentPid);
    this.btnDownloadJsonCurrent.disabled = !hasCurrent;
    this.btnDownloadCsvCurrent.disabled = !hasCurrent;

    list.forEach((p) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${p.participantId}</strong></td>
        <td>${p.sampleCount}개</td>
        <td>${p.trialCount}회</td>
        <td><small class="text-muted">${p.labelCount}개 라벨</small></td>
        <td><small class="text-muted">${p.collectedAt}</small></td>
        <td>
          <button class="btn-table btn-download-json" data-pid="${p.participantId}" title="JSON 다운로드">JSON</button>
          <button class="btn-table btn-download-csv" data-pid="${p.participantId}" title="CSV 다운로드">CSV</button>
          <button class="btn-table btn-delete" data-pid="${p.participantId}" title="데이터 삭제">삭제</button>
        </td>
      `;

      // 테이블 내 버튼 바인딩
      tr.querySelector('.btn-download-json').addEventListener('click', () => {
        this.storage.downloadJSON(p.participantId);
      });
      tr.querySelector('.btn-download-csv').addEventListener('click', () => {
        this.storage.downloadCSV(p.participantId);
      });
      tr.querySelector('.btn-delete').addEventListener('click', async () => {
        if (confirm(`참가자 [${p.participantId}]의 데이터(${p.sampleCount}개)를 삭제하시겠습니까?`)) {
          await this.storage.deleteParticipant(p.participantId);
          await this._refreshParticipantTable();
        }
      });

      this.participantTableBody.appendChild(tr);
    });
  }

  /**
   * 현재 참가자 데이터 다운로드
   * @private
   */
  async _downloadCurrent(format) {
    const pid = this.inputParticipantId.value.trim().toUpperCase();
    try {
      if (format === 'json') await this.storage.downloadJSON(pid);
      else await this.storage.downloadCSV(pid);
    } catch (e) {
      alert(`다운로드 실패: ${e.message}`);
    }
  }

  /**
   * 전체 참가자 통합 다운로드
   * @private
   */
  async _downloadAll(format) {
    try {
      if (format === 'json') await this.storage.downloadJSON(null);
      else await this.storage.downloadCSV(null);
    } catch (e) {
      alert(`다운로드 실패: ${e.message}`);
    }
  }

  /**
   * 전체 데이터 초기화
   * @private
   */
  async _clearAllData() {
    if (confirm('⚠️ 저장된 모든 참가자의 데이터셋이 완전히 삭제됩니다.\n정말 초기화하시겠습니까?')) {
      await this.storage.clearAll();
      await this._refreshParticipantTable();
      alert('모든 데이터가 삭제되었습니다.');
    }
  }
}

// DOM 로드 시 인스턴스 생성 및 초기화
document.addEventListener('DOMContentLoaded', () => {
  const app = new DataCollectionApp();
  app.init();
});

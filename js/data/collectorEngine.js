/**
 * ==============================================================================
 * [NodOrder Data] collectorEngine.js
 * ------------------------------------------------------------------------------
 * 역할:
 * 1. 8개 머리 제스처 동작의 순차적 안내 및 자동 수집 시퀀스 제어
 * 2. 각 동작 2회 반복 (총 16개 트라이얼) 자동 오케스트레이션
 * 3. 1.5초 유지 구간 동안 약 0.2초 간격(5Hz)으로 유효 4차원 특징값 샘플링
 * 4. trialId(예: P01_LEFT_001) 및 participantId 기반 데이터 무결성 보장
 * 5. 시작, 일시정지, 재개, 중단 상태 머신 관리
 * ==============================================================================
 */

export const COLLECTION_ACTIONS = [
  {
    label: 'NEUTRAL',
    name: '정면 응시 (중립 자세)',
    desc: '정면을 편안하게 바라보고 가만히 자세를 유지하세요.',
    icon: '😐',
    color: '#10b981'
  },
  {
    label: 'LEFT',
    name: '고개 왼쪽 돌리기',
    desc: '고개를 자신의 왼쪽으로 돌린 상태를 유지하세요.',
    icon: '👈',
    color: '#3b82f6'
  },
  {
    label: 'RIGHT',
    name: '고개 오른쪽 돌리기',
    desc: '고개를 자신의 오른쪽으로 돌린 상태를 유지하세요.',
    icon: '👉',
    color: '#3b82f6'
  },
  {
    label: 'UP',
    name: '고개 위로 들기',
    desc: '턱과 고개를 위로 든 상태를 유지하세요.',
    icon: '👆',
    color: '#8b5cf6'
  },
  {
    label: 'DOWN',
    name: '고개 아래로 숙이기 (끄덕임)',
    desc: '고개를 아래로 숙인 상태를 유지하세요.',
    icon: '👇',
    color: '#8b5cf6'
  },
  {
    label: 'TILT_CCW',
    name: '머리 왼쪽 기울이기 (반시계)',
    desc: '머리를 왼쪽 어깨 방향으로 갸우뚱 기울인 상태를 유지하세요.',
    icon: '⤹',
    color: '#f59e0b'
  },
  {
    label: 'TILT_CW',
    name: '머리 오른쪽 기울이기 (시계)',
    desc: '머리를 오른쪽 어깨 방향으로 갸우뚱 기울인 상태를 유지하세요.',
    icon: '⤸',
    color: '#f59e0b'
  },
  {
    label: 'MOUTH_OPEN',
    name: '입 벌리기',
    desc: '입을 자연스럽게 벌린 상태를 유지하세요.',
    icon: '😮',
    color: '#ec4899'
  }
];

export class CollectorEngine {
  constructor(options = {}) {
    this.participantId = options.participantId || 'P01';
    this.actions = COLLECTION_ACTIONS;
    this.repeatCount = 2; // 각 동작 2회 반복
    this.sampleIntervalMs = 200; // 5Hz (0.2초 간격)
    this.holdDurationMs = 1500; // 1.5초 유지
    this.prepareDurationMs = 2000; // 준비 카운트다운 2.0초
    this.restDurationMs = 1500; // 중립 복귀 휴식 1.5초

    // 실행 상태
    this.isRunning = false;
    this.isPaused = false;
    this.currentTrialIndex = 0; // 0 ~ (8 * 2 - 1)
    this.currentTrialSamples = [];
    this.allCollectedSamples = [];

    // 내부 타이머 및 인터벌 ID
    this.phaseTimer = null;
    this.sampleInterval = null;
    this.tickInterval = null;

    // 콜백 함수
    this.onStateChange = options.onStateChange || (() => {});
    this.onSampleRecorded = options.onSampleRecorded || (() => {});
    this.onTrialComplete = options.onTrialComplete || (() => {});
    this.onAllComplete = options.onAllComplete || (() => {});
    this.onError = options.onError || (() => {});

    // 실시간 최신 특징값 공급자 함수
    this.getCurrentFeatures = options.getCurrentFeatures || (() => null);

    // 전체 트라이얼 목록 생성 (8개 동작 x 2회 반복 = 16개)
    this.trials = [];
    this._buildTrialList();
  }

  /**
   * 16개 트라이얼 순서 목록 생성
   * @private
   */
  _buildTrialList() {
    this.trials = [];
    for (let rep = 1; rep <= this.repeatCount; rep++) {
      for (let actIdx = 0; actIdx < this.actions.length; actIdx++) {
        const action = this.actions[actIdx];
        const trialNumberStr = String(rep).padStart(3, '0');
        const trialId = `${this.participantId}_${action.label}_${trialNumberStr}`;
        this.trials.push({
          action,
          rep,
          trialId,
          index: this.trials.length
        });
      }
    }
  }

  /**
   * 참가자 ID 설정 및 트라이얼 목록 갱신
   * @param {string} participantId 
   */
  setParticipantId(participantId) {
    if (this.isRunning) {
      throw new Error('수집이 진행 중일 때는 참가자 코드를 변경할 수 없습니다.');
    }
    this.participantId = String(participantId).trim().toUpperCase();
    this._buildTrialList();
  }

  /**
   * 수집 시작
   */
  start() {
    if (this.isRunning) return;

    this.isRunning = true;
    this.isPaused = false;
    this.currentTrialIndex = 0;
    this.allCollectedSamples = [];
    this._buildTrialList();

    this._runTrial(this.currentTrialIndex);
  }

  /**
   * 일시정지 / 재개 토글
   */
  togglePause() {
    if (!this.isRunning) return;
    this.isPaused = !this.isPaused;

    if (this.isPaused) {
      this._clearAllTimers();
      this.onStateChange({
        phase: 'PAUSED',
        message: '수집이 일시정지되었습니다. [재개] 버튼을 누르면 이어서 진행됩니다.'
      });
    } else {
      // 현재 트라이얼 재실행
      this._runTrial(this.currentTrialIndex);
    }
  }

  /**
   * 수집 강제 중단 및 리셋
   */
  stop() {
    this.isRunning = false;
    this.isPaused = false;
    this._clearAllTimers();
    this.onStateChange({
      phase: 'IDLE',
      message: '수집이 중단되었습니다.'
    });
  }

  /**
   * 단일 트라이얼(동작 1회) 실행 파이프라인
   * [1. 준비/안내 2.0s] -> [2. 동작 수행 및 5Hz 샘플링 1.5s] -> [3. 중립 복귀 휴식 1.5s]
   * @private
   */
  _runTrial(trialIndex) {
    if (!this.isRunning || this.isPaused) return;

    if (trialIndex >= this.trials.length) {
      this._finishAllTrials();
      return;
    }

    this.currentTrialIndex = trialIndex;
    const trial = this.trials[trialIndex];
    this.currentTrialSamples = [];

    // ==========================================
    // Phase 1: 동작 안내 및 준비 카운트다운 (2.0s)
    // ==========================================
    let prepareRemainingMs = this.prepareDurationMs;

    this.onStateChange({
      phase: 'PREPARING',
      trial,
      currentTrialNum: trialIndex + 1,
      totalTrials: this.trials.length,
      currentRep: trial.rep,
      totalReps: this.repeatCount,
      remainingSec: (prepareRemainingMs / 1000).toFixed(1),
      message: `[준비] 다음 동작: ${trial.action.name}`
    });

    this.tickInterval = setInterval(() => {
      prepareRemainingMs -= 100;
      if (prepareRemainingMs > 0) {
        this.onStateChange({
          phase: 'PREPARING',
          trial,
          currentTrialNum: trialIndex + 1,
          totalTrials: this.trials.length,
          currentRep: trial.rep,
          totalReps: this.repeatCount,
          remainingSec: Math.max(0, prepareRemainingMs / 1000).toFixed(1),
          message: `[준비] ${trial.action.name} 자세를 취해주세요!`
        });
      }
    }, 100);

    this.phaseTimer = setTimeout(() => {
      clearInterval(this.tickInterval);
      this._startRecordingPhase(trial);
    }, this.prepareDurationMs);
  }

  /**
   * Phase 2: 실제 데이터 기록 (1.5초 유지, 5Hz 샘플링)
   * @private
   */
  _startRecordingPhase(trial) {
    if (!this.isRunning || this.isPaused) return;

    let recordRemainingMs = this.holdDurationMs;

    this.onStateChange({
      phase: 'RECORDING',
      trial,
      currentTrialNum: this.currentTrialIndex + 1,
      totalTrials: this.trials.length,
      currentRep: trial.rep,
      totalReps: this.repeatCount,
      remainingSec: (recordRemainingMs / 1000).toFixed(1),
      message: `🔴 [수집 중] 자세를 그대로 유지하세요! (1.5초)`
    });

    // 100ms마다 UI 카운트다운 갱신
    this.tickInterval = setInterval(() => {
      recordRemainingMs -= 100;
      if (recordRemainingMs >= 0) {
        this.onStateChange({
          phase: 'RECORDING',
          trial,
          currentTrialNum: this.currentTrialIndex + 1,
          totalTrials: this.trials.length,
          currentRep: trial.rep,
          totalReps: this.repeatCount,
          remainingSec: Math.max(0, recordRemainingMs / 1000).toFixed(1),
          trialSampleCount: this.currentTrialSamples.length,
          message: `🔴 [수집 중] 자세 유지! (${(recordRemainingMs / 1000).toFixed(1)}초 남음)`
        });
      }
    }, 100);

    // 200ms(5Hz) 간격으로 특징값 캡처
    this.sampleInterval = setInterval(() => {
      this._captureSample(trial);
    }, this.sampleIntervalMs);

    // 즉시 첫 번째 프레임 캡처
    this._captureSample(trial);

    // 1.5초 종료 처리
    this.phaseTimer = setTimeout(() => {
      clearInterval(this.sampleInterval);
      clearInterval(this.tickInterval);
      this._startRestPhase(trial);
    }, this.holdDurationMs);
  }

  /**
   * 실시간 특징값 캡처 및 유효성 검증
   * @private
   */
  _captureSample(trial) {
    const currentFeatures = this.getCurrentFeatures();

    // 얼굴 미인식 또는 랜드마크 손실 시 프레임 무시
    if (!currentFeatures || !currentFeatures.featureVector || !currentFeatures.isCalibrated) {
      return;
    }

    const { featureVector } = currentFeatures;
    // 4개 특징값 확인
    if (featureVector.length !== 4 || featureVector.some((v) => typeof v !== 'number' || isNaN(v))) {
      return;
    }

    const record = {
      participantId: this.participantId,
      trialId: trial.trialId,
      label: trial.action.label,
      timestamp: Date.now(),
      features: [...featureVector] // [noseDeltaX, noseDeltaY, headTiltDeg, mouthOpenRatio]
    };

    this.currentTrialSamples.push(record);
    this.allCollectedSamples.push(record);

    this.onSampleRecorded({
      sample: record,
      trialSampleCount: this.currentTrialSamples.length,
      totalCollectedCount: this.allCollectedSamples.length
    });
  }

  /**
   * Phase 3: 중립 복귀 휴식 (1.5s)
   * @private
   */
  _startRestPhase(trial) {
    if (!this.isRunning || this.isPaused) return;

    // 현재 트라이얼 완료 통보
    this.onTrialComplete({
      trial,
      trialSamples: [...this.currentTrialSamples],
      totalSamples: this.allCollectedSamples.length
    });

    // 마지막 트라이얼이었다면 휴식 없이 즉시 완료
    if (this.currentTrialIndex + 1 >= this.trials.length) {
      this._finishAllTrials();
      return;
    }

    let restRemainingMs = this.restDurationMs;

    this.onStateChange({
      phase: 'RESTING',
      trial,
      currentTrialNum: this.currentTrialIndex + 1,
      totalTrials: this.trials.length,
      remainingSec: (restRemainingMs / 1000).toFixed(1),
      message: `🟢 정면 중립 자세로 돌아와 휴식하세요.`
    });

    this.tickInterval = setInterval(() => {
      restRemainingMs -= 100;
      if (restRemainingMs > 0) {
        this.onStateChange({
          phase: 'RESTING',
          trial,
          currentTrialNum: this.currentTrialIndex + 1,
          totalTrials: this.trials.length,
          remainingSec: Math.max(0, restRemainingMs / 1000).toFixed(1),
          message: `🟢 정면 중립 자세로 복귀 중...`
        });
      }
    }, 100);

    this.phaseTimer = setTimeout(() => {
      clearInterval(this.tickInterval);
      // 다음 트라이얼로 전진
      this._runTrial(this.currentTrialIndex + 1);
    }, this.restDurationMs);
  }

  /**
   * 모든 16개 트라이얼 수집 완료
   * @private
   */
  _finishAllTrials() {
    this.isRunning = false;
    this.isPaused = false;
    this._clearAllTimers();

    this.onAllComplete({
      participantId: this.participantId,
      totalSamples: this.allCollectedSamples.length,
      totalTrials: this.trials.length,
      samples: [...this.allCollectedSamples]
    });

    this.onStateChange({
      phase: 'COMPLETED',
      totalTrials: this.trials.length,
      totalSamples: this.allCollectedSamples.length,
      message: `🎉 [수집 완료] 총 ${this.allCollectedSamples.length}개 특징 프레임이 성공적으로 수집되었습니다!`
    });
  }

  /**
   * 활성 타이머 및 인터벌 일괄 정리
   * @private
   */
  _clearAllTimers() {
    if (this.phaseTimer) clearTimeout(this.phaseTimer);
    if (this.sampleInterval) clearInterval(this.sampleInterval);
    if (this.tickInterval) clearInterval(this.tickInterval);
    this.phaseTimer = null;
    this.sampleInterval = null;
    this.tickInterval = null;
  }
}

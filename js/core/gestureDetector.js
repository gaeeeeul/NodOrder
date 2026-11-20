/**
 * ==============================================================================
 * [NodOrder Core] gestureDetector.js
 * ------------------------------------------------------------------------------
 * 역할:
 * 1. X, Y, Tilt 특징값에 대한 독립적 중립 영역(Dead Zone) 및 발동 임계값 관리
 * 2. 300~500ms(기본 350ms) 지속 시간 조건(Dwell Time) 검증으로 순간 떨림 차단
 * 3. 히스테리시스(Hysteresis) 기반 단발성 발동(Single-shot) 및 반복 입력 방지
 * 4. 각 축의 상태(중립, 유지 중, 발동 완료) 및 진행률(0~100%) 실시간 산출
 * ==============================================================================
 */

/**
 * [임계값 및 오작동 방지 설정 상수]
 * 연구 및 사용자 실험 시 여기서 값을 손쉽게 조정할 수 있습니다.
 */
export const GESTURE_CONFIG = {
  // 1. 노이즈 완화 지수 이동 평균(EMA) 계수 (0 < alpha <= 1)
  // 낮을수록 미세 떨림이 강하게 감쇄되며, 높을수록 원본 움직임에 즉각 반응합니다.
  SMOOTHING_ALPHA: 0.35,

  // 2. 독립적인 축별 중립 영역(Dead Zone) 및 발동/복귀 임계값
  THRESHOLDS: {
    // [X축: 좌우 고개 회전] - 안구 간격(IOD) 정규화 기준
    // 중립 영역: -0.15 ~ +0.15 (기존 ±0.05 대비 3.0배 확대)
    NOSE_X_TRIGGER: 0.15,
    NOSE_X_RELEASE: 0.08, // 복귀 기준: |X| < 0.08 로 돌아와야 다음 명령 허용

    // [Y축: 상하 끄덕임/들림] - 안구 간격(IOD) 정규화 기준
    // 중립 영역: -0.12 ~ +0.14 (기존 ±0.05 대비 약 2.6배 확대)
    NOSE_Y_DOWN_TRIGGER: 0.14, // 숙임(끄덕임) 발동 기준: Y > +0.14
    NOSE_Y_UP_TRIGGER: -0.12,  // 들림 발동 기준: Y < -0.12
    NOSE_Y_RELEASE: 0.06,      // 복귀 기준: |Y| < 0.06

    // [머리 기울기: Roll 각도] - 도(Degree) 기준
    // 중립 영역: -8.0° ~ +8.0° (기존 ±2.0° 대비 4.0배 확대)
    TILT_TRIGGER: 8.0,         // 기울임 발동 기준: |θ| > 8.0°
    TILT_RELEASE: 4.0          // 복귀 기준: |θ| < 4.0°
  },

  // 3. 지속 시간 조건 (Dwell Time in milliseconds)
  // 임계값을 넘은 상태가 최소 이 시간 동안 유지되어야만 명령이 발동됩니다.
  HOLD_DURATION_MS: 350
};

/**
 * 단일 축(Axis)의 상태 머신 (State Machine)
 * 상태 전이: NEUTRAL(중립) -> HOLDING(유지 중) -> TRIGGERED(발동 완료/락) -> NEUTRAL
 */
class AxisStateTracker {
  constructor(axisName) {
    this.axisName = axisName;
    this.state = 'NEUTRAL'; // 'NEUTRAL' | 'HOLDING' | 'TRIGGERED'
    this.direction = 'NONE';
    this.holdStartTime = null;
    this.progress = 0; // 0.0 ~ 1.0 (지속 시간 진행도)
  }

  /**
   * 상태 초기화 (중립 복귀)
   */
  reset() {
    this.state = 'NEUTRAL';
    this.direction = 'NONE';
    this.holdStartTime = null;
    this.progress = 0;
  }

  /**
   * 프레임별 상태 갱신 및 명령 발동 검증
   * @param {number} value - 현재 특징값
   * @param {number} triggerPos - 양의 방향 발동 임계값
   * @param {number} triggerNeg - 음의 방향 발동 임계값
   * @param {number} releaseThreshold - 중립 복귀(해제) 임계값
   * @param {number} holdDuration - 유지 요구 시간 (ms)
   * @param {number} now - 현재 타임스탬프 (ms)
   * @param {string} posDirName - 양의 방향 명령 라벨
   * @param {string} negDirName - 음의 방향 명령 라벨
   * @returns {string|null} 새로 발동된 명령 이름 (발동된 순간만 반환, 이후 복귀 전까지 null)
   */
  update(value, triggerPos, triggerNeg, releaseThreshold, holdDuration, now, posDirName, negDirName) {
    let triggeredCommand = null;

    // 1. 이미 명령이 발동된 상태(TRIGGERED)인 경우: 히스테리시스 복귀 체크
    if (this.state === 'TRIGGERED') {
      const isReturnedToNeutral = Math.abs(value) <= releaseThreshold;
      if (isReturnedToNeutral) {
        // 중립 영역으로 충분히 복귀 완료 -> 시스템 재장전(Re-arm)
        this.reset();
      } else {
        // 아직 중립으로 돌아오지 않음 -> 반복 입력 방지(Lock)
        this.progress = 1.0;
      }
      return null;
    }

    // 2. 현재 값이 임계값을 벗어났는지 확인
    const isPositiveExceeded = value >= triggerPos;
    const isNegativeExceeded = value <= triggerNeg;

    if (isPositiveExceeded || isNegativeExceeded) {
      const currentDir = isPositiveExceeded ? posDirName : negDirName;

      if (this.state === 'NEUTRAL') {
        // 처음으로 임계값 돌파 -> 유지 카운트다운 시작
        this.state = 'HOLDING';
        this.direction = currentDir;
        this.holdStartTime = now;
        this.progress = 0;
      } else if (this.state === 'HOLDING') {
        // 기존 유지 방향과 동일한지 확인
        if (this.direction === currentDir) {
          const elapsed = now - this.holdStartTime;
          this.progress = Math.min(1.0, elapsed / holdDuration);

          // 요구 지속 시간 충족 시 단 1회 명령 발동!
          if (elapsed >= holdDuration) {
            this.state = 'TRIGGERED';
            this.progress = 1.0;
            triggeredCommand = currentDir;
          }
        } else {
          // 유지 중 반대 방향으로 전환된 경우 타이머 리셋
          this.direction = currentDir;
          this.holdStartTime = now;
          this.progress = 0;
        }
      }
    } else {
      // 3. 임계값 안쪽(중립 영역)에 있는 경우
      if (this.state === 'HOLDING') {
        // 지속 시간을 채우지 못하고 중립으로 돌아옴 -> 취소
        this.reset();
      }
    }

    return triggeredCommand;
  }
}

/**
 * 머리 움직임 제스처 탐지기 매니저
 */
export class GestureDetector {
  constructor(config = GESTURE_CONFIG) {
    this.config = config;

    // 각 축별 독립 상태 추적기
    this.trackerX = new AxisStateTracker('X');
    this.trackerY = new AxisStateTracker('Y');
    this.trackerTilt = new AxisStateTracker('Tilt');

    // 최근 발동된 명령 기록
    this.lastTriggeredEvent = null;
  }

  /**
   * 모든 축 상태 초기화
   */
  reset() {
    this.trackerX.reset();
    this.trackerY.reset();
    this.trackerTilt.reset();
    this.lastTriggeredEvent = null;
  }

  /**
   * 실시간 특징값을 입력받아 상태 갱신 및 발동 명령 탐지
   * @param {Object} metrics - featureExtractor에서 추출된 { noseDeltaX, noseDeltaY, headTiltDeg }
   * @param {number} timestamp - 현재 시간(ms)
   * @returns {Object} 실시간 제스처 상태 및 발동된 이벤트
   */
  process(metrics, timestamp = performance.now()) {
    if (!metrics) {
      return null;
    }

    const { THRESHOLDS, HOLD_DURATION_MS } = this.config;
    const firedEvents = [];

    // 1. X축 평가 (우측 이동 / 좌측 이동)
    const eventX = this.trackerX.update(
      metrics.noseDeltaX,
      THRESHOLDS.NOSE_X_TRIGGER,        // +0.15 (우측)
      -THRESHOLDS.NOSE_X_TRIGGER,       // -0.15 (좌측)
      THRESHOLDS.NOSE_X_RELEASE,        //  0.08 (복귀)
      HOLD_DURATION_MS,
      timestamp,
      'MOVE_RIGHT',
      'MOVE_LEFT'
    );
    if (eventX) firedEvents.push({ axis: 'X', action: eventX, timestamp });

    // 2. Y축 평가 (아래 숙임 / 위 들림)
    const eventY = this.trackerY.update(
      metrics.noseDeltaY,
      THRESHOLDS.NOSE_Y_DOWN_TRIGGER,   // +0.14 (숙임)
      THRESHOLDS.NOSE_Y_UP_TRIGGER,     // -0.12 (들림)
      THRESHOLDS.NOSE_Y_RELEASE,        //  0.06 (복귀)
      HOLD_DURATION_MS,
      timestamp,
      'MOVE_DOWN',
      'MOVE_UP'
    );
    if (eventY) firedEvents.push({ axis: 'Y', action: eventY, timestamp });

    // 3. 머리 기울기 평가 (시계 방향: 다음 단계 / 반시계 방향: 이전 단계)
    const eventTilt = this.trackerTilt.update(
      metrics.headTiltDeg,
      THRESHOLDS.TILT_TRIGGER,          // +8.0° (시계 방향 / 다음 단계)
      -THRESHOLDS.TILT_TRIGGER,         // -8.0° (반시계 방향 / 이전 단계)
      THRESHOLDS.TILT_RELEASE,          //  4.0° (복귀)
      HOLD_DURATION_MS,
      timestamp,
      'NEXT_STEP',
      'PREV_STEP'
    );
    if (eventTilt) firedEvents.push({ axis: 'Tilt', action: eventTilt, timestamp });

    if (firedEvents.length > 0) {
      this.lastTriggeredEvent = firedEvents[0];
    }

    return {
      states: {
        x: {
          state: this.trackerX.state,
          direction: this.trackerX.direction,
          progress: this.trackerX.progress
        },
        y: {
          state: this.trackerY.state,
          direction: this.trackerY.direction,
          progress: this.trackerY.progress
        },
        tilt: {
          state: this.trackerTilt.state,
          direction: this.trackerTilt.direction,
          progress: this.trackerTilt.progress
        }
      },
      firedEvents: firedEvents,
      lastTriggeredEvent: this.lastTriggeredEvent
    };
  }
}

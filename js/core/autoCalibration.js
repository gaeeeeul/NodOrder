/**
 * 얼굴 인식 기반 자동 기준 자세 설정 카운트다운.
 * 시간은 비디오 프레임의 performance.now() 값을 사용하며,
 * 얼굴이 0.6초 이상 사라지면 안전하게 카운트다운을 다시 시작합니다.
 * KNN 및 특징값 계산에는 관여하지 않습니다.
 */
export class AutoCalibrationCountdown {
  constructor({ durationMs = 5000, faceLossGraceMs = 600 } = {}) {
    this.durationMs = durationMs;
    this.faceLossGraceMs = faceLossGraceMs;
    this.reset();
  }

  reset() {
    this.startedAt = null;
    this.lostAt = null;
  }

  update(faceDetected, now) {
    if (!faceDetected) {
      if (this.startedAt !== null && this.lostAt === null) this.lostAt = now;
      if (this.lostAt !== null && now - this.lostAt >= this.faceLossGraceMs) this.reset();
      return { state: this.startedAt === null ? 'waiting' : 'paused', seconds: null };
    }

    if (this.startedAt === null) {
      this.startedAt = now;
    } else if (this.lostAt !== null) {
      // 잠깐 얼굴을 놓친 시간은 카운트다운에 포함시키지 않습니다.
      this.startedAt += now - this.lostAt;
    }
    this.lostAt = null;
    const remaining = this.durationMs - (now - this.startedAt);
    if (remaining <= 0) {
      this.reset();
      return { state: 'complete', seconds: 0 };
    }
    return { state: 'counting', seconds: Math.ceil(remaining / 1000) };
  }
}

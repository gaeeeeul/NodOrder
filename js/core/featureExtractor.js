/**
 * ==============================================================================
 * [NodOrder Core] featureExtractor.js
 * ------------------------------------------------------------------------------
 * 역할:
 * 1. MediaPipe 478개 3D 랜드마크로부터 머리 움직임 제어에 필요한 핵심 4개 특징 추출:
 *    - 코의 X좌표 상대 변화량 (noseDeltaX)
 *    - 코의 Y좌표 상대 변화량 (noseDeltaY)
 *    - 두 눈을 기준으로 계산한 머리 기울기 Roll 각도 (headTiltDeg)
 *    - 입 벌림 비율 (mouthOpenRatio, MAR)
 * 2. 거리/원근 왜곡 보정을 위해 두 눈 사이 거리(IOD, Inter-Ocular Distance)로 정규화
 * 3. 사용자별 정면 중립 자세(Neutral Pose) 캘리브레이션 관리
 * 4. [연구 핵심] 세 가지 AI 모델(규칙 기반, KNN, MLP)이 동일하게 주입받을
 *    표준화된 4차원 특징 벡터(featureVector) 출력 규격 보장
 * 5. participantId, trialId, label, timestamp, features 기반 데이터 레코드 생성 지원
 * ==============================================================================
 */

export class FeatureExtractor {
  constructor() {
    // MediaPipe Face Mesh 주요 랜드마크 인덱스 상수 정의
    this.LANDMARKS = {
      NOSE_TIP: 1,             // 코끝 중심점
      NOSE_BRIDGE: 168,        // 콧대
      RIGHT_EYE_OUTER: 33,     // 오른쪽 눈 외안각 (정면 기준)
      RIGHT_EYE_INNER: 133,    // 오른쪽 눈 내안각
      LEFT_EYE_INNER: 362,     // 왼쪽 눈 내안각
      LEFT_EYE_OUTER: 263,     // 왼쪽 눈 외안각 (정면 기준)
      UPPER_LIP: 13,           // 윗입술 안쪽 중앙
      LOWER_LIP: 14,           // 아랫입술 안쪽 중앙
      MOUTH_CORNER_LEFT: 61,   // 입꼬리 (오른쪽 외측)
      MOUTH_CORNER_RIGHT: 291  // 입꼬리 (왼쪽 외측)
    };

    // 표준 특징 벡터 정의 (길이: 4)
    this.FEATURE_NAMES = [
      'noseDeltaX',
      'noseDeltaY',
      'headTiltDeg',
      'mouthOpenRatio'
    ];

    // 중립 자세 기준값 (캘리브레이션 전에는 null)
    this.baseline = null;
    this.isCalibrated = false;

    // 노이즈 완화 (지수 이동 평균, EMA) 계수 및 이전 프레임 필터링 버퍼
    this.smoothingAlpha = 0.35;
    this.smoothedFeatures = null;
  }

  /**
   * 두 2D/3D 점 사이의 유클리드 거리를 계산합니다.
   * @private
   */
  _euclideanDistance(p1, p2) {
    const dx = p1.x - p2.x;
    const dy = p1.y - p2.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * 두 눈의 외안각을 잇는 선분의 수평 기울기 각도(도, Degree)를 계산합니다.
   * - Roll 회전 각도에 해당합니다.
   * - 사용자 중심 방향 규격:
   *   - 머리를 오른쪽(시계 방향, CW)으로 기울임 -> 양수 (+) => '다음 단계'
   *   - 머리를 왼쪽(반시계 방향, CCW)으로 기울임 -> 음수 (-) => '이전 단계'
   * 
   * ※ MediaPipe 영상 좌표계에서 Y축은 아래쪽으로 증가합니다:
   *   - 오른쪽으로 기울이면: 오른쪽 눈(33)이 아래로 내려가(y 증가), 왼쪽 눈(263)이 위로 올라감(y 감소).
   *   - 따라서 (rightEye.y - leftEye.y) > 0 일 때 시계 방향(+)이 되도록 계산합니다.
   * @private
   */
  _calculateEyeAngle(rightEye, leftEye) {
    const dx = leftEye.x - rightEye.x;
    const dy = rightEye.y - leftEye.y; // 오른쪽 눈 하강 시 dy > 0 (시계 방향 / 양수)
    return Math.atan2(dy, dx) * (180 / Math.PI);
  }

  /**
   * 입 벌림 종횡비(Mouth Aspect Ratio, MAR)를 계산합니다.
   * - 수직 입술 간격 / 수평 입꼬리 간격
   * @private
   */
  _calculateMouthAspectRatio(upperLip, lowerLip, cornerL, cornerR) {
    const verticalDist = this._euclideanDistance(upperLip, lowerLip);
    const horizontalDist = this._euclideanDistance(cornerL, cornerR);
    if (horizontalDist <= 0.0001) return 0;
    return verticalDist / horizontalDist;
  }

  /**
   * 현재 얼굴 랜드마크를 기준으로 정면 중립 자세(Baseline)를 등록합니다.
   * @param {Array} landmarks - 478개 랜드마크 배열
   * @returns {Object} 등록된 캘리브레이션 기준값
   */
  calibrate(landmarks) {
    if (!landmarks || landmarks.length < 300) {
      throw new Error('[FeatureExtractor] 유효한 랜드마크가 없어 캘리브레이션을 진행할 수 없습니다.');
    }

    const nose = landmarks[this.LANDMARKS.NOSE_TIP];
    const rightEye = landmarks[this.LANDMARKS.RIGHT_EYE_OUTER];
    const leftEye = landmarks[this.LANDMARKS.LEFT_EYE_OUTER];
    const upperLip = landmarks[this.LANDMARKS.UPPER_LIP];
    const lowerLip = landmarks[this.LANDMARKS.LOWER_LIP];
    const cornerL = landmarks[this.LANDMARKS.MOUTH_CORNER_LEFT];
    const cornerR = landmarks[this.LANDMARKS.MOUTH_CORNER_RIGHT];

    // 두 눈 사이의 거리 (안구 간격, IOD): 얼굴 크기 및 카메라 거리 정규화의 핵심 척도
    const iod = this._euclideanDistance(rightEye, leftEye);
    const eyeAngle = this._calculateEyeAngle(rightEye, leftEye);
    const mar = this._calculateMouthAspectRatio(upperLip, lowerLip, cornerL, cornerR);

    this.baseline = {
      noseX: nose.x,
      noseY: nose.y,
      iod: iod > 0.0001 ? iod : 0.1, // 0 나누기 방지
      eyeAngle: eyeAngle,
      mouthOpenRatio: mar,
      timestamp: Date.now()
    };

    this.isCalibrated = true;
    this.smoothedFeatures = null; // 캘리브레이션 갱신 시 필터링 버퍼 초기화
    return { ...this.baseline };
  }

  /**
   * 캘리브레이션 상태를 초기화합니다.
   */
  resetCalibration() {
    this.baseline = null;
    this.isCalibrated = false;
    this.smoothedFeatures = null;
  }

  /**
   * 실시간 랜드마크로부터 4개의 핵심 특징을 계산하고 표준화된 특징 벡터를 반환합니다.
   * @param {Array} landmarks - MediaPipe 478개 랜드마크 배열
   * @param {number} timestamp - 현재 비디오 타임스탬프
   * @returns {Object|null}
   */
  extractFeatures(landmarks, timestamp = Date.now()) {
    if (!landmarks || landmarks.length < 300) {
      return null;
    }

    const nose = landmarks[this.LANDMARKS.NOSE_TIP];
    const rightEye = landmarks[this.LANDMARKS.RIGHT_EYE_OUTER];
    const leftEye = landmarks[this.LANDMARKS.LEFT_EYE_OUTER];
    const upperLip = landmarks[this.LANDMARKS.UPPER_LIP];
    const lowerLip = landmarks[this.LANDMARKS.LOWER_LIP];
    const cornerL = landmarks[this.LANDMARKS.MOUTH_CORNER_LEFT];
    const cornerR = landmarks[this.LANDMARKS.MOUTH_CORNER_RIGHT];

    // 실시간 측정치
    const currentIod = this._euclideanDistance(rightEye, leftEye);
    const currentEyeAngle = this._calculateEyeAngle(rightEye, leftEye);
    const currentMar = this._calculateMouthAspectRatio(upperLip, lowerLip, cornerL, cornerR);

    // 정규화 스케일 팩터: 캘리브레이션된 IOD 우선, 미설정 시 현재 IOD 사용
    const scaleFactor = (this.isCalibrated && this.baseline.iod > 0.0001) 
      ? this.baseline.iod 
      : (currentIod > 0.0001 ? currentIod : 0.1);

    let noseDeltaX = 0;
    let noseDeltaY = 0;
    let headTiltDeg = 0;
    let mouthOpenRatio = Number(currentMar.toFixed(4));

    if (this.isCalibrated && this.baseline) {
      // 1. 코 X좌표 상대 변화량 (안구 간격으로 정규화)
      //    사용자가 자신의 왼쪽으로 돌리면 카메라 원본 x가 증가하므로,
      //    (baseline.noseX - nose.x)로 계산하여 사용자 중심 방향과 일치:
      //    - 사용자의 왼쪽 이동 시: 음수 (-) => '좌측 이동'
      //    - 사용자의 오른쪽 이동 시: 양수 (+) => '우측 이동'
      noseDeltaX = (this.baseline.noseX - nose.x) / scaleFactor;
      
      // 2. 코 Y좌표 상대 변화량 (안구 간격으로 정규화, 기존 방식 유지)
      //    (화면 좌표계 특성상 아래로 숙일 때 양수, 위로 들 때 음수)
      noseDeltaY = (nose.y - this.baseline.noseY) / scaleFactor;

      // 3. 눈 기준 머리 기울기 (캘리브레이션 기준각 대비 상대 회전 각도)
      //    - 시계 방향(오른쪽 기울임) -> 양수 (+) => '다음 단계'
      //    - 반시계 방향(왼쪽 기울임) -> 음수 (-) => '이전 단계'
      headTiltDeg = currentEyeAngle - this.baseline.eyeAngle;
    } else {
      // 캘리브레이션 이전에는 원시 각도 및 0 기준 변화량 유지
      headTiltDeg = currentEyeAngle;
    }

    // 소수점 정리 (원시 측정치)
    const rawNoseDeltaX = Number(noseDeltaX.toFixed(4));
    const rawNoseDeltaY = Number(noseDeltaY.toFixed(4));
    const rawHeadTiltDeg = Number(headTiltDeg.toFixed(2));
    const rawMouthOpenRatio = Number(mouthOpenRatio.toFixed(4));

    // [노이즈 완화] 지수 이동 평균(EMA) 필터링 적용
    // 순간적인 랜드마크 튐 현상을 부드럽게 감쇄
    if (!this.smoothedFeatures) {
      this.smoothedFeatures = {
        noseDeltaX: rawNoseDeltaX,
        noseDeltaY: rawNoseDeltaY,
        headTiltDeg: rawHeadTiltDeg,
        mouthOpenRatio: rawMouthOpenRatio
      };
    } else {
      const a = this.smoothingAlpha;
      this.smoothedFeatures.noseDeltaX = Number((a * rawNoseDeltaX + (1 - a) * this.smoothedFeatures.noseDeltaX).toFixed(4));
      this.smoothedFeatures.noseDeltaY = Number((a * rawNoseDeltaY + (1 - a) * this.smoothedFeatures.noseDeltaY).toFixed(4));
      this.smoothedFeatures.headTiltDeg = Number((a * rawHeadTiltDeg + (1 - a) * this.smoothedFeatures.headTiltDeg).toFixed(2));
      this.smoothedFeatures.mouthOpenRatio = Number((a * rawMouthOpenRatio + (1 - a) * this.smoothedFeatures.mouthOpenRatio).toFixed(4));
    }

    const s = this.smoothedFeatures;

    // ★ [연구 핵심 규격] 향후 세 분류기(규칙 기반, KNN, MLP)에 동일하게 전달될 4차원 특징 벡터
    const featureVector = [
      s.noseDeltaX,
      s.noseDeltaY,
      s.headTiltDeg,
      s.mouthOpenRatio
    ];

    return {
      isCalibrated: this.isCalibrated,
      timestamp: timestamp,
      
      // AI 모델 공통 입력 특징 벡터 (노이즈 필터링 적용)
      featureVector: featureVector,
      featureNames: [...this.FEATURE_NAMES],

      // 화면 표기 및 디버깅용 상세 수치 (노이즈 필터링 적용)
      metrics: {
        noseDeltaX: s.noseDeltaX,
        noseDeltaY: s.noseDeltaY,
        headTiltDeg: s.headTiltDeg,
        mouthOpenRatio: s.mouthOpenRatio,
        currentEyeAngleDeg: Number(currentEyeAngle.toFixed(2)),
        iod: Number(currentIod.toFixed(4))
      },

      // 원본 미필터링 수치 (연구 분석 및 노이즈 비교용)
      rawMetrics: {
        noseDeltaX: rawNoseDeltaX,
        noseDeltaY: rawNoseDeltaY,
        headTiltDeg: rawHeadTiltDeg,
        mouthOpenRatio: rawMouthOpenRatio
      },

      // 화면 캔버스 오버레이 렌더링용 주요 랜드마크 좌표
      keyLandmarks: {
        noseTip: { x: nose.x, y: nose.y, z: nose.z },
        rightEyeOuter: { x: rightEye.x, y: rightEye.y, z: rightEye.z },
        leftEyeOuter: { x: leftEye.x, y: leftEye.y, z: leftEye.z },
        upperLip: { x: upperLip.x, y: upperLip.y, z: upperLip.z },
        lowerLip: { x: lowerLip.x, y: lowerLip.y, z: lowerLip.z },
        mouthCornerLeft: { x: cornerL.x, y: cornerL.y, z: cornerL.z },
        mouthCornerRight: { x: cornerR.x, y: cornerR.y, z: cornerR.z }
      },

      // 현재 기준값 복사본
      baseline: this.baseline ? { ...this.baseline } : null
    };
  }

  /**
   * 연구용 데이터 수집 규격에 맞는 데이터 레코드를 생성합니다.
   * @param {Object} params
   * @param {string} params.participantId - 피험자 식별자 (예: 'P01')
   * @param {string} params.trialId - 시도 식별자 (예: 'trial_001')
   * @param {string} params.label - 제스처 라벨 (예: 'NOD_DOWN')
   * @param {number} [params.timestamp] - 타임스탬프
   * @param {Array<number>} params.features - 4차원 특징 벡터
   * @returns {Object} 통일된 데이터셋 엔트리
   */
  createDataRecord({ participantId, trialId, label, timestamp = Date.now(), features }) {
    if (!participantId || !trialId || !label || !Array.isArray(features)) {
      throw new Error('[FeatureExtractor] 데이터 레코드 생성을 위한 필수 필드가 누락되었습니다.');
    }
    return {
      participantId,
      trialId,
      label,
      timestamp,
      features: [...features]
    };
  }
}

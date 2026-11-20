/**
 * ==============================================================================
 * [NodOrder Classifiers] baseClassifier.js
 * ------------------------------------------------------------------------------
 * 역할:
 * 1. 세 가지 AI 분류기(규칙 기반, KNN, MLP)가 동일하게 구현해야 할 기본 인터페이스 규격 정의
 * 2. 동일한 4차원 입력 벡터 [noseDeltaX, noseDeltaY, headTiltDeg, mouthOpenRatio] 수신 보장
 * 3. 동일한 출력 구조 { label, confidence, inferenceTimeMs, ... } 반환 보장
 * ==============================================================================
 */

export class BaseClassifier {
  constructor(name = 'BaseClassifier') {
    this.name = name;
    this.isTrained = false;
  }

  /**
   * 4차원 특징 벡터를 입력받아 제스처를 분류합니다.
   * @param {Array<number>} featureVector - [noseDeltaX, noseDeltaY, headTiltDeg, mouthOpenRatio]
   * @returns {Object} { label: string, confidence: number, inferenceTimeMs: number }
   */
  predict(featureVector) {
    throw new Error(`[${this.name}] predict() 메서드가 구현되지 않았습니다.`);
  }

  /**
   * 모델 준비 완료 여부
   * @returns {boolean}
   */
  isReady() {
    return this.isTrained;
  }
}

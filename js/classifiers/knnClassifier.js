/**
 * ==============================================================================
 * [NodOrder Classifiers] knnClassifier.js
 * ------------------------------------------------------------------------------
 * 역할:
 * 1. 612개 실제 피험자 데이터 기반 K-최근접 이웃(KNN, K=5) 머신러닝 분류기
 * 2. 4대 특징값의 측정 단위(각도, 픽셀 변위, 비율) 차이를 보정하기 위한 Z-score 표준화 적용
 * 3. [핵심 조건] 학습 및 실시간 입력 시 noseDeltaY 부호 반전(-noseDeltaY) 적용
 * 4. 유클리드 거리(Euclidean Distance) 기반 실시간 최근접 5개 이웃 다수결 투표
 * 5. 8대 제스처(NEUTRAL, LEFT, RIGHT, UP, DOWN, TILT_CCW, TILT_CW, MOUTH_OPEN) 완전 분류
 * ==============================================================================
 */

import { BaseClassifier } from './baseClassifier.js';

export class KNNClassifier extends BaseClassifier {
  constructor(k = 5) {
    super('KNNClassifier');
    this.k = k; // 이웃 수 K = 5

    // 표준화 파라미터 (Z-score: (x - mean) / std)
    this.mean = [0, 0, 0, 0];
    this.std = [1, 1, 1, 1];

    // 표준화된 학습 데이터셋 캐시
    // 각 원소: { features: [z0, z1, z2, z3], label: string, participantId: string }
    this.trainSamples = [];
    this.labels = [];
  }

  /**
   * 사전 계산된 모델 JSON 또는 원본 데이터셋을 로드하여 학습합니다.
   * @param {string|Object} modelDataOrUrl - 모델 경로 또는 데이터셋 객체
   */
  async loadModel(modelDataOrUrl = 'models/knn/knn_model.json') {
    let data = modelDataOrUrl;

    if (typeof modelDataOrUrl === 'string') {
      try {
        const response = await fetch(modelDataOrUrl);
        if (!response.ok) {
          throw new Error(`모델 파일 로드 실패: ${response.status} ${response.statusText}`);
        }
        data = await response.json();
      } catch (err) {
        console.warn(`[KNNClassifier] ${modelDataOrUrl} 로드 실패, raw 데이터셋으로 직접 학습을 시도합니다:`, err.message);
        // 원본 가공 데이터셋으로 폴백
        const rawRes = await fetch('data/processed/NodOrder_All_participants_2026-11-17 (3).json');
        data = await rawRes.json();
      }
    }

    if (data.scaler && data.samples && data.modelType === 'KNN') {
      // 1. 이미 scaler가 사전 계산된 포맷인 경우
      this.k = data.k || 5;
      this.mean = [...data.scaler.mean];
      this.std = [...data.scaler.std];
      this.labels = [...data.labels];

      // 학습 샘플 표준화 변환 후 저장
      this.trainSamples = data.samples.map((s) => ({
        label: s.label,
        participantId: s.participantId,
        features: this._standardizeVector(s.features) // z-score 변환
      }));

      this.isTrained = true;
      console.log(`[KNNClassifier] 사전 빌드 모델 로드 완료 (K=${this.k}, 총 샘플: ${this.trainSamples.length}개)`);
      return true;
    } else if (data.samples) {
      // 2. 원본 JSON 데이터셋에서 직접 학습하는 경우
      return this.train(data.samples);
    } else {
      throw new Error('[KNNClassifier] 유효하지 않은 모델 데이터 형식입니다.');
    }
  }

  /**
   * 원본 샘플 배열로부터 평균/표준편차를 계산하고 Z-score 표준화 학습을 수행합니다.
   * @param {Array<Object>} rawSamples - [{ features, label, participantId }, ...]
   */
  train(rawSamples) {
    if (!rawSamples || rawSamples.length === 0) {
      throw new Error('[KNNClassifier] 학습할 데이터가 비어 있습니다.');
    }

    const N = rawSamples.length;
    const adjustedSamples = [];

    // 1. [핵심 조건] 학습 전 noseDeltaY 부호 반전 적용
    for (let i = 0; i < N; i++) {
      const s = rawSamples[i];
      const feat = [...s.features];
      feat[1] = -feat[1]; // noseDeltaY 부호 반전!
      adjustedSamples.push({
        label: s.label,
        participantId: s.participantId,
        features: feat
      });
    }

    // 2. 4대 특징별 평균(mean) 계산
    const sum = [0, 0, 0, 0];
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < 4; j++) {
        sum[j] += adjustedSamples[i].features[j];
      }
    }
    this.mean = sum.map((val) => val / N);

    // 3. 4대 특징별 표준편차(std) 계산
    const sqDiffSum = [0, 0, 0, 0];
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < 4; j++) {
        const diff = adjustedSamples[i].features[j] - this.mean[j];
        sqDiffSum[j] += diff * diff;
      }
    }
    this.std = sqDiffSum.map((val) => {
      const s = Math.sqrt(val / N);
      return s > 0.00001 ? s : 1.0; // 0 나누기 방지
    });

    // 4. 모든 학습 샘플을 Z-score로 표준화하여 저장
    this.trainSamples = adjustedSamples.map((s) => ({
      label: s.label,
      participantId: s.participantId,
      features: this._standardizeVector(s.features)
    }));

    this.labels = Array.from(new Set(this.trainSamples.map((s) => s.label))).sort();
    this.isTrained = true;
    console.log(`[KNNClassifier] 동적 학습 완료 (총 ${N}개 샘플, 8대 라벨 정상 등록)`);
    return true;
  }

  /**
   * 단일 4차원 특징 벡터를 Z-score로 표준화합니다.
   * @private
   */
  _standardizeVector(features) {
    return [
      (features[0] - this.mean[0]) / this.std[0],
      (features[1] - this.mean[1]) / this.std[1],
      (features[2] - this.mean[2]) / this.std[2],
      (features[3] - this.mean[3]) / this.std[3]
    ];
  }

  /**
   * 실시간 웹캠 4차원 특징 벡터를 분류합니다.
   * @param {Array<number>} featureVector - [noseDeltaX, noseDeltaY, headTiltDeg, mouthOpenRatio]
   * @returns {Object} 예측 결과
   */
  predict(featureVector) {
    if (!this.isTrained || this.trainSamples.length === 0) {
      throw new Error('[KNNClassifier] 모델이 아직 학습되지 않았습니다.');
    }

    if (!featureVector || featureVector.length !== 4) {
      return null;
    }

    const startTime = performance.now();

    // 1. [핵심 조건] 실시간 입력값에서도 noseDeltaY 부호 반전 적용!
    const adjustedInput = [
      featureVector[0],
      -featureVector[1], // noseDeltaY 부호 반전!
      featureVector[2],
      featureVector[3]
    ];

    // 2. Z-score 표준화
    const zInput = this._standardizeVector(adjustedInput);

    // 3. 612개 학습 샘플과의 유클리드 거리 계산
    const distances = [];
    const N = this.trainSamples.length;

    for (let i = 0; i < N; i++) {
      const trainFeat = this.trainSamples[i].features;
      const d0 = zInput[0] - trainFeat[0];
      const d1 = zInput[1] - trainFeat[1];
      const d2 = zInput[2] - trainFeat[2];
      const d3 = zInput[3] - trainFeat[3];

      // 유클리드 거리: sqrt(sum(d_i^2))
      const dist = Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3);

      distances.push({
        dist: dist,
        label: this.trainSamples[i].label,
        participantId: this.trainSamples[i].participantId
      });
    }

    // 4. 거리가 가장 가까운 K=5개 이웃 추출
    distances.sort((a, b) => a.dist - b.dist);
    const nearestK = distances.slice(0, this.k);

    // 5. 다수결(Majority Voting) 투표 집계
    const voteCounts = {};
    for (let i = 0; i < nearestK.length; i++) {
      const lbl = nearestK[i].label;
      voteCounts[lbl] = (voteCounts[lbl] || 0) + 1;
    }

    // 최다 득표 라벨 결정
    let winnerLabel = 'NEUTRAL';
    let maxVotes = -1;
    for (const [lbl, count] of Object.entries(voteCounts)) {
      if (count > maxVotes) {
        maxVotes = count;
        winnerLabel = lbl;
      }
    }

    const elapsed = Number((performance.now() - startTime).toFixed(2));
    const confidence = Number((maxVotes / this.k).toFixed(2)); // 0.2 ~ 1.0

    return {
      label: winnerLabel,
      confidence: confidence, // 투표 비율 (예: 5표 중 4표 -> 0.8)
      votes: voteCounts,
      nearestNeighbors: nearestK.map((n) => ({
        label: n.label,
        distance: Number(n.dist.toFixed(3)),
        participantId: n.participantId
      })),
      inferenceTimeMs: elapsed,
      standardizedInput: zInput.map((v) => Number(v.toFixed(3)))
    };
  }
}

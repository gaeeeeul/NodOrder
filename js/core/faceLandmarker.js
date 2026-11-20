/**
 * ==============================================================================
 * [NodOrder Core] faceLandmarker.js
 * ------------------------------------------------------------------------------
 * 역할:
 * 1. Google MediaPipe Tasks Vision 라이브러리를 로드하여 FaceLandmarker 초기화
 * 2. 실시간 웹캠 비디오 프레임으로부터 얼굴의 478개 3D 랜드마크 추출
 * 3. GPU 가속(WebGL/WebGPU)을 우선 시도하고 실패 시 CPU 모드로 안전하게 폴백
 * 4. CDN 경로 호환성을 위해 멀티 엔드포인트 동적 임포트 지원
 * 
 * 개인정보 보호:
 * - MediaPipe 모델은 브라우저의 WebAssembly/WebGL 환경에서 100% 로컬 연산됩니다.
 * - 얼굴 이미지나 랜드마크 데이터가 외부 서버로 전송되지 않습니다.
 * ==============================================================================
 */

export class FaceLandmarkerService {
  constructor() {
    this.faceLandmarker = null;
    this.isInitialized = false;
    this.isLoading = false;
    this.lastVideoTime = -1;
    this.lastError = null;
  }

  /**
   * MediaPipe 라이브러리를 동적으로 로드합니다. (CDN 호환성 보장)
   * @private
   */
  async _loadVisionLibrary() {
    const cdnUrls = [
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14',
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs',
      'https://unpkg.com/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs'
    ];

    let lastError = null;
    for (const url of cdnUrls) {
      try {
        const module = await import(url);
        if (module && module.FilesetResolver && module.FaceLandmarker) {
          return module;
        }
      } catch (err) {
        lastError = err;
        console.warn(`[FaceLandmarkerService] CDN 로드 시도 실패 (${url}):`, err.message);
      }
    }

    throw new Error(`MediaPipe 라이브러리를 로드하지 못했습니다. 네트워크 연결을 확인해 주세요. (${lastError?.message})`);
  }

  /**
   * MediaPipe FaceLandmarker를 초기화하고 모델 가중치를 로드합니다.
   * @param {Object} config - 모델 설정 옵션
   */
  async init(config = {}) {
    if (this.isInitialized) return true;
    if (this.isLoading) return false;

    this.isLoading = true;

    try {
      // 1. Tasks-Vision 모듈 로드
      const { FilesetResolver, FaceLandmarker } = await this._loadVisionLibrary();

      // 2. WASM 바이너리 파일 리졸버 로드
      const wasmFileset = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
      );

      const baseOptions = {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
        delegate: 'GPU' // 하드웨어 가속 우선
      };

      // 3. GPU 모드로 먼저 생성 시도 후 실패 시 CPU 모드로 폴백
      try {
        this.faceLandmarker = await FaceLandmarker.createFromOptions(wasmFileset, {
          baseOptions,
          runningMode: 'VIDEO',
          numFaces: 1, // 키오스크 사용자 1인 집중
          minFaceDetectionConfidence: config.minDetectionConfidence || 0.5,
          minFacePresenceConfidence: config.minPresenceConfidence || 0.5,
          minTrackingConfidence: config.minTrackingConfidence || 0.5,
          outputFaceBlendshapes: false,
          outputFacialTransformationMatrixes: false
        });
      } catch (gpuError) {
        console.warn('[FaceLandmarkerService] GPU 가속 실패, CPU 모드로 재시도합니다:', gpuError);
        baseOptions.delegate = 'CPU';
        this.faceLandmarker = await FaceLandmarker.createFromOptions(wasmFileset, {
          baseOptions,
          runningMode: 'VIDEO',
          numFaces: 1,
          minFaceDetectionConfidence: config.minDetectionConfidence || 0.5,
          minFacePresenceConfidence: config.minPresenceConfidence || 0.5,
          minTrackingConfidence: config.minTrackingConfidence || 0.5
        });
      }

      this.isInitialized = true;
      this.isLoading = false;
      return true;
    } catch (error) {
      this.isLoading = false;
      this.isInitialized = false;
      console.error('[FaceLandmarkerService] 모델 초기화 실패:', error);
      throw new Error(`MediaPipe 얼굴 인식 모델 초기화 오류: ${error.message}`);
    }
  }

  /**
   * 비디오 프레임에서 얼굴 랜드마크를 실시간 추론합니다.
   * @param {HTMLVideoElement} videoElement 
   * @param {number} timestamp - 현재 비디오 타임스탬프 (ms)
   * @returns {Array|null} 478개 랜드마크 배열 또는 null
   */
  detect(videoElement, timestamp) {
    if (!this.isInitialized || !this.faceLandmarker) {
      return null;
    }

    if (!videoElement || videoElement.readyState < 2) {
      return null;
    }

    // 동일한 프레임 중복 처리 방지
    if (videoElement.currentTime === this.lastVideoTime) {
      return null;
    }
    this.lastVideoTime = videoElement.currentTime;

    try {
      const results = this.faceLandmarker.detectForVideo(videoElement, timestamp);
      if (results && results.faceLandmarks && results.faceLandmarks.length > 0) {
        // 첫 번째 감지된 얼굴의 478개 랜드마크 반환
        return results.faceLandmarks[0];
      }
      return null;
    } catch (error) {
      this.lastError = error;
      console.error('[FaceLandmarkerService] 랜드마크 추론 에러:', error);
      return null;
    }
  }

  /**
   * 모델 로드 완료 여부
   * @returns {boolean}
   */
  isReady() {
    return this.isInitialized && !!this.faceLandmarker;
  }
}

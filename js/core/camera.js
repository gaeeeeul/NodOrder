/**
 * ==============================================================================
 * [NodOrder Core] camera.js
 * ------------------------------------------------------------------------------
 * 역할:
 * 1. 사용자의 웹캠 장치에 접근하여 영상 스트림을 획득하고 HTML5 <video> 요소에 바인딩
 * 2. 카메라 시작, 정지, 스트림 상태 모니터링 관리
 * 3. 브라우저 보안 정책(권한 거부, 장치 없음 등)에 대한 예외 처리
 * 
 * 개인정보 보호:
 * - 웹캠 영상 스트림은 로컬 브라우저 메모리 내에서만 처리되며,
 *   외부 서버로 전송되거나 서버에 저장되지 않습니다.
 * ==============================================================================
 */

export class CameraManager {
  constructor() {
    this.stream = null;
    this.videoElement = null;
    this.isRunning = false;
  }

  /**
   * 웹캠을 시작하고 지정된 video 요소에 스트림을 연결합니다.
   * @param {HTMLVideoElement} videoElement - 웹캠 영상을 렌더링할 video DOM 요소
   * @param {Object} options - 해상도 및 프레임 레이트 옵션
   * @returns {Promise<boolean>} 성공 여부
   */
  async start(videoElement, options = {}) {
    if (!videoElement) throw new Error('카메라 표시 영역을 찾을 수 없습니다.');
    if (!window.isSecureContext) {
      throw new Error('카메라는 HTTPS 또는 localhost에서만 사용할 수 있습니다. 파일을 직접 열지 말고 안내된 로컬 서버에서 실행해 주세요.');
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('이 브라우저에서는 카메라를 사용할 수 없습니다. Chrome 또는 Edge의 최신 버전을 사용해 주세요.');
    }
    // 부트스트랩에서 사용자 클릭 시 이미 허가받은 스트림이 있으면 그대로 인계합니다.
    const boot = window.__nodOrderCameraBootstrap;
    const transferredStream = boot?.stream && boot.stream.getVideoTracks().some(track => track.readyState === 'live') ? boot.stream : null;
    if (transferredStream) {
      this.stream = transferredStream;
      this.videoElement = videoElement;
      videoElement.srcObject = transferredStream;
      await videoElement.play();
      this.isRunning = true;
      const track = transferredStream.getVideoTracks()[0];
      track.addEventListener('ended', () => {
        this.isRunning = false;
        if (typeof this.onEnded === 'function') this.onEnded();
      }, { once: true });
      return true;
    }
    this.stop();
    this.videoElement = videoElement;
    const constraints = {
      audio: false,
      video: {
        width: { ideal: options.width || 640 },
        height: { ideal: options.height || 480 },
        frameRate: { ideal: options.frameRate || 30 },
        facingMode: { ideal: 'user' }
      }
    };
    try {
      // 카메라 권한은 클릭 시점에 직접 요청합니다. 미리보기 CSS 크기와 무관합니다.
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
      const track = this.stream.getVideoTracks()[0];
      if (!track || track.readyState !== 'live') throw new Error('영상 신호를 받지 못했습니다.');
      videoElement.muted = true;
      videoElement.playsInline = true;
      videoElement.autoplay = true;
      videoElement.srcObject = this.stream;
      // loadedmetadata가 이미 발생했거나 발생하지 않는 브라우저에서도 무기한 대기하지 않습니다.
      if (videoElement.readyState < HTMLMediaElement.HAVE_METADATA) {
        await new Promise((resolve, reject) => {
          const cleanup = () => { videoElement.removeEventListener('loadedmetadata', onReady); videoElement.removeEventListener('error', onError); clearTimeout(timeout); };
          const onReady = () => { cleanup(); resolve(); };
          const onError = () => { cleanup(); reject(new Error('카메라 영상 정보를 읽을 수 없습니다.')); };
          const timeout = setTimeout(() => { cleanup(); reject(new Error('카메라 연결 시간이 초과되었습니다.')); }, 8000);
          videoElement.addEventListener('loadedmetadata', onReady, { once: true });
          videoElement.addEventListener('error', onError, { once: true });
          if (videoElement.readyState >= HTMLMediaElement.HAVE_METADATA) onReady();
        });
      }
      await videoElement.play();
      if (!videoElement.videoWidth || !videoElement.videoHeight) {
        throw new Error('영상 크기를 확인할 수 없습니다. 카메라를 다시 연결해 주세요.');
      }
      this.isRunning = true;
      track.addEventListener('ended', () => {
        this.isRunning = false;
        if (typeof this.onEnded === 'function') this.onEnded();
      }, { once: true });
      return true;
    } catch (error) {
      this.stop();
      console.error('[CameraManager] 카메라 시작 실패:', error);
      throw this._formatCameraError(error);
    }
  }

  /**
   * 웹캠 스트림을 중지하고 카메라 하드웨어 점유를 해제합니다.
   */
  stop() {
    const oldStream = this.stream;
    if (this.stream) {
      // 모든 활성 미디어 트랙(카메라) 중지
      this.stream.getTracks().forEach((track) => {
        track.stop();
      });
      this.stream = null;
    }

    if (this.videoElement) {
      this.videoElement.srcObject = null;
    }

    this.isRunning = false;
    const boot = window.__nodOrderCameraBootstrap;
    if (boot && boot.stream === oldStream) boot.stream = null;
  }

  /**
   * 현재 카메라가 활성화되어 스트리밍 중인지 확인합니다.
   * @returns {boolean}
   */
  getStreamingStatus() {
    return this.isRunning && !!this.stream;
  }

  /**
   * 브라우저 에러를 사용자가 이해하기 쉬운 한국어 메시지로 변환합니다.
   * @private
   */
  _formatCameraError(error) {
    if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
      return new Error('카메라 접근 권한이 거부되었습니다. 브라우저 주소창 왼쪽의 자물쇠/설정 아이콘에서 카메라 권한을 허용해 주세요.');
    } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
      return new Error('사용 가능한 웹캠 장치를 찾을 수 없습니다. 카메라가 올바르게 연결되어 있는지 확인해 주세요.');
    } else if (error.name === 'OverconstrainedError') {
      return new Error('카메라 설정을 지원하지 않습니다. 다른 카메라를 연결해 주세요.');
    } else if (error.name === 'AbortError') {
      return new Error('카메라 연결이 중단되었습니다. 잠시 후 다시 시도해 주세요.');
    } else if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
      return new Error('카메라 장치가 다른 프로그램(Zoom, Teams 등)에서 이미 사용 중입니다. 다른 앱을 종료 후 다시 시도해 주세요.');
    }
    return error;
  }
}

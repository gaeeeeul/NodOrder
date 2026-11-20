/* NodOrder 카메라 버튼 부트스트랩. ES module이 로드되지 않아도 동작합니다. */
(function () {
  'use strict';
  const state = { stream: null, starting: false, requestId: 0 };
  window.__nodOrderCameraBootstrap = state;
  let moduleLoadError = null;
  const el = (id) => document.getElementById(id);
  function show(message, error) {
    const info = el('camera-connection-status');
    if (info) {
      info.textContent = message;
      info.style.color = error ? '#a91c1c' : '#194566';
    }
    console[error ? 'error' : 'info']('[NodOrder:camera]', message);
  }
  function describe(err) {
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return '카메라 권한이 거부되었습니다. 브라우저 사이트 설정에서 카메라를 허용해 주세요.';
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return '연결된 카메라가 없습니다. 카메라 연결 상태를 확인해 주세요.';
    if (name === 'NotReadableError' || name === 'TrackStartError') return '카메라가 다른 앱에서 사용 중이거나 접근할 수 없습니다. 다른 앱을 종료한 뒤 다시 시도해 주세요.';
    if (name === 'OverconstrainedError') return '카메라가 요청된 영상 설정을 지원하지 않습니다.';
    if (name === 'AbortError') return '카메라 연결이 중단되었습니다. 다시 시도해 주세요.';
    return '카메라 연결 오류: ' + ((err && err.message) || String(err));
  }
  async function startFromClick() {
    if (state.starting) return;
    const video = el('webcam-video');
    const button = el('btn-start-camera');
    if (!video || !button) { show('카메라 UI 구성 요소를 찾을 수 없습니다.', true); return; }
    if (window.__nodOrderApp && window.__nodOrderApp.cameraManager.getStreamingStatus()) {
      show('카메라가 이미 실행 중입니다.', false);
      return;
    }
    if (location.protocol === 'file:') {
      show('HTML 파일을 직접 열면 얼굴 인식 모듈이 차단됩니다. 터미널에서 python3 -m http.server 8000을 실행한 뒤 http://localhost:8000 주소로 접속해 주세요.', true);
      return;
    }
    state.starting = true;
    const thisRequest = ++state.requestId;
    button.disabled = true;
    button.textContent = '카메라 연결 중...';
    show('카메라 권한 확인 중... 브라우저의 권한 요청을 허용해 주세요.', false);
    try {
      if (!window.isSecureContext) throw new Error('HTTPS 또는 localhost 주소에서만 카메라를 사용할 수 있습니다. index.html을 직접 열지 말고 로컬 서버를 실행해 주세요.');
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('브라우저에서 카메라 API를 지원하지 않습니다.');
      // 사용자 클릭 직후, 모델 다운로드를 기다리지 않고 직접 카메라 접근을 요청합니다.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: { ideal: 'user' } } });
      if (thisRequest !== state.requestId) { stream.getTracks().forEach(t => t.stop()); return; }
      state.stream = stream;
      video.muted = true;
      video.playsInline = true;
      video.autoplay = true;
      video.srcObject = stream;
      await Promise.race([
        video.play(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('영상 재생이 시작되지 않았습니다. 카메라 연결 상태를 확인해 주세요.')), 8000))
      ]);
      if (thisRequest !== state.requestId) return;
      show('카메라 영상 연결됨 · 얼굴 인식 준비 중...', false);
      if (window.__nodOrderApp) {
        // CameraManager가 부트스트랩의 스트림을 인계받아 기존 추론 코드를 실행합니다.
        await window.__nodOrderApp.start();
        if (window.__nodOrderApp.cameraManager.getStreamingStatus() && window.__nodOrderApp.faceLandmarker.isInitialized) {
          show('카메라 연결 완료 · 얼굴 인식 실행 중', false);
        } else {
          show('영상은 연결되었으나 얼굴 인식 준비가 완료되지 않았습니다. 화면의 오류 안내를 확인해 주세요.', true);
        }
      } else {
        show(moduleLoadError ? `영상은 켜졌지만 얼굴 인식 앱 초기화 실패: ${moduleLoadError}` : '영상은 켜졌지만 얼굴 인식 앱이 로드되지 않았습니다. 주소가 http://localhost:8000 인지 확인하고, 브라우저 콘솔의 첫 번째 빨간 오류를 확인해 주세요.', true);
        const stop = el('btn-stop-camera');
        if (stop) stop.disabled = false;
      }
    } catch (err) {
      console.error('[NodOrder:camera] 클릭 → getUserMedia/영상 재생 실패', err);
      show(describe(err), true);
      stopStreams();
    } finally {
      state.starting = false;
      if (thisRequest === state.requestId) {
        button.disabled = false;
        button.textContent = '카메라 켜기';
      }
    }
  }
  function stopStreams() {
    state.requestId++;
    if (state.stream) state.stream.getTracks().forEach(track => track.stop());
    state.stream = null;
    const video = el('webcam-video');
    if (video && video.srcObject && !window.__nodOrderApp?.cameraManager.getStreamingStatus()) video.srcObject = null;
  }
  function registerControls() {
    const button = el('btn-start-camera');
    if (!button) { console.error('[NodOrder] 카메라 버튼 ID를 찾지 못했습니다.'); return; }
    button.addEventListener('click', startFromClick);
    const stop = el('btn-stop-camera');
    if (stop) stop.addEventListener('click', () => {
      stopStreams();
      if (!window.__nodOrderApp) {
        const video = el('webcam-video');
        if (video) video.srcObject = null;
        stop.disabled = true;
        show('카메라가 정지되었습니다.', false);
      }
    });
    console.info('[NodOrder:camera] 카메라 버튼 클릭 리스너 등록 완료');
    if (location.protocol === 'file:') show('파일 직접 열기 방식에서는 얼굴 인식 앱을 실행할 수 없습니다. 터미널 명령어로 로컬 서버를 열어 주세요.', true);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', registerControls, { once: true });
  else registerControls();
  window.addEventListener('error', (event) => {
    if (window.__nodOrderApp) return;
    const detail = event.message || (event.target && event.target.src ? `스크립트 불러오기 실패: ${event.target.src}` : '스크립트 실행 오류');
    moduleLoadError = detail;
    show('얼굴 인식 앱 실행 오류: ' + detail, true);
  }, true);
  window.addEventListener('unhandledrejection', (event) => {
    if (!window.__nodOrderApp) {
      moduleLoadError = event.reason?.message || '스크립트 로딩 오류';
      show('얼굴 인식 앱 초기화 오류: ' + moduleLoadError, true);
    }
  });
})();

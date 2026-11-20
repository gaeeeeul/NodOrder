/**
 * ==============================================================================
 * [NodOrder Data] storage.js
 * ------------------------------------------------------------------------------
 * 역할:
 * 1. 브라우저 IndexedDB를 활용하여 대용량 머리 제스처 특징 벡터 데이터 영구 보관
 * 2. 참가자(participantId)별 데이터 분리 저장, 조회, 통계 및 삭제 기능
 * 3. JSON 및 CSV 포맷 자동 변환 및 브라우저 즉시 다운로드 제공
 * 4. 페이지 새로고침이나 탭 종료 후에도 데이터 무손실 보장
 * 
 * 개인정보 보호:
 * - 오직 숫자 특징값(features)과 라벨만 저장되며, 영상/사진 파일은 일체 저장되지 않습니다.
 * ==============================================================================
 */

const DB_NAME = 'NodOrder_Dataset_DB';
const DB_VERSION = 1;
const STORE_NAME = 'gesture_samples';

export class DatasetStorage {
  constructor() {
    this.db = null;
    this.isReady = false;
  }

  /**
   * IndexedDB 초기화 및 오브젝트 스토어 생성
   * @returns {Promise<boolean>}
   */
  async init() {
    if (this.isReady && this.db) return true;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          // autoIncrement 키를 사용하여 대량의 프레임 레코드 순차 저장
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
          store.createIndex('participantId', 'participantId', { unique: false });
          store.createIndex('trialId', 'trialId', { unique: false });
          store.createIndex('label', 'label', { unique: false });
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        this.isReady = true;
        resolve(true);
      };

      request.onerror = (event) => {
        console.error('[DatasetStorage] IndexedDB 연결 실패:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  /**
   * 단일 또는 다중 프레임 샘플 저장
   * @param {Array<Object>|Object} samples 
   * @returns {Promise<number>} 저장된 레코드 수
   */
  async saveSamples(samples) {
    if (!this.db) await this.init();
    const sampleList = Array.isArray(samples) ? samples : [samples];
    if (sampleList.length === 0) return 0;

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      sampleList.forEach((sample) => {
        // 필수 필드 무결성 검증
        if (sample.participantId && sample.trialId && sample.label && Array.isArray(sample.features)) {
          store.add({
            participantId: String(sample.participantId).trim().toUpperCase(),
            trialId: String(sample.trialId),
            label: String(sample.label),
            timestamp: sample.timestamp || Date.now(),
            features: [...sample.features] // [noseDeltaX, noseDeltaY, headTiltDeg, mouthOpenRatio]
          });
        }
      });

      tx.oncomplete = () => resolve(sampleList.length);
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * 저장된 모든 샘플 조회
   * @returns {Promise<Array<Object>>}
   */
  async getAllSamples() {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAll();

      request.onsuccess = () => resolve(request.result || []);
      request.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * 특정 참가자의 샘플만 조회
   * @param {string} participantId 
   * @returns {Promise<Array<Object>>}
   */
  async getSamplesByParticipant(participantId) {
    if (!this.db) await this.init();
    const pid = String(participantId).trim().toUpperCase();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('participantId');
      const request = index.getAll(pid);

      request.onsuccess = () => resolve(request.result || []);
      request.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * 참가자별 수집 통계(샘플 수, 시행 수, 라벨 목록) 요약 반환
   * @returns {Promise<Array<Object>>}
   */
  async getParticipantSummary() {
    const all = await this.getAllSamples();
    const map = new Map();

    all.forEach((item) => {
      const pid = item.participantId;
      if (!map.has(pid)) {
        map.set(pid, {
          participantId: pid,
          sampleCount: 0,
          trialSet: new Set(),
          labels: new Set(),
          firstTimestamp: item.timestamp,
          lastTimestamp: item.timestamp
        });
      }
      const data = map.get(pid);
      data.sampleCount++;
      data.trialSet.add(item.trialId);
      data.labels.add(item.label);
      if (item.timestamp < data.firstTimestamp) data.firstTimestamp = item.timestamp;
      if (item.timestamp > data.lastTimestamp) data.lastTimestamp = item.timestamp;
    });

    return Array.from(map.values()).map((p) => ({
      participantId: p.participantId,
      sampleCount: p.sampleCount,
      trialCount: p.trialSet.size,
      labelCount: p.labels.size,
      labels: Array.from(p.labels),
      collectedAt: new Date(p.lastTimestamp).toLocaleString()
    }));
  }

  /**
   * 특정 참가자의 데이터 삭제
   * @param {string} participantId 
   */
  async deleteParticipant(participantId) {
    if (!this.db) await this.init();
    const pid = String(participantId).trim().toUpperCase();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('participantId');
      const request = index.openCursor(IDBKeyRange.only(pid));

      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };

      tx.oncomplete = () => resolve(true);
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * 데이터베이스 전체 비우기
   */
  async clearAll() {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.clear();

      request.onsuccess = () => resolve(true);
      request.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * JSON 파일 다운로드 트리거
   * @param {string|null} participantId - 특정 참가자 또는 전체(null)
   */
  async downloadJSON(participantId = null) {
    const samples = participantId
      ? await this.getSamplesByParticipant(participantId)
      : await this.getAllSamples();

    if (samples.length === 0) {
      throw new Error('다운로드할 데이터가 없습니다.');
    }

    const participants = participantId
      ? [participantId.toUpperCase()]
      : Array.from(new Set(samples.map((s) => s.participantId)));

    const exportData = {
      datasetVersion: '1.0',
      exportedAt: new Date().toISOString(),
      featureNames: [
        'noseDeltaX',
        'noseDeltaY',
        'headTiltDeg',
        'mouthOpenRatio'
      ],
      labels: Array.from(new Set(samples.map((s) => s.label))),
      participantIds: participants,
      totalSamples: samples.length,
      samples: samples.map(({ participantId, trialId, label, timestamp, features }) => ({
        participantId,
        trialId,
        label,
        timestamp,
        features
      }))
    };

    const fileName = participantId
      ? `NodOrder_${participantId}_dataset.json`
      : `NodOrder_All_participants_${new Date().toISOString().slice(0, 10)}.json`;

    this._triggerFileDownload(JSON.stringify(exportData, null, 2), fileName, 'application/json');
  }

  /**
   * CSV 파일 다운로드 트리거 (Pandas, scikit-learn, Excel 호환)
   * @param {string|null} participantId 
   */
  async downloadCSV(participantId = null) {
    const samples = participantId
      ? await this.getSamplesByParticipant(participantId)
      : await this.getAllSamples();

    if (samples.length === 0) {
      throw new Error('다운로드할 데이터가 없습니다.');
    }

    // CSV 헤더 작성
    const headers = [
      'participantId',
      'trialId',
      'label',
      'timestamp',
      'noseDeltaX',
      'noseDeltaY',
      'headTiltDeg',
      'mouthOpenRatio'
    ];

    const rows = samples.map((s) => {
      const f = s.features || [0, 0, 0, 0];
      return [
        s.participantId,
        s.trialId,
        s.label,
        s.timestamp,
        f[0] !== undefined ? f[0] : '',
        f[1] !== undefined ? f[1] : '',
        f[2] !== undefined ? f[2] : '',
        f[3] !== undefined ? f[3] : ''
      ].join(',');
    });

    const csvContent = '\uFEFF' + [headers.join(','), ...rows].join('\r\n'); // UTF-8 BOM 추가 (Excel 한글 깨짐 방지)

    const fileName = participantId
      ? `NodOrder_${participantId}_dataset.csv`
      : `NodOrder_All_participants_${new Date().toISOString().slice(0, 10)}.csv`;

    this._triggerFileDownload(csvContent, fileName, 'text/csv;charset=utf-8;');
  }

  /**
   * Blob을 이용한 브라우저 가상 다운로드 헬퍼
   * @private
   */
  _triggerFileDownload(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

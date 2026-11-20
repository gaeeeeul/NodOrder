# NodOrder Raw Dataset Directory
이 디렉터리는 피험자(Participant)별 실시간 원시 측정 데이터(Raw landmark sequences 또는 센서 수집본)를 보관하는 곳입니다.

## 파일 명명 규칙
- `P{참가자번호}_{제스처라벨}_{시행번호}_raw.json`
- 예시: `P01_nod_down_trial01_raw.json`

## 참가자(Participant) 단위 분리 원칙
- 특정 참가자의 데이터가 학습용(Train)과 평가용(Test)에 동시에 들어가면 데이터 누수(Data Leakage)가 발생하여 모델의 일반화 성능을 객관적으로 입증할 수 없습니다.
- 원시 데이터 수집 시 반드시 파일명과 메타데이터에 `participantId`를 기록하십시오.

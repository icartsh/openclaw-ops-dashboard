# 자비스 운영 대시보드 — UI 문구 수정 방법

이 프로젝트는 UI 문구를 `i18n-lite` 방식으로 관리합니다.

## 어디를 수정하면 되나요?

- **한글 문구 파일:** `client/src/i18n/ko.js`
- 화면(App)은 `import { KO as T } from "@/i18n/ko";` 형태로 불러와서 `T.xxx`만 사용합니다.

## 원칙 (라이언 취향 반영)

- 탭/표/버튼: **깔끔한 운영툴 문구** (예: 실행/비활성화/즉시 실행)
- 상태/토스트/P0 알림: **자비스/하루 역할극 톤** (예: "자비스: 정상이에요")

## 예시

- 앱 타이틀 변경: `KO.app.title`
- 크론 버튼 텍스트 변경: `KO.cron.enable`, `KO.cron.disable`
- 상태 문구 변경: `KO.status.loading`, `KO.status.ok`, `KO.status.error`

변경 후에는:

```bash
cd client
npm run build
```

(서버는 `client/dist`를 서빙합니다.)

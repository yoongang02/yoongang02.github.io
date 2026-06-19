# Notion 글 자동 발행 설정

이 프로젝트는 Notion 데이터베이스의 공개 대상 글을 Hugo Markdown으로 변환한 뒤 GitHub Pages에 배포합니다.

## 1. Notion 데이터베이스 속성

아래 이름과 타입으로 속성을 만드세요.

| 속성 | 타입 | 필수 | 용도 |
| --- | --- | --- | --- |
| `Title` | 제목 | 예 | 게시글 제목 |
| `Published` | 체크박스 | 예 | 체크한 글만 발행 |
| `Date` | 날짜 | 예 | 게시일 및 정렬 |
| `Slug` | 텍스트 | 아니요 | URL 경로. 비우면 제목으로 자동 생성 |
| `Description` | 텍스트 | 아니요 | 제목 아래 요약문과 메타 설명 |
| `Tags` | 다중 선택 | 아니요 | 게시글 태그 |
| `Categories` | 다중 선택 | 아니요 | Hugo 카테고리 |
| `Section` | 선택 | 아니요 | `posts`, `study`, `projects`, `ideas` 등 저장 섹션 |

속성 이름을 다르게 쓰고 싶다면 `.env.example`에 적힌 환경 변수로 매핑할 수 있습니다.

## 2. Notion 연결 만들기

1. Notion의 **Settings → Connections → Develop or manage integrations**에서 내부 연결을 만듭니다.
2. 연결 권한에서 콘텐츠 읽기를 허용합니다.
3. 게시글 데이터베이스의 `••• → Connections`에서 만든 연결을 추가합니다.
4. Integration secret과 Data source ID를 복사합니다.

Data source ID를 찾기 어렵다면 Database ID를 `NOTION_DATABASE_ID`로 지정해도 됩니다. 동기화 스크립트가 첫 번째 Data source를 자동 선택합니다.

## 3. 로컬에서 확인

```bash
cp .env.example .env
# .env에 실제 키와 ID 입력
npm run sync:notion
hugo server -D
```

동기화된 글은 기본적으로 `content/posts/<slug>/index.md`에 생성되고, Notion 이미지는 같은 글의 `notion-assets` 폴더에 내려받습니다.

## 4. GitHub Actions 자동 발행

GitHub 저장소의 **Settings → Secrets and variables → Actions**에 다음 Repository secret을 추가합니다.

- `NOTION_API_KEY`
- `NOTION_DATA_SOURCE_ID`

워크플로는 다음 상황에 Notion 글을 동기화하고 사이트를 배포합니다.

- `main` 브랜치에 push
- Actions 화면에서 수동 실행
- 30분마다 예약 실행
- `notion-publish` repository dispatch 이벤트 수신

예약 실행은 GitHub 상황에 따라 몇 분 늦을 수 있습니다. 거의 즉시 발행하려면 Notion 자동화나 별도 웹훅 서비스에서 GitHub의 `repository_dispatch` API를 호출하면 됩니다.

## 지원하는 Notion 본문

문단, 제목, 글머리 목록, 번호 목록, 체크박스, 인용문, 콜아웃, 코드, 수식, 구분선, 이미지, 첨부 파일, 북마크, 임베드 링크, 표와 중첩 블록을 변환합니다.

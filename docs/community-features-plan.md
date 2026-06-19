# 게시글 하트 및 댓글 기능 구현 계획

## 결론

GitHub Pages는 정적 호스팅이므로 하트와 댓글을 저장하려면 별도 API와 데이터베이스가 필요하다.
Notion 자동 발행 중계에도 사용할 Cloudflare Worker를 API 서버로 확장하고, Cloudflare D1과 Turnstile을
연결하는 구성을 권장한다.

## 공통 도구

- Cloudflare Worker: 하트, 댓글, Notion 발행 webhook API
- Cloudflare D1: 하트 수와 댓글 저장
- Cloudflare Turnstile: 자동화 요청과 스팸 방지
- Hugo: 게시글 slug 또는 `notion_id`를 고정 게시글 식별자로 출력

초기 개인 블로그 규모에서는 Cloudflare 무료 사용량으로 운영할 가능성이 높다. 실제 적용 전 계정별
한도와 예상 트래픽을 다시 확인한다.

## 1. 하트 기능

### 동작

1. 방문 시 브라우저에 임의 UUID를 생성해 localStorage와 cookie에 저장한다.
2. 게시글 화면이 `GET /api/posts/:postId/reactions`를 호출해 하트 수와 내 반응 여부를 가져온다.
3. 방문자가 하트를 누르면 Turnstile 검증 후 `POST /api/posts/:postId/reactions`를 호출한다.
4. 같은 게시글과 visitor ID 조합은 데이터베이스 unique index로 하나만 허용한다.
5. 다시 누르면 하트를 취소할 수 있도록 toggle 방식으로 구현한다.

### 한계

로그인 없이 현실의 한 사람을 완전히 식별할 수는 없다. 브라우저 데이터 삭제, 다른 브라우저 또는
다른 기기를 이용하면 다시 누를 수 있다. IP만으로 제한하면 학교·회사·가족 네트워크에서 서로 다른
방문자를 한 사람으로 오인하므로 권장하지 않는다.

### 테이블 예시

```sql
CREATE TABLE reactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX reactions_post_visitor
ON reactions (post_id, visitor_id);
```

### UI

- 게시글 상단의 공유 버튼 옆에 outline 하트 SVG와 개수를 배치한다.
- 누른 상태에서는 태그와 동일한 초록색 계열의 채움 색상을 사용한다.
- 목록 카드에서는 카드 하단 메타 영역에 작은 하트 아이콘과 개수를 표시한다.
- JavaScript가 비활성화되거나 API가 실패해도 본문 읽기는 방해하지 않는다.

## 2. 댓글 기능

### 권장 입력 방식

- 닉네임: 필수
- 댓글 내용: 필수
- 삭제 비밀번호: 필수, 서버에서 salt를 붙여 PBKDF2-SHA256으로 hash
- Turnstile: 필수

이메일을 받지 않아 개인정보 수집을 줄이고, 로그인 없이도 작성자를 화면에서 구분할 수 있다.
비밀번호는 댓글 수정·삭제에만 사용하며 원문을 저장하지 않는다. 비밀번호를 잊은 경우 복구할 수
없다는 안내가 필요하다.

### 테이블 예시

```sql
CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  nickname TEXT NOT NULL,
  body TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'visible',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);

CREATE INDEX comments_post_created
ON comments (post_id, created_at);
```

### API

- `GET /api/posts/:postId/comments`: 공개 댓글 목록
- `POST /api/posts/:postId/comments`: 댓글 작성
- `PATCH /api/comments/:commentId`: 비밀번호 확인 후 수정
- `DELETE /api/comments/:commentId`: 비밀번호 확인 후 soft delete

### 보안과 운영

- 모든 작성·수정·삭제 요청에서 Turnstile token을 서버에서 검증한다.
- Worker에서 IP 기반 짧은 시간 rate limit을 추가하되 IP 원문은 저장하지 않는다.
- 닉네임과 본문 길이를 제한하고 HTML을 허용하지 않는다.
- 출력할 때 HTML escape를 적용한다.
- 금칙어, 링크 개수 제한, 신고 또는 관리자 숨김 기능을 2차 단계로 추가한다.
- 댓글은 완전 삭제보다 `status = deleted` 방식으로 처리해 대화 순서를 유지한다.

### UI

- 이전글·다음글 컴포넌트 아래에 배치한다.
- 댓글 수, 닉네임, 작성일, 본문을 현재 본문 폭 안에서 표시한다.
- 입력 필드와 버튼은 기존 공유 버튼, 태그, 카드에서 사용하는 색상·radius 토큰을 재사용한다.
- 모바일에서는 닉네임과 비밀번호 입력을 한 열로 쌓는다.
- 로딩, 빈 상태, 오류, 작성 완료 상태를 각각 제공한다.

## 구현 순서

### 1단계: 백엔드 기반

1. Cloudflare Worker 프로젝트 생성
2. D1 데이터베이스와 migration 추가
3. CORS를 블로그 도메인과 localhost로 제한
4. 공통 JSON 응답, 오류 처리, rate limit 구성

### 2단계: 하트

1. reaction API와 unique index 구현
2. 게시글 상세 하트 UI 구현
3. 목록 카드의 하트 수 조회 방식 결정
4. Turnstile과 실패 상태 검증

목록에서 각 카드마다 별도 요청하지 않도록 `POST /api/reactions/counts`에 여러 post ID를 한 번에
전달하는 batch endpoint를 권장한다.

### 3단계: 댓글

1. 댓글 조회·작성 API
2. 비밀번호 hash 기반 수정·삭제 API
3. 댓글 목록과 작성 폼 UI
4. Turnstile, rate limit, 입력 검증
5. 관리자 숨김 기능

### 4단계: 운영 점검

1. 라이트·다크·모바일 UI 검증
2. API 장애 시 정적 페이지 fallback 확인
3. 개인정보 처리 안내와 댓글 운영 정책 추가
4. D1 백업 및 데이터 내보내기 절차 문서화

## 구현 전 필요한 사용자 결정

1. Cloudflare 계정을 사용해 Worker, D1, Turnstile을 구성할지
2. 하트를 다시 눌러 취소할 수 있게 할지
3. 댓글 수정 기능까지 제공할지, 삭제만 제공할지
4. 댓글을 즉시 공개할지, 관리자 승인 후 공개할지
5. 목록 카드에도 하트 수를 표시할지

## 참고 자료

- Cloudflare D1: https://developers.cloudflare.com/d1/
- Cloudflare Workers pricing: https://developers.cloudflare.com/workers/platform/pricing/
- Cloudflare Turnstile validation: https://developers.cloudflare.com/turnstile/get-started/server-side-validation/

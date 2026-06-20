# 하트·댓글·Notion 자동화 배포 설정

로컬 구현은 완료되어 있으며 실제 서비스 배포에는 Cloudflare 계정과 아래 설정이 필요합니다.

## 1. Cloudflare 인증

```bash
npx wrangler login
```

브라우저에서 Cloudflare 계정 접근을 승인합니다.

## 2. D1 데이터베이스 생성

```bash
npx wrangler d1 create yoongang-blog-community
```

출력되는 `database_id`를 `worker/wrangler.toml`의 `database_id = "local"` 대신 입력합니다.

원격 데이터베이스 migration:

```bash
npx wrangler d1 migrations apply yoongang-blog-community \
  --remote \
  --config worker/wrangler.toml
```

## 3. Turnstile 생성

Cloudflare Dashboard의 **Turnstile → Add widget**에서 다음 hostname을 허용합니다.

- `yoongang02.github.io`
- 로컬 테스트가 필요하면 `localhost`

발급된 값을 다음 위치에 설정합니다.

- Site key: `config/_default/params.toml`의 `community.turnstileSiteKey`
- Secret key:

```bash
npx wrangler secret put TURNSTILE_SECRET --config worker/wrangler.toml
```

## 4. Worker secrets

방문자 ID를 해시할 임의의 긴 문자열:

```bash
npx wrangler secret put VISITOR_HASH_SECRET --config worker/wrangler.toml
```

Notion 자동화가 보낼 webhook 비밀값:

```bash
npx wrangler secret put NOTION_WEBHOOK_SECRET --config worker/wrangler.toml
```

GitHub fine-grained token:

```bash
npx wrangler secret put GITHUB_TOKEN --config worker/wrangler.toml
```

GitHub token은 `yoongang02/yoongang02.github.io` 저장소로 범위를 제한하고
`Contents: Read and write` 권한을 부여합니다.

## 5. Worker 배포

```bash
npm run community:deploy
```

출력된 Worker URL을 `config/_default/params.toml`에 입력합니다.

```toml
[community]
enable = true
apiBaseURL = "https://yoongang-blog-community.<계정>.workers.dev"
turnstileSiteKey = "<TURNSTILE_SITE_KEY>"
```

## 6. Notion 자동화

Notion 데이터베이스에서 `Published`가 체크될 때 webhook을 전송하도록 설정합니다.

- URL: `<Worker URL>/webhooks/notion`
- Header: `X-Webhook-Secret`
- Header value: Worker에 저장한 `NOTION_WEBHOOK_SECRET`

발행 취소도 즉시 반영하려면 `Published`가 체크 해제될 때 같은 webhook을 보내는 자동화를 하나 더
추가합니다.

- Trigger: `Published`가 체크 해제될 때
- URL: `<Worker URL>/webhooks/notion/unpublish`
- Header: `X-Webhook-Secret`
- Header value: Worker에 저장한 `NOTION_WEBHOOK_SECRET`

취소 webhook은 GitHub Actions에 `notion-unpublish` 이벤트를 보냅니다. 워크플로가 공개 글 전체를
다시 동기화하면 체크 해제된 Notion 생성 글이 Hugo 콘텐츠에서 제거되고 GitHub Pages가 재배포됩니다.

## 7. 배포 전 확인

```bash
npm test
curl https://<Worker URL>/health
```

게시글에서 다음 항목을 확인합니다.

- 하트를 누른 뒤 새로고침해도 상태와 개수가 유지되는지
- 같은 브라우저에서 하트가 중복으로 증가하지 않는지
- 댓글 작성, 수정, 삭제가 가능한지
- 원댓글에 1단계 답글을 작성할 수 있고 답글이 들여쓰기되어 표시되는지
- 목록 카드에 하트 수가 표시되는지
- 모바일과 다크 모드에서 UI가 정상인지

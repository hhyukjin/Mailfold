# Mailfold

> Mailfold = mail + manifold: many mailboxes folded into one.

Mailfold는 manifold와 mail을 합친 이름으로, 여러 메일 계정(Gmail 여러 개 + 네이버 등)을 하나로 모아 준다는 뜻입니다.

이름 그대로, 흩어져 있는 메일 계정을 IMAP/SMTP로 한곳에 연결해 웹 UI와 claude.ai 원격 MCP(모바일 포함)에서 함께 읽고 관리하는 것을 목표로 하는 메일 서버입니다.
지금은 **0단계(연결 점검)** 로, 계정별 접속과 서버 기능을 읽기 전용으로 확인하는 단계입니다.

## 준비

- Node.js 22 이상
- 계정마다 앱 비밀번호(app password)
  - Gmail: 2단계 인증을 켠 뒤 Google 계정 > 보안 > 앱 비밀번호
  - 네이버: 메일 환경설정에서 IMAP/SMTP 사용을 켜고, 2단계 인증 사용 시 애플리케이션 비밀번호 발급

## 0단계: 연결 점검 (probe)

```bash
npm install
cp .env.example .env    # .env에 이메일과 앱 비밀번호를 채웁니다 (git에는 올라가지 않습니다)
npm run probe           # 모든 계정 점검
npm run probe -- naver1 # 한 계정만 점검 (계정 ID나 별칭)
```

점검은 **읽기 전용**입니다. 메일을 지우거나 옮기거나 읽음 표시를 바꾸지 않고, SMTP는 로그인만 확인하고 메일을 보내지 않습니다.

확인하는 항목은 다음과 같습니다.

- IMAP/SMTP 로그인 성공 여부
- 주요 CAPABILITY (MOVE, SPECIAL-USE, X-GM-EXT-1 등)
- 폴더 목록과 special-use 폴더(휴지통, 보낸편지함 등), 그리고 그 정보를 서버가 알려 준 것인지 이름으로 추정한 것인지
- INBOX의 PERMANENTFLAGS (사용자 정의 키워드 태그 가능 여부)
- 한글 제목 검색 동작
- Gmail이면 최근 메일 1통의 label 읽기

결과는 `probe-report.json`에 저장됩니다. 비밀번호는 들어 있지 않지만 이메일 주소와 폴더 이름이 들어 있으므로 git에서는 제외됩니다.

## 테스트

```bash
npm test                 # 전체 (단위 + 통합)
npm run test:unit        # 단위 테스트
npm run test:integration # 프로세스 안에 띄운 가짜 IMAP/SMTP 서버로 통합 테스트 (실제 계정 사용 안 함, Docker 불필요)
npm run typecheck
```

## 폴더 구조 (현재)

```
config/providers.json      메일 서버 정의 (git에 올림)
config/accounts.example.json  계정별 개인 설정 예시 (실제 accounts.json은 git 제외)
src/config/providers.ts    메일 서버 정의 검증
src/config/env-file.ts     .env 읽기 (중복 키 검사)
src/config/accounts.ts     계정 조립, 개인 설정, ID/별칭으로 계정 찾기
src/config/source.ts       ConfigSource 인터페이스와 파일 구현 (4단계에서 암호화 DB로 교체)
src/config/migrate-env.ts  이전 .env 형식 → 새 형식 변환
src/core/message-ref.ts    계정+폴더+UIDVALIDITY+UID 메일 참조
src/providers/folders.ts   폴더 역할 분류, 휴지통 확정 규칙
src/providers/imap-client.ts  IMAP 클라이언트 생성, 오류 안내
src/probe/probe.ts         연결 점검 로직
scripts/probe.ts           연결 점검 실행
scripts/migrate-env.ts     .env 형식 변환 실행
test/unit, test/integration, test/support/fake-servers.ts
```

## 설정

설정은 세 곳으로 나뉩니다. 4단계(원격 서버)에서는 `ConfigSource`를 암호화 DB 구현으로 바꿀 예정입니다.

| 파일 | 내용 | git |
|---|---|---|
| `config/providers.json` | 메일 서버 정의 (IMAP/SMTP 주소, 방식, 로그인 아이디 규칙) | 올림 |
| `.env` | 계정별 이메일과 앱 비밀번호 | 제외 |
| `config/accounts.json` | 계정별 별칭, 보내는 사람 이름, 휴지통 폴더 (없어도 됨) | 제외 (`accounts.example.json`만 올림) |

### config/providers.json

```json
{
  "naver": {
    "label": "네이버",
    "strategy": "imap",
    "imap": { "host": "imap.naver.com", "port": 993, "secure": true },
    "smtp": { "host": "smtp.naver.com", "port": 465, "secure": true },
    "login": "localpart"
  }
}
```

- 키는 소문자 영문만 씁니다. 새 서버는 항목만 추가하면 됩니다.
- `strategy`: `gmail`(Gmail 전용 IMAP 확장 사용) 또는 `imap`(일반)
- `login`: `email`(이메일 전체로 로그인) 또는 `localpart`(@ 앞부분만)

### .env

```bash
GMAIL1_EMAIL=you@gmail.com
GMAIL1_PASSWORD=xxxx xxxx xxxx xxxx
NAVER1_EMAIL=you@naver.com
NAVER1_PASSWORD=your-app-password
# NAVER1_LOGIN=you@naver.com   # 로그인 아이디 규칙을 덮어쓸 때만
```

- 키는 `<서버><번호>_EMAIL`, `<서버><번호>_PASSWORD`, 선택 `<서버><번호>_LOGIN`입니다.
- 계정 ID는 서버와 번호를 소문자로 붙인 것입니다 (`NAVER2_EMAIL` → `naver2`).
- 같은 키가 두 번 있거나, providers.json에 없는 서버이거나, 필드 이름이 틀리면 키 이름을 담은 오류가 납니다 (값은 오류에 넣지 않습니다).

### config/accounts.json (선택)

```json
{
  "naver1": { "alias": "개인 네이버", "displayName": "홍길동", "trashFolder": null }
}
```

- `.env`에 없는 계정 ID를 적거나, 별칭이 계정끼리 겹치면 오류가 납니다.
- 계정을 가리킬 때는 계정 ID와 별칭 어느 쪽이든 쓸 수 있습니다 (`npm run probe -- "개인 네이버"`).
- `trashFolder`는 서버가 휴지통을 알려 주지 않는 계정에만 적습니다. 지정이 없고 서버도 모르면 삭제는 거부됩니다 (영구 삭제로 대신하지 않음).

### 이전 형식에서 옮기기

`.env`가 이전 형식(`MAILFOLD_ACCOUNT_<별칭>_...`)이면 실행 시 오류가 나고 아래 명령을 안내합니다.

```bash
npm run migrate-env
```

- 원본을 `.env.backup-<타임스탬프>`로 먼저 복사합니다 (git 제외).
- 번호는 서버별로 `.env`에 나온 순서대로 매기고, 옛 별칭 → 새 계정 ID 매핑만 화면에 보여 줍니다. 값은 출력하지 않습니다.
- `NAME`, `TRASH_FOLDER`는 `config/accounts.json`으로 옮깁니다. 별칭은 비워 두니 원하면 직접 채우세요.

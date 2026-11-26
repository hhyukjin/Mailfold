/**
 * 통합 테스트용 가짜 메일 서버.
 * - IMAP: hoodiecrow-imap (프로세스 안에서 도는 IMAP 서버, MOVE·SPECIAL-USE·X-GM-EXT-1 플러그인 지원)
 * - SMTP: smtp-server
 * 실제 Gmail/네이버 계정은 쓰지 않습니다. (참고: CapyKkuing/naver-mail-mcp의 통합 테스트 방식)
 */
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { SMTPServer } from "smtp-server";
import type { AccountConfig } from "../../src/config/accounts.js";

const require = createRequire(import.meta.url);
const hoodiecrow = require("hoodiecrow-imap") as (opts: Record<string, unknown>) => {
  listen: (port: number, cb: () => void) => void;
  close: (cb: () => void) => void;
  address: () => AddressInfo;
};

export const TEST_USER = "testuser";
export const TEST_PASS = "testpass";

/** IMAP modified UTF-7 (RFC 3501 5.1.3): 한글 폴더 이름을 저장소 형식으로 바꿉니다. */
export function utf7(s: string): string {
  return s.replace(/&/g, "&-").replace(/[^\x20-\x7e]+/g, (run) => {
    const buf = Buffer.alloc(run.length * 2);
    for (let i = 0; i < run.length; i++) buf.writeUInt16BE(run.charCodeAt(i), i * 2);
    return `&${buf.toString("base64").replace(/=+$/, "").replace(/\//g, ",")}-`;
  });
}

export function plainMessage(opts: { from: string; to: string; subject: string; body: string; messageId: string }): string {
  // hoodiecrow는 SEARCH SUBJECT를 디코드하지 않은 원본 헤더와 비교하므로, 제목을 인코딩(=?UTF-8?B?...)하지 않고
  // UTF-8 그대로 둡니다. 실제 Gmail/네이버는 인코딩된 제목도 디코드해서 검색합니다 (probe로 실서버에서 확인).
  const subject = opts.subject;
  return [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${subject}`,
    "Date: Wed, 25 Nov 2026 09:00:00 +0900",
    `Message-ID: <${opts.messageId}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    opts.body,
    "",
  ].join("\r\n");
}

const inboxMessages = () => [
  {
    raw: plainMessage({ from: "a@example.com", to: "me@test", subject: "안녕하세요 견적 문의", body: "견적 부탁드립니다.", messageId: "m1@example.com" }),
    flags: [],
    internaldate: "25-Nov-2026 09:00:00 +0900",
  },
  {
    raw: plainMessage({ from: "b@example.com", to: "me@test", subject: "Weekly report", body: "report", messageId: "m2@example.com" }),
    flags: ["\\Seen"],
    internaldate: "25-Nov-2026 10:00:00 +0900",
  },
];

/** Gmail처럼: [Gmail]/ 아래 special-use 폴더, 사용자 label 폴더, 사용자 정의 키워드 허용 */
export function gmailLikeStorage() {
  return {
    INBOX: { messages: inboxMessages(), permanentFlags: ["\\Answered", "\\Flagged", "\\Draft", "\\Deleted", "\\Seen", "\\*"] },
    "": {
      separator: "/",
      folders: {
        "[Gmail]": {
          flags: ["\\Noselect"],
          folders: {
            "All Mail": { "special-use": "\\All" },
            "Sent Mail": { "special-use": "\\Sent" },
            Drafts: { "special-use": "\\Drafts" },
            Spam: { "special-use": "\\Junk" },
            Trash: { "special-use": "\\Trash" },
          },
        },
        Work: {},
      },
    },
  };
}

/** 네이버처럼(제3자 정보 기반 가정): 한글 폴더 이름, special-use 없음 */
export function naverLikeStorage() {
  return {
    INBOX: { messages: inboxMessages() },
    "": {
      separator: "/",
      folders: {
        [utf7("보낸메일함")]: {},
        [utf7("임시보관함")]: {},
        [utf7("휴지통")]: {},
        [utf7("스팸메일함")]: {},
        [utf7("업무")]: {},
      },
    },
  };
}

export interface FakeImap {
  port: number;
  close: () => Promise<void>;
}

export async function startFakeImap(storage: object, plugins: string[]): Promise<FakeImap> {
  const server = hoodiecrow({ plugins, secureConnection: true, storage });
  await new Promise<void>((r) => server.listen(0, r));
  return {
    port: server.address().port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export interface FakeSmtp {
  port: number;
  /** 서버가 받은 메일 수. probe는 메일을 보내지 않아야 하므로 0이어야 합니다. */
  received: () => number;
  close: () => Promise<void>;
}

export async function startFakeSmtp(): Promise<FakeSmtp> {
  let received = 0;
  const server = new SMTPServer({
    secure: true,
    authMethods: ["PLAIN", "LOGIN"],
    onAuth(auth, _session, cb) {
      if (auth.username === TEST_USER && auth.password === TEST_PASS) cb(null, { user: TEST_USER });
      else cb(new Error("Invalid username or password"));
    },
    onData(stream, _session, cb) {
      received++;
      stream.resume();
      stream.on("end", () => cb());
    },
    logger: false,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.server.address() as AddressInfo).port;
  return {
    port,
    received: () => received,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export function testAccount(
  id: string,
  provider: "gmail" | "naver" | "imap",
  imapPort: number,
  smtpPort: number,
  overrides: Partial<AccountConfig> = {},
): AccountConfig {
  return {
    id,
    provider,
    providerLabel: provider,
    strategy: provider === "gmail" ? "gmail" : "imap",
    email: `${TEST_USER}@test`,
    user: TEST_USER,
    password: TEST_PASS,
    imap: { host: "127.0.0.1", port: imapPort, secure: true },
    smtp: { host: "127.0.0.1", port: smtpPort, secure: true },
    insecureTls: true,
    ...overrides,
  };
}

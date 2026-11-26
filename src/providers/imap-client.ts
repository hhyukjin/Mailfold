import { ImapFlow } from "imapflow";
import type { AccountConfig } from "../config/accounts.js";

/** 계정 설정으로 IMAP 클라이언트를 만듭니다. 연결(connect)은 호출하는 쪽에서 합니다. */
export function createImapClient(account: AccountConfig): ImapFlow {
  const client = new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.secure,
    auth: { user: account.user, pass: account.password },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 30_000,
    greetingTimeout: 15_000,
    clientInfo: { name: "Mailfold", version: "0.0.1" },
    tls: { rejectUnauthorized: !account.insecureTls },
  });
  // 처리하지 않은 'error' 이벤트로 프로세스가 죽지 않게 합니다. 실제 오류는 각 명령의 Promise로 받습니다.
  client.on("error", () => undefined);
  return client;
}

/** 서버 오류를 사람이 알아들을 수 있는 말로 바꿉니다. 비밀번호는 절대 포함하지 않습니다. */
export function explainMailError(account: AccountConfig, e: unknown): string {
  const err = (e ?? {}) as {
    authenticationFailed?: boolean;
    responseText?: string;
    message?: string;
    code?: string;
  };
  const server = err.responseText ? ` (서버 응답: ${err.responseText})` : "";

  if (err.authenticationFailed || err.code === "EAUTH") {
    const hint =
      account.strategy === "gmail"
        ? "Google 계정에 2단계 인증을 켜고 만든 앱 비밀번호(16자리)를 넣었는지 확인하세요."
        : account.provider === "naver"
          ? "네이버 메일 환경설정에서 IMAP/SMTP 사용을 켰는지, 2단계 인증을 쓰면 애플리케이션 비밀번호를 넣었는지 확인하세요. " +
            "로그인 아이디가 이메일 전체가 아니라 아이디만이어야 할 수도 있습니다 (.env의 <계정ID>_LOGIN, 예: NAVER1_LOGIN)."
          : "아이디와 비밀번호를 확인하세요.";
    return `로그인 실패: ${hint}${server}`;
  }
  if (err.code === "ENOTFOUND" || err.code === "ECONNREFUSED" || err.code === "ETIMEDOUT") {
    return `서버에 접속할 수 없습니다 (${err.code}). 네트워크와 서버 주소를 확인하세요.`;
  }
  const parts = [err.message, err.responseText].filter((v): v is string => typeof v === "string" && v.length > 0);
  return parts.length > 0 ? [...new Set(parts)].join(" | ") : String(e);
}

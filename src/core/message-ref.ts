/**
 * 메일 참조(MessageRef): 여러 계정 중 "어느 계정의 어느 폴더의 어느 메일"인지를 한 문자열로 나타냅니다.
 *
 * 형식: <계정 별칭>:<폴더 경로(base64url)>:<UIDVALIDITY>:<UID>
 *
 * - IMAP의 UID는 폴더 안에서만 유일하고, 폴더의 UIDVALIDITY가 바뀌면 같은 UID가 다른 메일을 가리킬 수 있습니다.
 *   그래서 UIDVALIDITY를 함께 담고, 작업 전에 현재 값과 다르면 거부합니다 (엉뚱한 메일을 지우는 사고 방지).
 * - 메일을 다른 폴더로 옮기면 참조가 바뀝니다. 옮기는 작업은 새 참조를 돌려줘야 합니다.
 *
 * 참고: CapyKkuing/naver-mail-mcp의 메일 ID(폴더+UIDVALIDITY+UID)에 계정 별칭을 더한 형태입니다.
 */

export interface MessageRef {
  account: string;
  mailbox: string;
  uidValidity: string;
  uid: number;
}

export class InvalidMessageRefError extends Error {
  constructor(ref: string, reason: string) {
    super(`올바르지 않은 메일 참조입니다 (${reason}): ${ref}. search_messages 결과의 id를 그대로 쓰세요.`);
    this.name = "InvalidMessageRefError";
  }
}

const ACCOUNT_RE = /^[a-z0-9_]+$/;
const REF_RE = /^([a-z0-9_]+):([A-Za-z0-9_-]+):(\d+):(\d+)$/;

export function encodeMessageRef(ref: MessageRef): string {
  if (!ACCOUNT_RE.test(ref.account)) throw new Error(`계정 별칭 형식이 틀렸습니다: ${ref.account}`);
  if (!Number.isSafeInteger(ref.uid) || ref.uid <= 0) throw new Error(`UID가 올바르지 않습니다: ${ref.uid}`);
  if (!/^\d+$/.test(ref.uidValidity)) throw new Error(`UIDVALIDITY가 올바르지 않습니다: ${ref.uidValidity}`);
  const mailbox = Buffer.from(ref.mailbox, "utf8").toString("base64url");
  return `${ref.account}:${mailbox}:${ref.uidValidity}:${ref.uid}`;
}

export function decodeMessageRef(id: string): MessageRef {
  const m = REF_RE.exec(id.trim());
  if (!m) throw new InvalidMessageRefError(id, "형식 불일치");
  const [, account, mb, uidValidity, uidStr] = m as unknown as [string, string, string, string, string];
  const mailbox = Buffer.from(mb, "base64url").toString("utf8");
  // base64url은 아무 문자열이나 디코드되므로, 다시 인코드해서 같은지 확인합니다.
  if (mailbox.length === 0 || Buffer.from(mailbox, "utf8").toString("base64url") !== mb) {
    throw new InvalidMessageRefError(id, "폴더 경로 손상");
  }
  const uid = Number(uidStr);
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new InvalidMessageRefError(id, "UID 범위");
  return { account, mailbox, uidValidity, uid };
}

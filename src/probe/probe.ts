/**
 * 0단계 연결 점검(probe) 로직.
 *
 * 읽기 전용입니다. 메일을 지우거나 옮기거나 표시(flag)를 바꾸는 명령은 보내지 않고,
 * SMTP도 로그인만 확인하고 메일은 보내지 않습니다. (integration 테스트가 이를 검증합니다.)
 */
import nodemailer from "nodemailer";
import { describeAccount, type AccountConfig } from "../config/accounts.js";
import { classifyFolders, resolveTrash, TrashNotFoundError, type FolderInfo } from "../providers/folders.js";
import { createImapClient, explainMailError } from "../providers/imap-client.js";

/** 메일 기능에 영향을 주는 CAPABILITY만 따로 표시합니다. */
export const KEY_CAPABILITIES = [
  "MOVE",
  "SPECIAL-USE",
  "UIDPLUS",
  "CONDSTORE",
  "QRESYNC",
  "IDLE",
  "ID",
  "UTF8=ACCEPT",
  "X-GM-EXT-1",
  "LIST-STATUS",
] as const;

export interface ImapProbe {
  ok: boolean;
  error?: string;
  capabilities?: string[];
  keyCapabilities?: Record<string, boolean>;
  folders?: Array<FolderInfo & { messages?: number; unseen?: number }>;
  trash?: { path: string; source: string } | { error: string; candidate?: string };
  inbox?: {
    exists: number;
    flags: string[];
    permanentFlags: string[];
    /** PERMANENTFLAGS에 \* 가 있으면 사용자 정의 키워드(태그)를 붙일 수 있습니다. */
    customKeywordsAllowed: boolean;
  };
  koreanSearch?: { ok: boolean; matches?: number; error?: string };
  gmailLabelsSample?: { ok: boolean; labels?: string[]; error?: string };
}

export interface SmtpProbe {
  ok: boolean;
  error?: string;
}

export interface AccountProbe {
  account: ReturnType<typeof describeAccount>;
  imap: ImapProbe;
  smtp: SmtpProbe;
}

export async function probeImap(account: AccountConfig): Promise<ImapProbe> {
  const client = createImapClient(account);
  const result: ImapProbe = { ok: false };
  try {
    await client.connect();

    result.capabilities = [...client.capabilities.keys()].sort();
    result.keyCapabilities = Object.fromEntries(KEY_CAPABILITIES.map((c) => [c, client.capabilities.has(c)]));

    const list = await client.list({ statusQuery: { messages: true, unseen: true } });
    const classified = classifyFolders(list);
    result.folders = classified.map((f, i) => ({
      ...f,
      messages: list[i]?.status?.messages,
      unseen: list[i]?.status?.unseen,
    }));

    try {
      result.trash = resolveTrash(account.id, classified, account.trashFolder);
    } catch (e) {
      if (!(e instanceof TrashNotFoundError)) throw e;
      result.trash = { error: e.message, candidate: e.candidate };
    }

    // PERMANENTFLAGS는 읽기 전용(EXAMINE)으로 열면 비어 있을 수 있어서 SELECT로 엽니다.
    // SELECT만으로는 메일이 바뀌지 않으며, 아래에서는 어떤 표시도 바꾸지 않습니다.
    const lock = await client.getMailboxLock("INBOX");
    try {
      const mb = client.mailbox || undefined;
      if (mb) {
        const perm = [...(mb.permanentFlags ?? [])];
        result.inbox = {
          exists: mb.exists,
          flags: [...mb.flags],
          permanentFlags: perm,
          customKeywordsAllowed: perm.includes("\\*"),
        };
      }

      // 한글 제목 검색이 오류 없이 되는지 확인합니다 (결과 개수만 봅니다).
      try {
        const found = await client.search({ subject: "안녕" }, { uid: true });
        result.koreanSearch = { ok: true, matches: Array.isArray(found) ? found.length : 0 };
      } catch (e) {
        result.koreanSearch = { ok: false, error: explainMailError(account, e) };
      }

      // Gmail이면 가장 최근 메일 1통의 label을 읽어 X-GM-LABELS 동작을 확인합니다.
      // label만 읽고 본문은 읽지 않으므로 \Seen(읽음)이 바뀌지 않습니다.
      if (client.capabilities.has("X-GM-EXT-1") && (mb?.exists ?? 0) > 0) {
        try {
          const msg = await client.fetchOne("*", { uid: true, labels: true });
          result.gmailLabelsSample = { ok: true, labels: msg ? [...(msg.labels ?? [])] : [] };
        } catch (e) {
          result.gmailLabelsSample = { ok: false, error: explainMailError(account, e) };
        }
      }
    } finally {
      lock.release();
    }
    result.ok = true;
  } catch (e) {
    result.ok = false;
    result.error = explainMailError(account, e);
  } finally {
    await client.logout().catch(() => client.close());
  }
  return result;
}

export async function probeSmtp(account: AccountConfig): Promise<SmtpProbe> {
  const transport = nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    auth: { user: account.user, pass: account.password },
    tls: { rejectUnauthorized: !account.insecureTls },
    connectionTimeout: 30_000,
  });
  try {
    await transport.verify(); // 로그인만 확인하고 메일은 보내지 않습니다.
    return { ok: true };
  } catch (e) {
    return { ok: false, error: explainMailError(account, e) };
  } finally {
    transport.close();
  }
}

export async function probeAccount(account: AccountConfig): Promise<AccountProbe> {
  const [imap, smtp] = await Promise.all([probeImap(account), probeSmtp(account)]);
  return { account: describeAccount(account), imap, smtp };
}

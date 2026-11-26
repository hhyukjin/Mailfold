/**
 * 폴더 분류와 휴지통 찾기.
 *
 * 원칙
 * - 서버가 SPECIAL-USE로 직접 알려 준 역할만 확정(authoritative)으로 봅니다.
 * - imapflow는 SPECIAL-USE가 없을 때 영어 폴더 이름으로 역할을 추정해 specialUseSource='name'을 붙입니다.
 *   Mailfold는 이 추정과 한글 이름 추정을 "참고용"으로만 기록하고, 삭제 같은 작업에는 쓰지 않습니다.
 * - 휴지통은 (1) 서버의 \Trash, (2) 사용자가 설정한 폴더 순서로만 정합니다. 둘 다 없으면 에러입니다.
 *   절대 EXPUNGE로 대신하지 않습니다 (cldt-fr/imap-mcp는 이 경우 조용히 영구 삭제함 → 반면교사).
 */

export type FolderRole = "inbox" | "sent" | "drafts" | "trash" | "junk" | "archive" | "all" | "flagged" | "important";
export type RoleSource = "server" | "config" | "name-guess";

/** imapflow ListResponse 중 필요한 부분만 (테스트에서 쉽게 만들 수 있도록) */
export interface ListedFolder {
  path: string;
  name: string;
  delimiter: string;
  flags: Set<string>;
  specialUse?: string;
  specialUseSource?: "user" | "extension" | "name";
}

export interface FolderInfo {
  path: string;
  name: string;
  delimiter: string;
  flags: string[];
  selectable: boolean;
  role?: FolderRole;
  roleSource?: RoleSource;
}

const ROLE_BY_SPECIAL_USE: Record<string, FolderRole> = {
  "\\Inbox": "inbox",
  "\\Sent": "sent",
  "\\Drafts": "drafts",
  "\\Trash": "trash",
  "\\Junk": "junk",
  "\\Archive": "archive",
  "\\All": "all",
  "\\Flagged": "flagged",
  "\\Important": "important",
};

/** 이름으로 추정 (참고용). 네이버는 한글 폴더명을 쓴다는 제3자 정보가 있어 함께 넣습니다. */
const ROLE_NAME_HINTS: Array<[RegExp, FolderRole]> = [
  [/^(sent( messages| items)?|보낸\s*메일함?)$/i, "sent"],
  [/^(drafts?|임시\s*보관함?)$/i, "drafts"],
  [/^(trash|deleted( messages| items)?|휴지통)$/i, "trash"],
  [/^(junk|spam|스팸\s*메일함?)$/i, "junk"],
];

const ROLE_BY_LOWER_FLAG = new Map(Object.entries(ROLE_BY_SPECIAL_USE).map(([k, v]) => [k.toLowerCase(), v]));

/** LIST 응답 속성(flags) 중 special-use 속성이 있으면 그 역할을 돌려줍니다. 대소문자는 구분하지 않습니다. */
function serverRoleFromFlags(flags: Set<string>): FolderRole | undefined {
  for (const flag of flags) {
    const role = ROLE_BY_LOWER_FLAG.get(flag.toLowerCase());
    if (role && role !== "inbox") return role;
  }
  return undefined;
}

export function classifyFolders(list: ListedFolder[]): FolderInfo[] {
  const folders: FolderInfo[] = list.map((f) => ({
    path: f.path,
    name: f.name,
    delimiter: f.delimiter || "/",
    flags: [...f.flags],
    selectable: !f.flags.has("\\Noselect") && !f.flags.has("\\NonExistent"),
  }));
  const taken = new Set<FolderRole>();

  // 1) INBOX는 이름이 표준이라 확정입니다.
  // 2) 서버가 직접 알려 준 special-use (extension)
  list.forEach((f, i) => {
    const info = folders[i]!;
    if (!info.selectable) return;
    let role: FolderRole | undefined;
    if (f.path.toUpperCase() === "INBOX") role = "inbox";
    else if (f.specialUse && f.specialUseSource !== "name") role = ROLE_BY_SPECIAL_USE[f.specialUse];
    // imapflow는 RFC 6154의 속성만 specialUse로 옮기고 Gmail의 \Important 같은 속성은 flags에만 남깁니다.
    // LIST 응답의 속성은 서버가 직접 보낸 것이므로 flags에 있는 special-use 속성도 server 근거로 인정합니다.
    role ??= serverRoleFromFlags(f.flags);
    if (role && !taken.has(role)) {
      info.role = role;
      info.roleSource = "server";
      taken.add(role);
    }
  });

  // 3) 이름 추정 (imapflow의 name 추정 포함). 참고용 표시만 합니다.
  list.forEach((f, i) => {
    const info = folders[i]!;
    if (!info.selectable || info.role) return;
    let role: FolderRole | undefined;
    if (f.specialUse && f.specialUseSource === "name") role = ROLE_BY_SPECIAL_USE[f.specialUse];
    role ??= ROLE_NAME_HINTS.find(([re]) => re.test(f.name))?.[1];
    if (role && !taken.has(role)) {
      info.role = role;
      info.roleSource = "name-guess";
      taken.add(role);
    }
  });

  return folders;
}

export class TrashNotFoundError extends Error {
  constructor(
    public readonly account: string,
    public readonly candidate?: string,
  ) {
    super(
      `[${account}] 휴지통 폴더를 확정할 수 없어 삭제하지 않았습니다. ` +
        (candidate
          ? `이름으로 보면 "${candidate}"가 휴지통 같지만 서버가 확인해 주지 않았습니다. 맞다면 config/accounts.json에서 이 계정의 trashFolder를 "${candidate}"로 지정해 주세요.`
          : `config/accounts.json에서 이 계정의 trashFolder로 휴지통 폴더를 지정해 주세요.`),
    );
    this.name = "TrashNotFoundError";
  }
}

export interface ResolvedFolder {
  path: string;
  source: Exclude<RoleSource, "name-guess">;
}

/** 휴지통 경로를 정합니다. 확정할 수 없으면 TrashNotFoundError를 던집니다. */
export function resolveTrash(account: string, folders: FolderInfo[], configuredPath?: string): ResolvedFolder {
  const server = folders.find((f) => f.role === "trash" && f.roleSource === "server");
  if (server) return { path: server.path, source: "server" };

  if (configuredPath) {
    const configured = folders.find((f) => f.path === configuredPath && f.selectable);
    if (configured) return { path: configured.path, source: "config" };
  }

  const guess = folders.find((f) => f.role === "trash" && f.roleSource === "name-guess");
  throw new TrashNotFoundError(account, guess?.path);
}

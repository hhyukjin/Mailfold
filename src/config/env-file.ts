import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

/**
 * .env 파일 읽기. 비밀 값(앱 비밀번호)만 두는 파일입니다.
 *
 * process.env를 바꾸지 않고 내용을 객체로 돌려줍니다. 같은 키가 두 번 이상 있으면 읽지 않고 오류를 냅니다.
 * (Node의 .env 파서는 중복 키를 조용히 뒤의 값으로 덮어써서, 계정 블록을 복사해 붙이면 계정이 소리 없이 사라집니다.)
 * 오류 메시지에는 키 이름과 줄 번호만 넣고 값은 절대 넣지 않습니다.
 */

export interface EnvKeyLine {
  key: string;
  /** 1부터 시작하는 줄 번호 */
  line: number;
}

export interface DuplicateEnvKey {
  key: string;
  lines: number[];
}

/** .env 내용에서 키 이름과 줄 번호만 뽑습니다 (주석, 빈 줄, 여러 줄 따옴표 값의 안쪽은 건너뜁니다). */
export function listEnvKeys(text: string): EnvKeyLine[] {
  const out: EnvKeyLine[] = [];
  let openQuote: string | undefined; // 여러 줄에 걸친 따옴표 값 안이면 그 따옴표 문자

  text.split(/\r?\n/).forEach((line, i) => {
    if (openQuote) {
      if (line.includes(openQuote)) openQuote = undefined;
      return;
    }
    const m = /^\s*(?:export\s+)?([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (!m) return;
    const rest = m[2]!;
    const q = rest[0];
    if ((q === '"' || q === "'" || q === "`") && !rest.slice(1).includes(q)) openQuote = q;
    out.push({ key: m[1]!, line: i + 1 });
  });
  return out;
}

export function findDuplicateEnvKeys(text: string): DuplicateEnvKey[] {
  const seen = new Map<string, number[]>();
  for (const { key, line } of listEnvKeys(text)) seen.set(key, [...(seen.get(key) ?? []), line]);
  return [...seen.entries()].filter(([, l]) => l.length > 1).map(([key, lines]) => ({ key, lines }));
}

export class DuplicateEnvKeyError extends Error {
  constructor(
    public readonly path: string,
    public readonly duplicates: DuplicateEnvKey[],
  ) {
    const detail = duplicates.map((d) => `${d.key} (줄 ${d.lines.join(", ")})`).join("\n  - ");
    super(
      `${path}에 같은 키가 여러 번 있습니다. 뒤의 값이 앞의 값을 조용히 덮어쓰므로 읽지 않았습니다.\n  - ${detail}\n` +
        `계정을 하나 더 넣으려면 번호를 다르게 지어 주세요 (예: GMAIL1_EMAIL 다음은 GMAIL2_EMAIL).`,
    );
    this.name = "DuplicateEnvKeyError";
  }
}

/** .env 내용을 검사한 뒤 키-값 객체로 돌려줍니다. */
export function parseEnvText(text: string, path = ".env"): Record<string, string> {
  const dups = findDuplicateEnvKeys(text);
  if (dups.length > 0) throw new DuplicateEnvKeyError(path, dups);
  return parseEnv(text) as Record<string, string>;
}

/** .env 파일이 있으면 읽고, 없으면 빈 객체를 돌려줍니다. */
export function readEnvFile(path = ".env"): Record<string, string> {
  if (!existsSync(path)) return {};
  return parseEnvText(readFileSync(path, "utf8"), path);
}

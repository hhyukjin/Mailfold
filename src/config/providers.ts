import { z } from "zod";

/**
 * 메일 서버(provider) 정의. config/providers.json에 두고 git에 올립니다.
 * 새 메일 서버는 이 파일에 항목만 추가하면 됩니다. 비밀 값은 들어가지 않습니다.
 *
 * - strategy: "gmail" = Gmail 전용 IMAP 확장(X-GM-LABELS 등)을 쓰는 방식, "imap" = 일반 IMAP
 * - login:    "email" = 이메일 전체로 로그인, "localpart" = @ 앞부분(아이디)만으로 로그인
 */

export const ServerEndpointSchema = z
  .object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    /** true면 처음부터 TLS로 접속합니다 (993/465). false면 STARTTLS(143/587). */
    secure: z.boolean(),
  })
  .strict();
export type ServerEndpoint = z.infer<typeof ServerEndpointSchema>;

export const ProviderStrategy = z.enum(["gmail", "imap"]);
export type ProviderStrategy = z.infer<typeof ProviderStrategy>;

export const LoginRule = z.enum(["email", "localpart"]);
export type LoginRule = z.infer<typeof LoginRule>;

export const ProviderDefSchema = z
  .object({
    label: z.string().min(1),
    strategy: ProviderStrategy,
    imap: ServerEndpointSchema,
    smtp: ServerEndpointSchema,
    login: LoginRule,
  })
  .strict();
export type ProviderDef = z.infer<typeof ProviderDefSchema>;

/** provider 키는 소문자 영문만 씁니다. .env의 GMAIL1_EMAIL 같은 키 앞부분과 대소문자 무시로 맞춥니다. */
export const PROVIDER_KEY_RE = /^[a-z]+$/;

export const ProvidersSchema = z
  .record(z.string().regex(PROVIDER_KEY_RE, "provider 키는 소문자 영문만 쓸 수 있습니다"), ProviderDefSchema)
  .refine((m) => Object.keys(m).length > 0, "provider가 하나도 없습니다");
export type Providers = z.infer<typeof ProvidersSchema>;

export class ProvidersConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvidersConfigError";
  }
}

/** providers.json 내용(JSON 문자열 또는 이미 파싱한 값)을 검증합니다. */
export function parseProviders(input: unknown, source = "config/providers.json"): Providers {
  let data = input;
  if (typeof input === "string") {
    try {
      data = JSON.parse(input);
    } catch (e) {
      throw new ProvidersConfigError(`${source}가 올바른 JSON이 아닙니다: ${(e as Error).message}`);
    }
  }
  const parsed = ProvidersSchema.safeParse(data);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(전체)"}: ${i.message}`)
      .join("\n  - ");
    throw new ProvidersConfigError(`${source} 형식 오류:\n  - ${detail}`);
  }
  return parsed.data;
}

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { accountsFromEnv, applyAccountSettings, parseAccountSettings, type AccountConfig } from "./accounts.js";
import { readEnvFile } from "./env-file.js";
import { parseProviders, ProvidersConfigError, type Providers } from "./providers.js";

/**
 * 설정을 어디서 읽는지 감추는 인터페이스.
 *
 * 지금(0~3단계)은 로컬 파일(FileConfigSource)에서 읽습니다.
 * 4단계(원격 서버)에서는 암호화된 DB에서 읽는 구현으로 교체할 예정이므로,
 * 나머지 코드는 파일 경로나 .env를 직접 다루지 말고 이 인터페이스만 쓰세요.
 */
export interface ConfigSource {
  loadProviders(): Promise<Providers>;
  loadAccounts(): Promise<AccountConfig[]>;
}

export interface FileConfigSourceOptions {
  /** 기준 폴더. 기본값은 현재 작업 폴더입니다. */
  rootDir?: string;
  envPath?: string;
  providersPath?: string;
  accountsPath?: string;
}

/**
 * 파일 기반 설정.
 * - <root>/config/providers.json : 메일 서버 정의 (필수, git에 올림)
 * - <root>/.env                  : 계정 이메일과 앱 비밀번호 (git 제외). process.env는 바꾸지 않습니다.
 * - <root>/config/accounts.json  : 계정별 개인 설정 (선택, git 제외)
 */
export class FileConfigSource implements ConfigSource {
  readonly envPath: string;
  readonly providersPath: string;
  readonly accountsPath: string;

  constructor(opts: FileConfigSourceOptions = {}) {
    const root = opts.rootDir ?? process.cwd();
    this.envPath = opts.envPath ?? join(root, ".env");
    this.providersPath = opts.providersPath ?? join(root, "config", "providers.json");
    this.accountsPath = opts.accountsPath ?? join(root, "config", "accounts.json");
  }

  async loadProviders(): Promise<Providers> {
    if (!existsSync(this.providersPath)) {
      throw new ProvidersConfigError(`메일 서버 정의 파일이 없습니다: ${this.providersPath}`);
    }
    return parseProviders(readFileSync(this.providersPath, "utf8"), this.providersPath);
  }

  async loadAccounts(): Promise<AccountConfig[]> {
    const providers = await this.loadProviders();
    const accounts = accountsFromEnv(readEnvFile(this.envPath), providers);
    if (!existsSync(this.accountsPath)) return accounts;
    const settings = parseAccountSettings(readFileSync(this.accountsPath, "utf8"), this.accountsPath);
    return applyAccountSettings(accounts, settings, this.accountsPath);
  }
}

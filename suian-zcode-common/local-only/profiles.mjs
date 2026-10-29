// 本地随包注册表：新版本追加档案并保留旧档案，不按版本范围或列表顺序兜底。
import { SUPPORTED_PACKAGE, PATCH_VERSION, MAIN_ENTRY, applyInjections } from './profiles/windows-3.16.2.8769.mjs';
import * as windows3163 from './profiles/windows-3.16.3.8992.mjs';
import * as windows3171 from './profiles/windows-3.17.1.9553.mjs';

export const TARGET_LAYOUT = Object.freeze({ exeName: 'ZCode.exe', appAsarRelativePath: 'resources/app.asar' });
export const PATCH_PROFILES = Object.freeze([
  Object.freeze({ id: 'windows-3.16.2.8769-1f960ba2', platform: 'win32', packageIdentity: SUPPORTED_PACKAGE, patchVersion: PATCH_VERSION, mainEntry: MAIN_ENTRY, applyInjections }),
  Object.freeze({ id: 'windows-3.16.3.8992-21183dbf', platform: 'win32', packageIdentity: windows3163.SUPPORTED_PACKAGE, patchVersion: windows3163.PATCH_VERSION, mainEntry: windows3163.MAIN_ENTRY, applyInjections: windows3163.applyInjections }),
  Object.freeze({ id: 'windows-3.17.1.9553-9a09f6ef', platform: 'win32', packageIdentity: windows3171.SUPPORTED_PACKAGE, patchVersion: windows3171.PATCH_VERSION, mainEntry: windows3171.MAIN_ENTRY, applyInjections: windows3171.applyInjections }),
]);

export function selectProfile({ actual, state = null, profiles = PATCH_PROFILES, platform = process.platform }) {
  const originalSha = String(state?.originalAsarSha256 ?? actual.appAsarSha256).toLowerCase();
  const matches = profiles.filter(p => p.platform === platform
    && p.packageIdentity.exeFileVersion === actual.exeFileVersion
    && p.packageIdentity.appAsarSha256.toLowerCase() === originalSha);
  if (matches.length !== 1) {
    const sameVersion = profiles.some(p => p.platform === platform && p.packageIdentity.exeFileVersion === actual.exeFileVersion);
    return { ok: false, code: sameVersion ? 'digest_mismatch' : 'unsupported_package', reason: matches.length > 1
      ? '多个适配档案命中相同包身份，拒绝选择'
      : sameVersion ? 'app.asar SHA-256 不符：未登记该原包摘要' : `exe 版本不符或平台未适配：${platform} / ${actual.exeFileVersion}` };
  }
  const profile = matches[0];
  if (state && ((state.profileId !== undefined && state.profileId !== profile.id)
    || (state.platform !== undefined && state.platform !== platform)
    || state.targetExeFileVersion !== actual.exeFileVersion)) {
    return { ok: false, code: 'digest_mismatch', reason: '状态记录的档案、平台或 exe 版本与目标不符' };
  }
  return { ok: true, profile };
}

/**
 * 用户机型配置目录：userData/neglift-camera-profiles/*.json
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import {
  findBuiltinProfile,
  matchesProfile,
  mergeProfiles,
  parseCameraProfiles,
  BUILTIN_CAMERA_PROFILES,
  type CameraProfile
} from '@shared/cameraProfile'

let userProfiles: CameraProfile[] | null = null

function profileDir(): string {
  return join(app.getPath('userData'), 'neglift-camera-profiles')
}

export async function loadUserProfiles(force = false): Promise<CameraProfile[]> {
  if (userProfiles && !force) return userProfiles
  const dir = profileDir()
  try {
    await fs.mkdir(dir, { recursive: true })
    const files = await fs.readdir(dir)
    const list: CameraProfile[] = []
    for (const f of files) {
      if (!f.toLowerCase().endsWith('.json')) continue
      try {
        const text = await fs.readFile(join(dir, f), 'utf8')
        list.push(...parseCameraProfiles(text))
      } catch {
        /* 跳过坏文件 */
      }
    }
    userProfiles = list
  } catch {
    userProfiles = []
  }
  return userProfiles
}

/** 写入用户配置 JSON，返回路径 */
export async function importCameraProfilesJson(json: string, fileName?: string): Promise<{ path: string; count: number }> {
  const profiles = parseCameraProfiles(json)
  if (profiles.length === 0) throw new Error('未找到有效的机型配置（需要 match.make 或 match.model）')
  const dir = profileDir()
  await fs.mkdir(dir, { recursive: true })
  const base = (fileName || `profile-${Date.now().toString(36)}`).replace(/[^\w.-]+/g, '_')
  const name = base.endsWith('.json') ? base : `${base}.json`
  const path = join(dir, name)
  // 只存用户段（不含 builtin 标记依赖）
  const stripped = profiles.map((p) => ({ ...p, builtin: undefined }))
  await fs.writeFile(path, JSON.stringify(stripped, null, 2), 'utf8')
  await loadUserProfiles(true)
  return { path, count: profiles.length }
}

/** 按机身元数据解析生效配置：用户配置优先，其次内置 */
export async function resolveProfileForCamera(
  make?: string,
  model?: string
): Promise<{ profile: CameraProfile | null; source: 'user' | 'builtin' | 'none' }> {
  const users = await loadUserProfiles()
  for (const p of users) {
    if (matchesProfile(p, make, model)) {
      const builtin = findBuiltinProfile(make, model)
      return { profile: mergeProfiles(builtin, p), source: 'user' }
    }
  }
  const b = findBuiltinProfile(make, model)
  return { profile: b, source: b ? 'builtin' : 'none' }
}

export function listAllProfiles(users: CameraProfile[]): CameraProfile[] {
  return [...users, ...BUILTIN_CAMERA_PROFILES]
}

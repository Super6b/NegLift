import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { canActivateConfiguration, createConfigurationRevision, parseFidelityConfigurationDocument, serializeFidelityConfigurationDocument, type ConfigurationRevisionResult, type FidelityConfiguration } from '@shared/fidelityConfiguration'

/** 本地、离线配置库；原始图像始终由用户在文件系统中保管。 */
export class FidelityConfigurationStore {
  constructor(private readonly filePath: string) {}
  async list(): Promise<FidelityConfiguration[]> {
    try { return parseFidelityConfigurationDocument(await fs.readFile(this.filePath, 'utf8')).configurations }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  }
  async saveDraft(configuration: FidelityConfiguration): Promise<void> {
    const validated = parseFidelityConfigurationDocument(JSON.stringify([configuration])).configurations[0]
    if (validated.status !== 'draft') throw new Error('只能原地保存配置草稿；已发布配置必须创建修订版')
    const configurations = await this.list(); const index = configurations.findIndex((item) => item.id === validated.id)
    if (index >= 0) configurations[index] = validated; else configurations.push(validated)
    await this.write(configurations)
  }
  async activate(id: string): Promise<FidelityConfiguration> {
    const configurations = await this.list(); const index = configurations.findIndex((item) => item.id === id)
    if (index < 0) throw new Error('找不到保真采集配置')
    const configuration = configurations[index]
    if (!canActivateConfiguration(configuration)) throw new Error('配置草稿尚未满足已验证采集配置条件')
    const active = { ...configuration, status: 'active' as const }; configurations[index] = active; await this.write(configurations); return active
  }
  async revise(id: string, nextId: string, createdAt: string, changes: Parameters<typeof createConfigurationRevision>[3]): Promise<ConfigurationRevisionResult> {
    const configurations = await this.list(); const index = configurations.findIndex((item) => item.id === id)
    if (index < 0) throw new Error('找不到保真采集配置')
    if (configurations.some((item) => item.id === nextId)) throw new Error('新的配置修订版标识已存在')
    const result = createConfigurationRevision(configurations[index], nextId, createdAt, changes)
    configurations[index] = result.superseded; configurations.push(result.revision); await this.write(configurations); return result
  }
  async importJson(json: string): Promise<number> {
    const imported = parseFidelityConfigurationDocument(json).configurations; const configurations = await this.list(); const existing = new Set(configurations.map((item) => item.id))
    if (imported.some((item) => existing.has(item.id))) throw new Error('导入包含已存在的配置标识')
    await this.write([...configurations, ...imported]); return imported.length
  }
  async exportJson(): Promise<string> { return serializeFidelityConfigurationDocument(await this.list()) }
  private async write(configurations: FidelityConfiguration[]): Promise<void> {
    await fs.mkdir(dirname(this.filePath), { recursive: true }); const temporary = `${this.filePath}.tmp`
    await fs.writeFile(temporary, serializeFidelityConfigurationDocument(configurations), 'utf8'); await fs.rename(temporary, this.filePath)
  }
}
export function fidelityConfigurationFile(userDataPath: string): string { return join(userDataPath, 'neglift-fidelity-configurations.json') }

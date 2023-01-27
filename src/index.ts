import { Context, Dict, Logger, Schema, Time } from 'koishi'
import type { AnalyzedPackage, MarketResult } from '@koishijs/registry'

const logger = new Logger('market')

export const name = 'market-info'

export interface Rule {
  platform: string
  channelId: string
  selfId?: string
  guildId?: string
}

export const Rule: Schema<Rule> = Schema.object({
  platform: Schema.string().description('平台名称。').required(),
  channelId: Schema.string().description('频道 ID。').required(),
  guildId: Schema.string().description('群组 ID。'),
  selfId: Schema.string().description('机器人 ID。'),
})

export interface Config {
  rules: Rule[]
  interval: number
  showHidden: boolean
  showDeletion: boolean
  showDescription: boolean
}

export const Config: Schema<Config> = Schema.object({
  rules: Schema.array(Rule).description('推送规则。'),
  interval: Schema.number().default(Time.minute * 30).description('轮询间隔 (毫秒)。'),
  showHidden: Schema.boolean().default(false).description('是否显示隐藏的插件。'),
  showDeletion: Schema.boolean().default(false).description('是否显示删除的插件。'),
  showDescription: Schema.boolean().default(false).description('是否显示插件描述。'),
})

export function apply(ctx: Context, config: Config) {
  ctx.i18n.define('zh', require('./locales/zh-CN'))

  const makeDict = (result: MarketResult) => {
    const dict: Dict<AnalyzedPackage> = {}
    for (const object of result.objects) {
      if (object.manifest.hidden && !config.showHidden) continue
      dict[object.shortname] = object
    }
    return dict
  }

  const getMarket = async () => {
    const data = await ctx.http.get<MarketResult>('https://registry.koishi.chat/market.json')
    return makeDict(data)
  }

  ctx.on('ready', async () => {
    let previous = await getMarket()

    ctx.command('market')
      .action(async ({ session }) => {
        return session.text('.overview', [Object.keys(previous).length])
      })

    ctx.setInterval(async () => {
      const current = await getMarket()
      const diff = Object.keys({ ...previous, ...current }).map((name) => {
        const version1 = previous[name]?.version
        const version2 = current[name]?.version
        if (version1 === version2) return

        if (!version1) {
          let output = `新增：${name}`
          const { description } = current[name].manifest
          if (config.showDescription) output += `\n  ${description.zh || description.en}`
          return output
        }

        if (version2) {
          return `更新：${name} (${version1} → ${version2})`
        }

        if (config.showDeletion) {
          return `删除：${name}`
        }
      }).filter(Boolean).sort()
      previous = current
      if (!diff.length) return

      const content = ['[插件市场更新]', ...diff].join('\n')
      logger.info(content)
      for (let { channelId, platform, selfId, guildId } of config.rules) {
        if (!selfId) {
          const channel = await ctx.database.getChannel(platform, channelId, ['assignee', 'guildId'])
          if (!channel || !channel.assignee) return
          selfId = channel.assignee
          guildId = channel.guildId
        }
        const bot = ctx.bots[`${platform}:${selfId}`]
        bot?.sendMessage(channelId, content, guildId)
      }
    }, config.interval)
  })
}

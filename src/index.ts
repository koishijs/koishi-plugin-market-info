import { Context, Dict, Logger, Schema, Time } from 'koishi'
import type { MarketPackage, MarketResult } from '@koishijs/registry'

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
}

export const Config: Schema<Config> = Schema.object({
  rules: Schema.array(Rule).description('推送规则。'),
  interval: Schema.number().default(Time.minute * 30).description('轮询间隔 (毫秒)。'),
})

function makeDict(result: MarketResult) {
  const dict: Dict<MarketPackage> = {}
  for (const object of result.objects) {
    dict[object.name] = object
  }
  return dict
}

export function apply(ctx: Context, config: Config) {
  const getMarket = async () => {
    const data = await ctx.http.get<MarketResult>('https://registry.koishi.chat/market.json')
    return makeDict(data)
  }

  ctx.on('ready', async () => {
    let previous = await getMarket()

    ctx.setInterval(async () => {
      const current = await getMarket()
      const diff = Object.keys({ ...previous, ...current }).map((name) => {
        const version1 = previous[name]?.version
        const version2 = current[name]?.version
        if (version1 === version2) return
        if (!version1) return '新增：' + name
        if (!version2) return '移除：' + name
        return `更新：${name} (${version1} → ${version2})`
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

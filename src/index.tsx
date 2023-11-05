import { Context, Dict, Logger, Schema, Time } from 'koishi'
import {} from '@koishijs/plugin-market'
import type { SearchObject, SearchResult } from '@koishijs/registry'

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
  endpoint: string
  interval: number
  showHidden: boolean
  showDeletion: boolean
  showPublisher: boolean
  showDescription: boolean
}

export const Config: Schema<Config> = Schema.object({
  rules: Schema.array(Rule).description('推送规则。'),
  endpoint: Schema.string().default('https://registry.koishi.chat/index.json').description('插件市场地址。'),
  interval: Schema.number().default(Time.minute * 30).description('轮询间隔 (毫秒)。'),
  showHidden: Schema.boolean().default(false).description('是否显示隐藏的插件。'),
  showDeletion: Schema.boolean().default(false).description('是否显示删除的插件。'),
  showPublisher: Schema.boolean().default(false).description('是否显示插件发布者。'),
  showDescription: Schema.boolean().default(false).description('是否显示插件描述。'),
})

export function apply(ctx: Context, config: Config) {
  ctx.i18n.define('zh', require('./locales/zh-CN'))

  const makeDict = (result: SearchResult) => {
    const dict: Dict<SearchObject> = {}
    for (const object of result.objects) {
      if (object.manifest.hidden && !config.showHidden) continue
      dict[object.shortname] = object
    }
    return dict
  }

  const getMarket = async () => {
    const data = await ctx.http.get<SearchResult>(config.endpoint)
    return makeDict(data)
  }

  ctx.on('ready', async () => {
    let previous = await getMarket()

    ctx.command('market [name]')
      .action(async ({ session }, name) => {
        if (!name) {
          const objects = Object.values(previous).filter(data => !data.manifest.hidden)
          return session.text('.overview', [objects.length])
        }

        const data = previous[name]
        if (!data) return session.text('.not-found', [name])
        return session.text('.detail', data)
      })

    ctx.setInterval(async () => {
      const current = await getMarket()
      const diff = Object.keys({ ...previous, ...current }).map((name) => {
        const version1 = previous[name]?.package.version
        const version2 = current[name]?.package.version
        if (version1 === version2) return

        if (!version1) {
          let output = <p><i18n path="market-info.created"></i18n></p>
          if (config.showPublisher) output += ` (@${current[name].package.publisher.username})`
          if (config.showDescription) {
            const { description } = current[name].manifest
            if (description && typeof description === 'object') {
              output += `\n  ${description.zh || description.en}`
            } else if (description && typeof description === 'string') {
              output += `\n  ${description}`
            }
          }
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

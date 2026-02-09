import { Context, Dict, Schema, Time, deepEqual, pick, sleep } from 'koishi'
import type { SearchObject, SearchResult } from '@koishijs/registry'

export const name = 'market-info'

interface Receiver {
  platform: string
  selfId: string
  channelId: string
  guildId?: string
}

const Receiver: Schema<Receiver> = Schema.object({
  platform: Schema.string().required().description('平台名称。'),
  selfId: Schema.string().required().description('机器人 ID。'),
  channelId: Schema.string().required().description('频道 ID。'),
  guildId: Schema.string().description('群组 ID。'),
})

export interface Config {
  rules: Receiver[]
  endpoint: string
  interval: number
  showHidden: boolean
  showDeletion: boolean
  showPublisher: boolean
  showDescription: boolean
}

export const Config: Schema<Config> = Schema.object({
  rules: Schema.array(Receiver).role('table').description('推送规则列表。'),
  endpoint: Schema.string().default('https://registry.koishi.chat/index.json').description('插件市场地址。'),
  interval: Schema.number().default(Time.minute * 30).description('轮询间隔 (毫秒)。'),
  showHidden: Schema.boolean().default(false).description('是否显示隐藏的插件。'),
  showDeletion: Schema.boolean().default(false).description('是否显示删除的插件。'),
  showPublisher: Schema.boolean().default(false).description('是否显示插件发布者。'),
  showDescription: Schema.boolean().default(false).description('是否显示插件描述。'),
})

export function apply(ctx: Context, config: Config) {
  ctx.i18n.define('zh', require('./locales/zh-CN'))

  const logger = ctx.logger('market')

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
      .option('receive', '-r', { authority: 3, value: true })
      .option('receive', '-R', { authority: 3, value: false })
      .action(async ({ session, options }, name) => {
        if (typeof options.receive === 'boolean') {
          const index = config.rules.findIndex(receiver => {
            return deepEqual(
              pick(receiver, ['platform', 'selfId', 'channelId', 'guildId']),
              pick(session, ['platform', 'selfId', 'channelId', 'guildId']),
            )
          })
          if (options.receive) {
            if (index >= 0) return session.text('.not-modified')
            const receiver: Receiver = {
              platform: session.platform,
              selfId: session.selfId,
              channelId: session.channelId!,
              guildId: session.guildId,
            }
            config.rules.push(receiver)
          } else {
            if (index < 0) return session.text('.not-modified')
            config.rules.splice(index, 1)
          }
          ctx.scope.update(config, false)
          return session.text('.updated')
        }
  
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
      const delay = ctx.root.config.delay.broadcast
      for (let index = 0; index < config.rules.length; ++index) {
        if (index && delay) await sleep(delay)
        const { platform, selfId, channelId, guildId } = config.rules[index]
        const bot = ctx.bots.find(bot => bot.platform === platform && bot.selfId === selfId)
        bot.sendMessage(channelId, content, guildId)
      }
    }, config.interval)
  })
}

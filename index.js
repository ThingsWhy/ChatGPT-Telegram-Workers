// / --  环境变量
// 推荐在Workers配置界面填写环境变量， 而不是直接修改这些变量
const ENV = {
  // OpenAI API Key
  API_KEY: null,
  // Telegram Bot Token
  TELEGRAM_TOKEN: null,
  // Available Telegram Bot Tokens
  TELEGRAM_AVAILABLE_TOKENS: [],
  // Workers Domain
  WORKERS_DOMAIN: null,
  // Disable white list
  I_AM_A_GENEROUS_PERSON: false,
  // Chat White List
  CHAT_WHITE_LIST: [],
  // Telegram Bot Username
  BOT_NAME: null,
  // Group Chat Bot Share History
  GROUP_CHAT_BOT_MODE: false,
  // Debug Mode
  DEBUG_MODE: false,
  // Max History Length
  MAX_HISTORY_LENGTH: 20,
};

// 最大token长度
const MAX_TOKEN_LENGTH = 4000;

// / --  KV数据库
// KV Namespace Bindings
let DATABASE = null;

// / --  数据库配置
// 用户配置
const USER_CONFIG = {
  // 系统初始化消息
  SYSTEM_INIT_MESSAGE: '你是一个得力的助手',
  // OpenAI API 额外参数
  OPENAI_API_EXTRA_PARAMS: {},
};

// / -- 共享上下文
// 当前聊天上下文
const CURRENR_CHAT_CONTEXT = {
  chat_id: null,
  parse_mode: 'Markdown',
};

// 共享上下文
const SHARE_CONTEXT = {
  currentBotId: null,
  chatHistoryKey: null, // history:user_id:bot_id:group_id
  configStoreKey: null, // user_config:user_id:bot_id
  groupAdminKey: null, // group_admin:group_id
};

// / --  初始化
// 初始化全局环境变量
function initGlobalEnv(env) {
  DATABASE = env.DATABASE;
  for (const key in ENV) {
    if (env[key]) {
      switch (typeof ENV[key]) {
        case 'number':
          ENV[key] = parseInt(env[key]) || ENV[key];
          break;
        case 'boolean':
          ENV[key] = (env[key] || 'false') === 'true';
          break;
        case 'object':
          if (Array.isArray(ENV[key])) {
            ENV[key] = env[key].split(',');
          } else {
            ENV[key] = env[key];
          }
          break;
        default:
          ENV[key] = env[key];
          break;
      }
    }
  }
}

// 初始化用户配置
async function initUserConfig(id) {
  try {
    const userConfig = await DATABASE.get(SHARE_CONTEXT.configStoreKey).then(
        (res) => JSON.parse(res) || {},
    );
    for (const key in userConfig) {
      if (
        USER_CONFIG.hasOwnProperty(key) &&
        typeof USER_CONFIG[key] === typeof userConfig[key]
      ) {
        USER_CONFIG[key] = userConfig[key];
      }
    }
  } catch (e) {
    console.error(e);
  }
}

// 初始化当前Telegram Token
async function initTelegramToken(token, request) {
  if (ENV.TELEGRAM_TOKEN && ENV.TELEGRAM_TOKEN === token) {
    return null;
  }
  if (ENV.TELEGRAM_AVAILABLE_TOKENS.includes(token)) {
    ENV.TELEGRAM_TOKEN = token;
    return null;
  }
  const {message} = await request.json();
  if (message?.chat?.id) {
    return sendMessageToTelegram(
        '你没有权限使用这个命令, 请请联系管理员添加你的Token到白名单',
        token,
        {chat_id: message.chat.id},
    );
  } else {
    return new Response(
        '你没有权限使用这个命令, 请请联系管理员添加你的Token到白名单',
        {status: 200},
    );
  }
}

// / --  Router
// 绑定Telegram回调
async function bindWebHookAction() {
  const result = [];
  const tokenSet = new Set();
  if (ENV.TELEGRAM_TOKEN) {
    tokenSet.add(ENV.TELEGRAM_TOKEN);
  }
  ENV.TELEGRAM_AVAILABLE_TOKENS.forEach((token) => tokenSet.add(token));
  for (const token of tokenSet) {
    const resp = await fetch(
        `https://api.telegram.org/bot${token}/setWebhook`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            url: `https://${ENV.WORKERS_DOMAIN}/telegram/${token}/webhook`,
          }),
        },
    ).then((res) => res.json());
    result.push(resp);
  }
  return new Response(JSON.stringify(result), {status: 200});
}

// 处理Telegram回调
async function telegramWebhookAction(request) {
  const {pathname} = new URL(request.url);
  const {message} = await request.json();

  // token 预处理
  const token = pathname.match(
      /^\/telegram\/(\d+:[A-Za-z0-9_-]{35})\/webhook/,
  )[1];
  const tokenError = await initTelegramToken(token, request);
  if (tokenError) {
    return tokenError;
  }
  if (ENV.TELEGRAM_AVAILABLE_TOKENS.length > 0) {
    // 如果有多个BOT，需要设置currentBotId
    SHARE_CONTEXT.currentBotId = token.split(':')[0];
  }

  // debug模式下记录最后一条消息
  if (ENV.DEBUG_MODE) {
    await DATABASE.put(
        `last_message:${message?.chat?.id}`,
        JSON.stringify(message),
    );
  }

  // 消息处理中间件
  const handlers = [
    msgInitChatContext, // 初始化聊天上下文: 生成chat_id, reply_to_message_id(群组消息), SHARE_CONTEXT
    msgCheckEnvIsReady, // 检查环境是否准备好: API_KEY, DATABASE
    msgFilterWhiteList, // 检查白名单
    msgHandleGroupMessage, // 处理群聊消息
    msgFilterNonTextMessage, // 过滤非文本消息
    msgHandleCommand, // 处理命令
    msgChatWithOpenAI, // 与OpenAI聊天
  ];
  for (const handler of handlers) {
    try {
      const result = await handler(message);
      if (result && result instanceof Response) {
        return result;
      }
    } catch (e) {
      console.error(e);
    }
  }

  return new Response('NOT HANDLED', {status: 200});
}

// / --  Command
// 命令绑定
const commandHandlers = {
  '/help': {
    help: '获取命令帮助',
    fn: commandGetHelp,
  },
  '/new': {
    help: '发起新的对话',
    fn: commandCreateNewChatContext,
  },
  '/start': {
    help: '获取你的ID，并发起新的对话',
    fn: commandCreateNewChatContext,
  },
  '/setenv': {
    help: '设置用户配置，命令完整格式为 /setenv KEY=VALUE',
    fn: commandUpdateUserConfig,
  },
};

// 命令帮助
async function commandGetHelp(message, command, subcommand) {
  const helpMsg =
    '当前支持以下命令:\n' +
    Object.keys(commandHandlers)
        .map((key) => `${key}：${commandHandlers[key].help}`)
        .join('\n');
  return sendMessageToTelegram(helpMsg);
}

// 新的会话
async function commandCreateNewChatContext(message, command, subcommand) {
  try {
    await DATABASE.delete(SHARE_CONTEXT.chatHistoryKey);
    if (command === '/new') {
      return sendMessageToTelegram('新的对话已经开始');
    } else {
      if (CURRENR_CHAT_CONTEXT.reply_to_message_id) {
        return sendMessageToTelegram(
            `新的对话已经开始，群组ID(${CURRENR_CHAT_CONTEXT.chat_id})，你的ID(${message.from.id})`,
        );
      } else {
        return sendMessageToTelegram(
            `新的对话已经开始，你的ID(${CURRENR_CHAT_CONTEXT.chat_id})`,
        );
      }
    }
  } catch (e) {
    return sendMessageToTelegram(`ERROR: ${e.message}`);
  }
}

// 用户配置修改
async function commandUpdateUserConfig(message, command, subcommand) {
  try {
    if (CURRENR_CHAT_CONTEXT.reply_to_message_id) {
      const chatRole = await getChatRole(message.from.id);
      if (chatRole === null) {
        return sendMessageToTelegram('身份权限验证失败');
      }
      if (chatRole !== 'administrator' && chatRole !== 'creator') {
        return sendMessageToTelegram('你不是管理员，无权操作');
      }
    }
  } catch (e) {
    return sendMessageToTelegram(`身份验证出错:` + JSON.stringify(e));
  }
  const kv = subcommand.indexOf('=');
  if (kv === -1) {
    return sendMessageToTelegram(
        '配置项格式错误: 命令完整格式为 /setenv KEY=VALUE',
    );
  }
  const key = subcommand.slice(0, kv);
  const value = subcommand.slice(kv + 1);
  try {
    switch (typeof USER_CONFIG[key]) {
      case 'number':
        USER_CONFIG[key] = Number(value);
        break;
      case 'boolean':
        USER_CONFIG[key] = value === 'true';
        break;
      case 'string':
        USER_CONFIG[key] = value;
        break;
      case 'object':
        const object = JSON.parse(value);
        if (typeof object === 'object') {
          USER_CONFIG[key] = object;
          break;
        }
        return sendMessageToTelegram('不支持的配置项或数据类型错误');
      default:
        return sendMessageToTelegram('不支持的配置项或数据类型错误');
    }
    await DATABASE.put(
        SHARE_CONTEXT.configStoreKey,
        JSON.stringify(USER_CONFIG),
    );
    return sendMessageToTelegram('更新配置成功');
  } catch (e) {
    return sendMessageToTelegram(`配置项格式错误: ${e.message}`);
  }
}

// / --  Handler
// 初始化聊天上下文
async function msgInitChatContext(message) {
  const id = message?.chat?.id;
  if (id === undefined || id === null) {
    return new Response('ID NOT FOUND', {status: 200});
  }

  let historyKey = `history:${id}`;
  let configStoreKey = `user_config:${id}`;

  await initUserConfig(id);
  CURRENR_CHAT_CONTEXT.chat_id = id;

  if (SHARE_CONTEXT.currentBotId) {
    historyKey += `:${SHARE_CONTEXT.currentBotId}`;
  }

  // 标记群组消息
  if (message.chat.type === 'group') {
    CURRENR_CHAT_CONTEXT.reply_to_message_id = message.message_id;
    if (!ENV.GROUP_CHAT_BOT_MODE && message.from.id) {
      historyKey += `:${message.from.id}`;
    }
    SHARE_CONTEXT.groupAdminKey = `group_admin:${id}`;
  }

  if (SHARE_CONTEXT.currentBotId) {
    configStoreKey += `:${SHARE_CONTEXT.currentBotId}`;
  }

  SHARE_CONTEXT.chatHistoryKey = historyKey;
  SHARE_CONTEXT.configStoreKey = configStoreKey;
  return null;
}

// 检查环境变量是否设置
async function msgCheckEnvIsReady(message) {
  if (!ENV.API_KEY) {
    return sendMessageToTelegram('OpenAI API Key 未设置');
  }
  if (!DATABASE) {
    return sendMessageToTelegram('DATABASE 未设置');
  }
  return null;
}

// 过滤非白名单用户
async function msgFilterWhiteList(message) {
  // 对群组消息放行
  if (CURRENR_CHAT_CONTEXT.reply_to_message_id) {
    return null;
  }
  if (ENV.I_AM_A_GENEROUS_PERSON) {
    return null;
  }
  if (!ENV.CHAT_WHITE_LIST.includes(`${CURRENR_CHAT_CONTEXT.chat_id}`)) {
    return sendMessageToTelegram(
        `你没有权限使用这个命令, 请请联系管理员添加你的ID(${CURRENR_CHAT_CONTEXT.chat_id})到白名单`,
    );
  }
  return null;
}

// 过滤非文本消息
async function msgFilterNonTextMessage(message) {
  if (!message.text) {
    return sendMessageToTelegram('暂不支持非文本格式消息');
  }
  return null;
}

// 处理群消息
async function msgHandleGroupMessage(message) {
  // 处理群组消息，过滤掉AT部分
  if (ENV.BOT_NAME && CURRENR_CHAT_CONTEXT.reply_to_message_id) {
    if (!message.text) {
      return new Response('NON TEXT MESSAGE', {status: 200});
    }
    let mentioned = false;
    if (message.entities) {
      let content = '';
      let offset = 0;
      message.entities.forEach((entity) => {
        switch (entity.type) {
          case 'bot_command':
            if (!mentioned) {
              const mention = message.text.substring(
                  entity.offset,
                  entity.offset + entity.length,
              );
              if (mention.endsWith(ENV.BOT_NAME)) {
                mentioned = true;
              }
              const cmd = mention
                  .replaceAll('@' + ENV.BOT_NAME, '')
                  .replaceAll(ENV.BOT_NAME)
                  .trim();
              content += cmd;
              offset = entity.offset + entity.length;
            }
            break;
          case 'mention':
          case 'text_mention':
            if (!mentioned) {
              const mention = message.text.substring(
                  entity.offset,
                  entity.offset + entity.length,
              );
              if (mention === ENV.BOT_NAME || mention === '@' + ENV.BOT_NAME) {
                mentioned = true;
              }
            }
            content += message.text.substring(offset, entity.offset);
            offset = entity.offset + entity.length;
            break;
        }
      });
      content += message.text.substring(offset, message.text.length);
      message.text = content.trim();
    }
    // 未AT机器人的消息不作处理
    if (!mentioned) {
      return new Response('NOT MENTIONED', {status: 200});
    }
  }
  return null;
}

// 响应命令消息
async function msgHandleCommand(message) {
  for (const key in commandHandlers) {
    if (message.text === key || message.text.startsWith(key + ' ')) {
      const command = commandHandlers[key];
      const subcommand = message.text.substr(key.length).trim();
      return await command.fn(message, key, subcommand);
    }
  }
  return null;
}

// 聊天
async function msgChatWithOpenAI(message) {
  try {
    sendChatActionToTelegram()
    const historyKey = SHARE_CONTEXT.chatHistoryKey;
    let history = [];
    try {
      history = await DATABASE.get(historyKey).then((res) => JSON.parse(res));
    } catch (e) {
      console.error(e);
    }
    if (!history || !Array.isArray(history) || history.length === 0) {
      history = [{role: 'system', content: USER_CONFIG.SYSTEM_INIT_MESSAGE}];
    }
    // 历史记录超出长度需要裁剪
    if (history.length>ENV.MAX_HISTORY_LENGTH){
      history.splice(history.length-ENV.MAX_HISTORY_LENGTH+2)
    }
    // 处理token长度问题
    let tokenLength = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      let historyItem = history[i]
      let length = getTokenLen(historyItem.content)
      // 如果最大长度超过maxToken,裁剪history
      tokenLength+=length
      if (tokenLength>MAX_TOKEN_LENGTH){
        history.splice(i)
        break
      }
    }
    const answer = await sendMessageToChatGPT(message.text, history);
    history.push({role: 'user', content: message.text});
    history.push({role: 'assistant', content: answer});
    await DATABASE.put(historyKey, JSON.stringify(history));
    return sendMessageToTelegram(answer, ENV.TELEGRAM_TOKEN);
  } catch (e) {
    return sendMessageToTelegram(`ERROR: ${e.message}`);
  }
}

// / --  API
// 发送消息到ChatGPT
async function sendMessageToChatGPT(message, history) {
  try {
    const body = {
      model: 'gpt-3.5-turbo',
      ...USER_CONFIG.OPENAI_API_EXTRA_PARAMS,
      messages: [...(history || []), {role: 'user', content: message}],
    };
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ENV.API_KEY}`,
      },
      body: JSON.stringify(body),
    }).then((res) => res.json());
    if (resp.error?.message) {
      return `OpenAI API 错误\n> ${resp.error.message}}`;
    }
    return resp.choices[0].message.content;
  } catch (e) {
    console.error(e);
    return `我不知道该怎么回答\n> ${e.message}}`;
  }
}

// 发送消息到Telegram
async function sendMessageToTelegram(message, token, context) {
  return await fetch(
      `https://api.telegram.org/bot${token || ENV.TELEGRAM_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...(context || CURRENR_CHAT_CONTEXT),
          text: message,
        }),
      },
  );
}

// 判断是否为群组管理员
async function getChatRole(id) {
  let groupAdmin;
  try {
    groupAdmin = await DATABASE.get(SHARE_CONTEXT.groupAdminKey).then((res) =>
      JSON.parse(res),
    );
  } catch (e) {
    console.error(e);
    return e.message;
  }
  if (!groupAdmin || !Array.isArray(groupAdmin) || groupAdmin.length === 0) {
    const administers = await getChatAdminister(CURRENR_CHAT_CONTEXT.chat_id);
    if (administers == null) {
      return null;
    }
    groupAdmin = administers;
    // 缓存30s
    await DATABASE.put(
        SHARE_CONTEXT.groupAdminKey,
        JSON.stringify(groupAdmin),
        {expiration: Date.now() + 30000},
    );
  }
  for (let i = 0; i < groupAdmin.length; i++) {
    const user = groupAdmin[i];
    if (user.user.id === id) {
      return user.status;
    }
  }
  return 'member';
}

// 获取群组管理员信息
async function getChatAdminister(chatId, token) {
  try {
    const resp = await fetch(
        `https://api.telegram.org/bot${
          token || ENV.TELEGRAM_TOKEN
        }/getChatAdministrators`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({chat_id: chatId}),
        },
    ).then((res) => res.json());
    if (resp.ok) {
      return resp.result;
    }
  } catch (e) {
    console.error(e);
    return null;
  }
}

// 发送聊天动作到TG
async function sendChatActionToTelegram(action, token){
  return await fetch(
    `https://api.telegram.org/bot${token || ENV.TELEGRAM_TOKEN}/sendChatAction`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
      chat_id:CURRENR_CHAT_CONTEXT.chat_id,
        action: action||'typing',
      }),
    },
  );
}

// 计算token长度，汉字=2，英文=0.5
function getTokenLen(str){
  let zhLen = 0;
  let re = /[\u4e00-\u9fa5]/;   // 正则判断是否为汉字
  for (let i = 0; i < str.length; i++) {
    if(re.test(str.charAt(i))){
      zhLen++;
    }
  }
  return zhLen+str.length;
}

// / --  Main
export default {
  async fetch(request, env) {
    try {
      initGlobalEnv(env);
      const {pathname} = new URL(request.url);
      if (pathname.startsWith(`/init`)) {
        return bindWebHookAction();
      }
      if (pathname.startsWith(`/telegram`) && pathname.endsWith(`/webhook`)) {
        return telegramWebhookAction(request);
      }
      return new Response('NOTFOUND: ' + pathname, {status: 404});
    } catch (e) {
      // 如果返回4xx，5xx，Telegram会重试这个消息，后续消息就不会到达，所有webhook的错误都返回200
      console.error(e);
      return new Response('ERROR:' + e.message, {status: 200});
    }
  },
};

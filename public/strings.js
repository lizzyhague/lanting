/*
 * Interface text in every supported language, keyed by a stable id. Each entry lists all languages side by side
 * so a missing translation is easy to spot. {name} placeholders are filled in by lantingI18n.t.
 */
window.lantingStrings = {
  "common.wordmark": { zh: "兰亭", en: "Lanting" },
  "common.settings": { zh: "设置", en: "Settings" },
  "common.close": { zh: "关闭", en: "Close" },
  "common.save": { zh: "保存", en: "Save" },
  "common.cancel": { zh: "取消", en: "Cancel" },
  "common.add": { zh: "添加", en: "Add" },
  "common.delete": { zh: "删除", en: "Delete" },
  "common.moveUp": { zh: "上移", en: "Move up" },
  "common.moveDown": { zh: "下移", en: "Move down" },

  "login.tokenLabel": { zh: "访问令牌", en: "Access token" },
  "login.tokenHint": { zh: "（登录状态存于浏览器）", en: " (sign-in is kept in this browser)" },
  "login.connect": { zh: "连接", en: "Connect" },
  "login.tokenMissing": { zh: "请输入访问令牌。", en: "Enter the access token." },
  "login.tokenInvalid": { zh: "访问令牌有误，请重新输入。", en: "The access token is incorrect. Try again." },
  "login.connecting": { zh: "正在连接主机……", en: "Connecting to the host…" },
  "login.noResponse": {
    zh: "没有收到服务器响应。请求可能未到达服务器，或者连接在服务器响应前中断。请检查网络或代理设置后重试。",
    en: "No response from the server. The request may not have reached it, or the connection dropped before it replied. Check your network or proxy settings and try again.",
  },
  "login.required": { zh: "请登录。", en: "Please sign in." },
  "login.unavailable": { zh: "登录服务暂时不可用。", en: "The sign-in service is temporarily unavailable." },

  "boot.starting": { zh: "页面正在启动……", en: "Starting…" },
  "boot.failed": {
    zh: "页面脚本未能启动，请刷新页面；如果仍然出现此提示，请更新浏览器。",
    en: "The page script failed to start. Refresh the page; if this message persists, update your browser.",
  },
  "boot.stillStarting": { zh: "页面仍在启动，请稍候……", en: "The page is still starting, please wait…" },

  "sidebar.label": { zh: "群列表", en: "Group list" },
  "sidebar.collapse": { zh: "收起群列表", en: "Collapse group list" },
  "sidebar.open": { zh: "打开群列表", en: "Open group list" },
  "sidebar.close": { zh: "关闭群列表", en: "Close group list" },
  "sidebar.search": { zh: "搜索群会话", en: "Search groups" },

  "create.directory": { zh: "工作目录", en: "Working directory" },
  "create.chooseDirectory": { zh: "选择工作目录", en: "Choose a working directory" },
  "create.newGroup": { zh: "新建群", en: "New group" },
  "create.members": { zh: "拉哪些 AI 进群", en: "AIs to add to the group" },

  "list.backToRecent": { zh: "返回最近群会话", en: "Back to recent groups" },
  "list.archived": { zh: "已归档", en: "Archived" },
  "list.trash": { zh: "回收站", en: "Trash" },
  "list.select": { zh: "选择", en: "Select" },
  "list.empty": { zh: "还没有群", en: "No groups yet" },

  "notice.dismiss": { zh: "关闭提示", en: "Dismiss notice" },
  "group.emptyHint": { zh: "从左侧选择一个群", en: "Select a group on the left" },

  "composer.label": { zh: "消息", en: "Message" },
  "composer.placeholder": { zh: "发给群里的消息", en: "Message the group" },
  "composer.more": { zh: "更多操作", en: "More actions" },
  "composer.callPicks": { zh: "点名", en: "Who replies" },
  "composer.sendHint": { zh: "电脑可按 Ctrl / ⌘ + Enter 发送", en: "On a computer, press Ctrl / ⌘ + Enter to send" },

  "settings.browserOnly": { zh: "只影响当前浏览器。", en: "Only affects this browser." },
  "settings.appearance": { zh: "外观", en: "Appearance" },
  "settings.themeSystem": { zh: "跟随系统", en: "Follow system" },
  "settings.themeLight": { zh: "浅色", en: "Light" },
  "settings.themeDark": { zh: "深色", en: "Dark" },
  "settings.language": { zh: "语言", en: "Language" },
  "settings.languageSystem": { zh: "跟随浏览器", en: "Follow browser" },
  "settings.username": { zh: "用户名", en: "Username" },
  "settings.usernameNote": {
    zh: "只影响以后新开的群。英文字母和数字，1～16 位，不能与任一 AI 名字相同（不区分大小写）。",
    en: "Only affects groups created from now on. English letters and digits, 1–16 characters, and not the same as any AI name (case-insensitive).",
  },
  "settings.collaboration": { zh: "群聊协作方式", en: "Collaboration rules" },
  "settings.collaborationInfo": { zh: "关于群聊协作方式的说明", en: "About collaboration rules" },
  "settings.collaborationInfo1": {
    zh: "这段内容由 lanting 后端保存，所有群共用这一份。",
    en: "This text is saved by the lanting backend, and all groups share this one copy.",
  },
  "settings.collaborationInfo2": {
    zh: "设置窗口打开时读取一次后端内容；要查看其他设备后来保存的内容，请关闭后重新打开。",
    en: "It is read from the backend once when the settings window opens; to see what another device saved later, close and reopen it.",
  },
  "settings.collaborationInfo3": {
    zh: "每个 AI 打开会话时，这段内容会接在 lanting 自带的群聊规则后面，作为系统提示词的一部分。",
    en: "When an AI opens a session, this text is appended after lanting's built-in group chat rules as part of the system prompt.",
  },
  "settings.collaborationInfo4": {
    zh: "lanting 会先加一个一级标题“User's collaboration rules”，再把内容原样放在下面，只去掉首尾空白。写普通文字就可以；要用 Markdown 分节时从 ## 开始。用 # 的话，这一节会和 lanting 自带规则的几节平级，AI 不一定能看出它也是你写的。",
    en: "lanting first adds a level-1 heading \"User's collaboration rules\", then places the text below it as-is, trimming only leading and trailing whitespace. Plain text is fine; to split it into Markdown sections, start from ##. With #, your sections sit at the same level as lanting's built-in ones, and the AI may not tell that you wrote them.",
  },
  "settings.collaborationInfo5": {
    zh: "已经开着的会话不受影响。之后什么时候带上新内容，分两种：Claude、Codex、Pi 在会话关闭后再次打开时带上；Grok、Cursor、Antigravity 只在新建会话时带上，已有群里的继续用旧内容。",
    en: "Sessions already open aren't affected. When the new text is picked up depends on the CLI: Claude, Codex and Pi pick it up when a session is reopened after closing; Grok, Cursor and Antigravity only when a new session is created, so existing groups keep the old text.",
  },
  "settings.collaborationInfo6": { zh: "留空时只使用 lanting 自带的规则。", en: "When left empty, only lanting's built-in rules are used." },
  "settings.collaborationPlaceholder": {
    zh: "输入希望群里的 AI 始终遵循的协作方式……",
    en: "Describe how you want the AIs in your groups to work together…",
  },
  "settings.collaborationNote": {
    zh: "所有群共用；在 AI 下次打开会话时生效。",
    en: "Shared by all groups; takes effect the next time each AI opens a session.",
  },
  "settings.agents": { zh: "AI 成员", en: "AI members" },
  "settings.agentActions": { zh: "AI 列表操作", en: "AI list actions" },
  "settings.addAgent": { zh: "添加 AI", en: "Add AI" },
  "settings.removeAgent": { zh: "删除选中的 AI", en: "Delete the selected AI" },
  "settings.moveAgentUp": { zh: "上移选中的 AI", en: "Move the selected AI up" },
  "settings.moveAgentDown": { zh: "下移选中的 AI", en: "Move the selected AI down" },
  "settings.kindNote": { zh: "切换 CLI 会清空这个 AI 的默认设置。", en: "Switching the CLI clears this AI's default settings." },
  "settings.identityNote": {
    zh: "群里的 AI 身份（名字、CLI、颜色）在建群时确定，之后修改设置不影响已有的群。",
    en: "An AI's identity in a group (name, CLI, color) is fixed when the group is created; later settings changes don't affect existing groups.",
  },

  "rename.title": { zh: "重命名", en: "Rename" },
  "rename.label": { zh: "群名", en: "Group name" },

  "viewer.loginLink": { zh: "登录后查看", en: "Sign in to view" },
};

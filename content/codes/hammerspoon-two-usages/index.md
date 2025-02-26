---
title: "macOS 上 Hammerspoon 应用两则"
date: 2025-02-26T14:16:03+08:00
isCJKLanguage: true
draft: false
tags: ["macOS", "hammerspoon", "lua", "IME"]
---

[Hammerspoon](https://www.hammerspoon.org/) 是一个 macOS 程序，它将 macOS 上的一些功能封装为 lua 接口，使用 lua 进行配置，以常驻后台的形式运行，可以监听特定事件，典型的比如实现一些快捷键功能。本文介绍两个我正在使用的 Hammerspoon 应用场景。

![Hammerspoon](asserts/hammerspoon.png#center)

### 场景一：锁定指定程序的输入法

在我对英语阅读和书写越发熟悉之后，我越来越乐意用纯英文环境来摆脱输入法切换的麻烦，至少在 terminal 和 vim 的环境中是这样的。在 linux 上我使用的工具是 [lilydjwg/fcitx.vim](https://github.com/lilydjwg/fcitx.vim)，但是在 macOS 下需要另找一个方法。

实际上存在不少类似于 fcitx.vim 的插件，它们的思路大致相同。这些插件虽然可以帮助我自动切换输入法，但是**一旦我意外的触发输入法切换，它们都无法自动将输入法拉回我期望的状态**。也许只是我对这些插件缺乏研究，但仍然有几项理由让我转到使用 hammerspoon 来解决：

- 一些插件需要安装额外的命令行工具来调用系统的输入法切换，这些命令行工具通常很细小，且看起来缺乏维护；
- 这些插件往往只是给 vim 编写的，我希望在 terminal 中也有同样的效果；
- 存在专门的 macOS 应用来锁定输入法，它们或专有，或收费，或缺乏维护，或功能无法精细定制；
- 关键的，它们通常监听程序窗口的聚焦来切换输入法，但是往往不监听“输入法发生了（意外的）切换”本身，使我无法定制自己想要的策略；

最重要的，hammerspoon 使用 lua 进行配置，可以实现灵活且精细的逻辑。如果你正在使用 neovim 和 wezterm，你一定知道我在说什么。下面是功能的代码实现。

#### 在窗口聚焦时切换到指定输入法

```lua
local function setupAppWatch()
  local appIme = {
    ["WezTerm"] = "com.apple.keylayout.ABC",
    ["Neovide"] = "com.apple.keylayout.ABC",
    ["neovide"] = "com.apple.keylayout.ABC",
  }
  hs.application.watcher
    .new(function(appName, eventType, appObject)
      if eventType == hs.application.watcher.activated then
        local expectedImeId = appIme[appName]
        if expectedImeId and hs.keycodes.currentSourceID() ~= expectedImeId then
          hs.keycodes.currentSourceID(expectedImeId)
        end
      end
    end)
    :start()
end
```

#### 意外切换输入法时将其自动纠正回来

```lua
local function setupImeWatch()
  local appIme = {
    ["WezTerm"] = "com.apple.keylayout.ABC",
    ["Neovide"] = "com.apple.keylayout.ABC",
    ["neovide"] = "com.apple.keylayout.ABC",
  }
  hs.keycodes.inputSourceChanged(function()
    local ok, appName = pcall(function()
      return hs.window.focusedWindow():application():name()
    end)
    if ok and appName then
      local expectedImeId = appIme[appName]
      if expectedImeId and hs.keycodes.currentSourceID() ~= expectedImeId then
        hs.keycodes.currentSourceID(expectedImeId)
      end
    end
  end)
end
```

#### 辅助功能：获取当前窗口的名称和当前输入法的名称

```lua
local function setupKeymap()
  hs.hotkey.bind({ "ctrl", "cmd" }, ".", function()
    local focusedApp = hs.window.focusedWindow():application()
    local appName = focusedApp:name()
    local appPath = focusedApp:path()
    local imeId = hs.keycodes.currentSourceID()
    hs.notify.show(appName, appPath, "IME: " .. imeId)
  end)
end
```

### 场景二：使用快捷键将当前窗口在多个显示器之间循环移动

使用外接显示器，或使用 iPad “随航”时，用鼠标或触摸板拖动窗口到指定显示器，拖拽的路线显得格外漫长。且光标和窗口在显示器之间的穿行带有几分惊险，因为屏幕之间的位移多少带有一些错位。

既然 hammerspoon 已经是我常驻的百宝箱之一，那么用它来解决这个问题就变得非常合适。下面是代码实现，这段代码是豆包 AI 给出的，目前为止我很满意它的效果：

```lua
local function moveWindowToNextScreen()
  local win = hs.window.focusedWindow()
  if not win then
    return
  end

  local screens = hs.screen.allScreens()
  if #screens < 2 then
    return
  end

  local currentScreen = win:screen()
  local currentIndex = 0
  for i, screen in ipairs(screens) do
    if screen == currentScreen then
      currentIndex = i
      break
    end
  end

  local nextIndex = currentIndex % #screens + 1
  local nextScreen = screens[nextIndex]

  win:moveToScreen(nextScreen)
end

hs.hotkey.bind({ "ctrl", "cmd" }, "n", moveWindowToNextScreen)
```

### 最后

完整的配置在我的 dotfile 仓库中：[chaneyzorn/dotfiles - hammerspoon](https://github.com/chaneyzorn/dotfiles/tree/master/hammerspoon/.hammerspoon)

更多用法，可以查看 hammperspoon 官网提供的接口文档。另外推荐一个可以参考更多用法的仓库：[wangshub/hammerspoon-config](https://github.com/wangshub/hammerspoon-config)

## 参考文档

- [Hammerspoon](https://www.hammerspoon.org/) 官网
- [Hammerspoon Docs](https://www.hammerspoon.org/docs/index.html) 官网文档
- [lilydjwg/fcitx.vim](https://github.com/lilydjwg/fcitx.vim)
- [chaneyzorn/dotfiles - hammerspoon](https://github.com/chaneyzorn/dotfiles/tree/master/hammerspoon/.hammerspoon)
- [wangshub/hammerspoon-config](https://github.com/wangshub/hammerspoon-config)

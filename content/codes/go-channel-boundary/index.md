---
title: "Go Channel 的边界行为"
date: 2026-07-26T10:50:39+08:00
isCJKLanguage: true
draft: false
tags: ["go", "concurrency", "channel"]
---

Go channel 的边界行为可以从三个状态、两种容量以及一组特殊操作来理解。三个状态是 `nil`、open 和 closed；两种容量是无缓冲和有缓冲。下面按生命周期、特殊行为和同步语义分层说明。

## 1. 概览

### 1.1 状态与分类

- `nil`：只声明、未通过 `make` 初始化。
- open：已经 `make`，可以正常通信。
- closed：已经调用 `close`，不再接受发送。

再结合容量，channel 可分为无缓冲和有缓冲两类。

### 1.2 核心行为矩阵

| 操作 | nil channel | open channel | closed channel |
|---|---|---|---|
| `ch <- v` | 永久阻塞 | 根据容量决定是否阻塞 | panic |
| `<-ch` | 永久阻塞 | 根据数据决定是否阻塞 | 缓冲区排空后立即返回零值 |
| `close(ch)` | panic | 成功 | panic |
| `len(ch)` | 0 | 缓冲元素数 | 尚未取出的缓冲元素数 |
| `cap(ch)` | 0 | 创建时容量 | 保持原容量 |
| `for range ch` | 永久阻塞 | 持续接收 | 排空后退出 |

## 2. 生命周期

### 2.1 初始化

```go
var nilCh chan int          // nil channel
unbuffered := make(chan int)
buffered := make(chan int, 3)
```

| 初始化方式 | 状态 | `len` | `cap` |
|---|---|---:|---:|
| `var ch chan T` | nil | 0 | 0 |
| `make(chan T)` | open、无缓冲 | 0 | 0 |
| `make(chan T, n)` | open、有缓冲 | 0 | n |

channel 的容量创建后不能改变。

```go
n := -1
ch := make(chan int, n) // runtime panic: makechan: size out of range
```

`len(ch)` 的语义只限于返回当前缓冲区中的元素个数，不代表 channel 的完整状态。例如：

- 对无缓冲 channel，`len(ch)` 恒为 0，但 send/receive 是否阻塞取决于是否有配对的接收/发送方正在等待，不能从 `len(ch)` 推断。
- 对有缓冲 channel，`len(ch)` 只是某一时刻的快照；检查它之后、执行 send/receive 之前，其他 goroutine 可能已经改变了 channel 状态。

因此不能用 `len(ch)` 来判断下一次 send 或 receive 是否会阻塞。

### 2.2 nil channel

```go
var ch chan int

ch <- 1   // 永久阻塞
v := <-ch // 永久阻塞
close(ch) // panic
```

nil channel 不等同于 closed channel：

- nil channel 永远无法完成通信。
- closed channel 的接收操作立即完成。

### 2.3 无缓冲 channel

```go
ch := make(chan int)
```

发送方和接收方必须会合：

```go
go func() {
    ch <- 42
}()

v := <-ch
```

`ch <- 42` 只有在另一个 goroutine 已经或即将执行接收时才能完成。反方向也一样：接收方会等待发送方。

如果在同一个 goroutine 中发送后才接收：

```go
ch := make(chan int)

ch <- 42
fmt.Println(<-ch)
```

发送操作无法完成，程序会出现：

```text
fatal error: all goroutines are asleep - deadlock!
```

正确写法需要另一个 goroutine，或使用缓冲区。

### 2.4 有缓冲 channel

```go
ch := make(chan int, 2)

ch <- 1 // 不阻塞
ch <- 2 // 不阻塞
ch <- 3 // 缓冲区已满，阻塞
```

发送在缓冲区满时阻塞；接收在缓冲区空时阻塞：

```go
fmt.Println(<-ch) // 取出 1，释放一个位置
```

可以将其理解为固定容量队列，但 channel 还包含同步和唤醒语义。

### 2.5 关闭 channel

关闭表示“之后不会再发送新值”：

```go
close(ch)
```

关闭不会清空缓冲区。接收方先获得剩余数据，然后持续获得元素类型的零值。

```go
ch := make(chan int, 2)
ch <- 10
ch <- 20
close(ch)

fmt.Println(<-ch) // 10
fmt.Println(<-ch) // 20
fmt.Println(<-ch) // 0
fmt.Println(<-ch) // 0
```

区分“发送了零值”和“channel 已排空并关闭”，可使用 comma-ok：

```go
v, ok := <-ch

if !ok {
    // channel 已关闭且缓冲区已排空
}
```

缓冲区还有数据时，即使 channel 已关闭，`ok` 仍为 `true`：

```go
ch := make(chan int, 1)
ch <- 0
close(ch)

v, ok := <-ch // 0, true：这是发送过的零值
v, ok = <-ch  // 0, false：关闭后的零值
```

## 3. 特殊行为

### 3.1 range 行为

```go
for v := range ch {
    fmt.Println(v)
}
```

等价于反复接收，直到 channel 已关闭且缓冲区排空：

```go
for {
    v, ok := <-ch
    if !ok {
        break
    }
    fmt.Println(v)
}
```

如果发送方从不关闭 channel，接收方会在取完最后一个值后继续等待：

```go
ch := make(chan int, 1)
ch <- 1

for v := range ch {
    fmt.Println(v)
}
// 取出 1 后阻塞，因为 ch 没有关闭
```

channel 不需要为了垃圾回收而关闭。只有接收方需要知道“不会再有数据”时才需要关闭。

### 3.2 多发送方与多接收方

一个值只会被一个接收者获得。下面的例子中，两个接收者竞争缓冲区里的一个值：

```go
ch := make(chan int, 1)
var wg sync.WaitGroup

wg.Go(func() {
    v, ok := <-ch
    fmt.Println("receiver 1:", v, ok)
})
wg.Go(func() {
    v, ok := <-ch
    fmt.Println("receiver 2:", v, ok)
})

ch <- 42
close(ch)
wg.Wait()
```

可能的输出：

```text
receiver 1: 42 true
receiver 2: 0 false
```

42 只被其中一个接收者拿到；另一个被 `close(ch)` 唤醒后得到零值。

关闭 channel 会唤醒所有阻塞的接收者：

```go
ch := make(chan int)
var wg sync.WaitGroup

for i := 0; i < 3; i++ {
    id := i
    wg.Go(func() {
        _, ok := <-ch
        fmt.Printf("receiver %d ok=%v\n", id, ok)
    })
}

// 等待接收者都阻塞在 <-ch 上（仅作示例，实际代码不要依赖 sleep）
time.Sleep(50 * time.Millisecond)
close(ch)
wg.Wait()
```

输出：

```text
receiver 0 ok=false
receiver 1 ok=false
receiver 2 ok=false
```

缓冲数据仍然只会分配给其中某一个接收者；排空后，所有接收者都能立即得到零值和 `ok=false`。

多个发送方同时发送时，接收顺序与 goroutine 的启动顺序无关，因为实际调度是随机的。因此不能依赖代码中的书写顺序来判断实际接收顺序：

```go
go func() { ch <- 1 }()
go func() { ch <- 2 }()
```

可能先收到 1，也可能先收到 2。

一般约定是：

> 创建和关闭 channel 的责任通常属于发送方；存在多个发送方时，应由一个协调者统一关闭。

不要让多个发送者自行判断并关闭：

```go
if shouldClose {
    close(ch) // 其他发送者可能仍在发送或也准备关闭
}
```

并发执行 `send` 与 `close` 没有安全保证，可能产生数据竞争或 `send on closed channel`。

### 3.3 select 的边界行为

`select` 同时监听多个 channel 操作，哪个 case 就绪就执行哪个。下面是一个典型结构：

```go
select {
case v := <-input:
    use(v)
case output <- result:
case <-ctx.Done():
}
```

本节讨论 `select` 在 nil channel、closed channel 等边界条件下的行为。

#### 3.3.1 nil channel case 会被禁用

```go
var ch chan int

select {
case <-ch:
    // 永远不会选中
default:
    // 执行这里
}
```

这可以用于动态启用或禁用 case：

```go
if !enabled {
    ch = nil
}
```

#### 3.3.2 closed channel 的接收 case 始终就绪

```go
close(ch)

select {
case v, ok := <-ch:
    // 立即执行，ok=false
default:
}
```

如果循环中的 select 没有处理 `ok`，closed channel 可能导致忙循环：

```go
for {
    select {
    case v := <-ch:
        process(v) // ch 关闭后不断处理零值
    default:
    }
}
```

处理方式之一是退出：

```go
case v, ok := <-ch:
    if !ok {
        return
    }
```

或者将它设为 nil，禁用这个 case：

```go
case v, ok := <-ch:
    if !ok {
        ch = nil
        continue
    }
```

#### 3.3.3 向 closed channel 发送的 case

```go
close(ch)

select {
case ch <- 1:
    // 如果该 case 被选中，会 panic
default:
}
```

`select` 不会替发送方安全地忽略 closed channel。必须通过所有权和同步保证发送时 channel 仍开放。

#### 3.3.4 多个 case 同时就绪

如果多个 case 同时可执行，Go 会选择其中一个，不能依赖固定优先级：

```go
select {
case <-a:
case <-b:
}
```

#### 3.3.5 所有 case 都不可执行

- 有 `default`：立即执行 `default`。
- 没有 `default`：当前 goroutine 阻塞。
- 空 `select {}`：永久阻塞。

### 3.4 关闭作为广播信号

```go
start := make(chan struct{})

go func() {
    <-start
    work()
}()

go func() {
    <-start
    work()
}()

close(start)
```

关闭 channel 后，所有 `<-start` 都立即完成，因此适合作为一次性广播信号。

如果只发送一次：

```go
start <- struct{}{}
```

对于无缓冲 channel，一次发送只会唤醒一个接收者。

`struct{}` 不携带实际数据，常用于纯信号 channel：

```go
chan struct{}
```

### 3.5 channel 方向

函数参数可以限制 channel 操作：

```go
func producer(out chan<- int) {
    out <- 1
    close(out) // send-only channel 可以关闭
}

func consumer(in <-chan int) {
    fmt.Println(<-in)
}
```

以下操作编译失败：

```go
func consumer(in <-chan int) {
    in <- 1   // 不能发送
    close(in) // 不能关闭 receive-only channel
}
```

方向限制主要用于表达所有权并防止误用。

### 3.6 会引发 panic 的操作

panic 不是 channel 正常生命周期的一部分，而是错误使用导致的运行时异常。下面列出三类常见场景。

#### 3.6.1 向 closed channel 发送

```go
close(ch)
ch <- 1 // panic: send on closed channel
```

#### 3.6.2 重复关闭

```go
close(ch)
close(ch) // panic: close of closed channel
```

#### 3.6.3 关闭 nil channel

```go
var ch chan int
close(ch) // panic: close of nil channel
```

这些是普通 runtime panic，可以通过 `recover` 捕获，但不应依赖 `recover` 管理 channel 生命周期。

与之相对，程序整体死锁会产生如下 fatal error：

```text
fatal error: all goroutines are asleep - deadlock!
```

它属于 runtime fatal error，不能用常规 `recover` 恢复。

## 4. 同步保证

channel 不只是数据队列，也建立 goroutine 之间的 happens-before 关系。

例如：

```go
var value int
done := make(chan struct{})

go func() {
    value = 42
    close(done)
}()

<-done
fmt.Println(value) // 能观察到 value = 42
```

关闭 `done` 发生在接收方观察到关闭之前，因此前面的写入对接收方可见。

因此 channel 常用于任务完成通知。多个 goroutine 同时访问其他共享变量时，仍需要确保所有访问都被 channel、锁或其他同步机制正确排序。

## 5. 参考

- [The Go Programming Language Specification](https://go.dev/ref/spec) — channel 类型、send/receive/close 的语义定义。
- [The Go Memory Model](https://go.dev/ref/mem) — channel 建立的 happens-before 关系。
- [Effective Go — Channels](https://go.dev/doc/effective_go#channels) — 官方推荐的 channel 使用模式。

## 6. 延伸阅读

- [Go Blog: Share Memory By Communicating](https://go.dev/blog/codelab-share) — channel 作为同步与通信工具的设计思路。
- [Go Blog: Go Concurrency Patterns: Pipelines and cancellation](https://go.dev/blog/pipelines) — 多发送方/接收方、关闭责任等工程实践。
- [Go Blog: Advanced Go Concurrency Patterns](https://go.dev/blog/advanced-go-concurrency-patterns) — `select`、nil channel 禁用 case 等模式。
- [`golang.org/x/sync/errgroup`](https://pkg.go.dev/golang.org/x/sync/errgroup) — 带错误收集和取消的 goroutine 组。
- [`github.com/sourcegraph/conc`](https://github.com/sourcegraph/conc) — 提供 `WaitGroup`、`Pool` 等结构化并发工具（Go 1.20+）。

---
title: "向指定 python 进程注入任意代码"
date: 2023-07-23T18:31:09+08:00
draft: true
tags: ["python", "programming"]
---

在工作中我遇到过几次 python 服务表现异常的情况，包括死锁、连接数过多、文件数过多、内存泄漏等问题。这个时候就想着，如果能够不用修改代码重启服务等待复现再观察，而是直接监视这个进程当前到底是在发什么疯就好了。

在一次调查过程中我使用了 [pystack](https://github.com/wooparadog/pystack) 来打印一个运行中进程的栈信息，但是遇到了一个问题：pystack 需要目标进程使用临时文件来传递打印的栈信息，可惜我调查的问题恰好是文件数过多，让目标进程再开一个临时文件是走不通了。这让我不得不尝试修改 pystack 的代码，让目标进程直接向 stdout 打印信息以避开使用临时文件。就是这个过程，让我了解到了 pystack 是如何实现打印目标进程栈信息的，而这个技巧可以进一步拓展以实现让目标进程执行任意 python 代码的效果，让文章开头的想法得以实现。

## pystack 的原理

pystack 的代码只有一百多行，原理如下：

1. 查找到 gdb 执行文件，并使用 gdb attach 到目标进程上；
2. 在 gdb 中调用 python 的 c 接口；
3. 使用 python 的 `PyRun_SimpleString` 运行 `exec()` 函数；
4. 在 `exec()` 函数中运行打印栈信息的函数；
5. 遍历 `sys._current_frames()` 并使用 `traceback.format_stack` 打印 python 栈信息；
6. 遍历 `gc.get_objects()` 查找 `greenlet.greenlet` 并使用 `traceback.format_stack` 打印 greenlet 栈信息；

在调用 `PyRun_SimpleString` 的前后，pystack 分别调用了 `PyRun_SimpleString` 和 `PyGILState_Release` 来获取 GIL，并设置好线程状态，这个技法正是 [python 官方文档中所描述的方法](https://docs.python.org/3/c-api/init.html#non-python-created-threads)：

```c
PyGILState_STATE gstate;
gstate = PyGILState_Ensure();

/* Perform Python actions here. */
result = CallSomeFunction();
/* evaluate result or handle exception */

/* Release the thread. No Python API allowed beyond this point. */
PyGILState_Release(gstate);
```

<https://stackoverflow.com/questions/2220699/whats-the-difference-between-eval-exec-and-compile>

<https://www.youtube.com/watch?v=xt9v5t4_zvE>

<https://github.com/facebookarchive/memory-analyzer>

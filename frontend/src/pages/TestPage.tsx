import { useEffect, useRef, useState } from "react"
import { Button } from "../components/ui/button"
import { Send, RefreshCw, Bot } from "lucide-react"
import { getAuthHeader } from "../lib/auth"
import { API_BASE } from "../lib/api"
import { toast } from "sonner"

type ModelOption = {
  value: string
  label: string
  group: string
}

const DEFAULT_QWEN_ALIAS_MAP: Record<string, string> = {
  "qwen": "qwen3.6-plus",
  "qwen-max": "qwen3.6-plus",
  "qwen-plus": "qwen3.6-plus",
  "qwen3.6plus": "qwen3.6-plus",
  "qwen-turbo": "qwen3.5-flash",
  "qwen-code": "qwen3-coder-plus",
  "qwen-code-plus": "qwen3-coder-plus",
  "qwen-coder": "qwen3-coder-plus",
  "qwen3-coder": "qwen3-coder-plus",
  "qwen3-coder-plus": "qwen3-coder-plus",
}

const DEFAULT_QWEN_DIRECT_MODELS = [
  "qwen3.6-plus",
  "qwen3.5-plus",
  "qwen3.5-omni-plus",
]

const QWEN_MODEL_PRIORITY = [
  "qwen3.6-plus",
  "qwen3.5-plus",
  "qwen3.5-omni-plus",
  "qwen3.5-flash",
  "qwen3-coder-plus",
  "qwen-max",
  "qwen-plus",
  "qwen-turbo",
  "qwen-code",
  "qwen-code-plus",
  "qwen-coder",
  "qwen3-coder",
  "qwen3.6plus",
  "qwen",
]

function isQwenLikeModel(name: string) {
  const normalized = name.trim().toLowerCase()
  return normalized.startsWith("qwen")
}

function sortModels(values: string[]) {
  const priority = new Map(QWEN_MODEL_PRIORITY.map((name, index) => [name, index]))
  return [...values].sort((left, right) => {
    const leftRank = priority.get(left) ?? Number.MAX_SAFE_INTEGER
    const rightRank = priority.get(right) ?? Number.MAX_SAFE_INTEGER
    if (leftRank !== rightRank) return leftRank - rightRank
    return left.localeCompare(right)
  })
}

function buildModelOptions(upstreamModels: string[], aliasMap: Record<string, string>): ModelOption[] {
  const directModels = new Set(
    [...DEFAULT_QWEN_DIRECT_MODELS, ...upstreamModels]
      .filter(isQwenLikeModel)
      .map(item => item.trim())
  )
  const aliasEntries = Object.entries(aliasMap)
    .filter(([alias, target]) => isQwenLikeModel(alias) || isQwenLikeModel(target))
    .map(([alias, target]) => [alias.trim(), target.trim()] as const)

  const targetModels = new Set(
    aliasEntries
      .map(([, target]) => target)
      .filter(isQwenLikeModel)
      .filter(target => !directModels.has(target))
  )

  const options: ModelOption[] = []

  for (const model of sortModels([...directModels])) {
    options.push({ value: model, label: model, group: "网页返回模型" })
  }

  for (const [alias, target] of aliasEntries.sort((left, right) => {
    const leftRank = QWEN_MODEL_PRIORITY.indexOf(left[0])
    const rightRank = QWEN_MODEL_PRIORITY.indexOf(right[0])
    if (leftRank !== rightRank) {
      return (leftRank === -1 ? Number.MAX_SAFE_INTEGER : leftRank) - (rightRank === -1 ? Number.MAX_SAFE_INTEGER : rightRank)
    }
    return left[0].localeCompare(right[0])
  })) {
    if (directModels.has(alias)) continue
    options.push({ value: alias, label: `${alias} -> ${target}`, group: "Qwen 兼容别名" })
  }

  for (const model of sortModels([...targetModels])) {
    options.push({ value: model, label: model, group: "更多 Qwen 目标模型" })
  }

  return options
}

// 渲染消息内容：自动把 Markdown 图片和图片 URL 渲染成 <img>
function MessageContent({ content }: { content: string }) {
  type Seg = { start: number; end: number; url: string }
  const segs: Seg[] = []
  const fullRe = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s"<>]+\.(?:jpg|jpeg|png|webp|gif)[^\s"<>]*)/gi
  let m: RegExpExecArray | null
  while ((m = fullRe.exec(content)) !== null) {
    segs.push({ start: m.index, end: m.index + m[0].length, url: (m[1] || m[2]) as string })
  }

  if (segs.length === 0) {
    return <div className="whitespace-pre-wrap leading-relaxed">{content}</div>
  }

  const nodes: JSX.Element[] = []
  let cursor = 0
  segs.forEach((seg, i) => {
    if (seg.start > cursor) {
      nodes.push(<span key={"t" + i}>{content.slice(cursor, seg.start)}</span>)
    }
    nodes.push(
      <div key={"i" + i} className="my-2">
        <img
          src={seg.url}
          alt="generated"
          className="max-w-full rounded-lg shadow-md border"
          loading="lazy"
          onError={e => { (e.currentTarget as HTMLImageElement).style.display = "none" }}
        />
        <div className="text-xs text-muted-foreground mt-1 break-all font-mono">{seg.url}</div>
      </div>
    )
    cursor = seg.end
  })
  if (cursor < content.length) {
    nodes.push(<span key="tail">{content.slice(cursor)}</span>)
  }
  return <div className="whitespace-pre-wrap leading-relaxed">{nodes}</div>
}

export default function TestPage() {
  const [messages, setMessages] = useState<{ role: string; content: string; error?: boolean }[]>([])
  const [input, setInput] = useState("")
  const [loading, setLoading] = useState(false)
  const [model, setModel] = useState("qwen3.6-plus")
  const [modelOptions, setModelOptions] = useState<ModelOption[]>(() => buildModelOptions([], DEFAULT_QWEN_ALIAS_MAP))
  const [modelSummary, setModelSummary] = useState("正在加载模型列表...")
  const [stream, setStream] = useState(true)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  const fetchModelOptions = async (silent = true) => {
    try {
      const [modelsRes, settingsRes] = await Promise.all([
        fetch(`${API_BASE}/v1/models`, { headers: getAuthHeader() }),
        fetch(`${API_BASE}/api/admin/settings`, { headers: getAuthHeader() }),
      ])

      let upstreamModels: string[] = []
      if (modelsRes.ok) {
        const modelsData = await modelsRes.json()
        upstreamModels = Array.isArray(modelsData?.data)
          ? modelsData.data
              .map((item: any) => String(item?.id || item?.model || item?.name || "").trim())
              .filter(Boolean)
          : []
      }

      let aliasMap = DEFAULT_QWEN_ALIAS_MAP
      if (settingsRes.ok) {
        const settingsData = await settingsRes.json()
        if (settingsData?.model_aliases && typeof settingsData.model_aliases === "object") {
          aliasMap = settingsData.model_aliases as Record<string, string>
        }
      }

      const nextOptions = buildModelOptions(upstreamModels, aliasMap)
      setModelOptions(nextOptions)
      setModel(current => nextOptions.some(item => item.value === current) ? current : (nextOptions[0]?.value || current))

      const qwenAliasCount = Object.entries(aliasMap).filter(([alias, target]) => isQwenLikeModel(alias) || isQwenLikeModel(String(target))).length
      const directCount = nextOptions.filter(item => item.group === "网页返回模型").length
      setModelSummary(`网页返回 ${directCount} 个模型，Qwen 兼容别名 ${qwenAliasCount} 个。`)

      if (!silent) {
        toast.success("模型列表已刷新")
      }
    } catch (err: any) {
      const fallback = buildModelOptions([], DEFAULT_QWEN_ALIAS_MAP)
      setModelOptions(fallback)
      setModelSummary("模型列表加载失败，已回退到内置 Qwen 模型选项。")
      if (!silent) {
        toast.error(`模型列表加载失败: ${err.message}`)
      }
    }
  }

  useEffect(() => {
    fetchModelOptions()
  }, [])

  const handleSend = async () => {
    if (!input.trim() || loading) return
    const userMsg = { role: "user", content: input }
    setMessages(prev => [...prev, userMsg])
    setInput("")
    setLoading(true)

    try {
      if (!stream) {
        const res = await fetch(`${API_BASE}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...getAuthHeader() },
          body: JSON.stringify({ model, messages: [...messages, userMsg], stream: false })
        })
        const data = await res.json()
        if (data.error) {
          setMessages(prev => [...prev, { role: "assistant", content: `❌ ${data.error}`, error: true }])
        } else if (data.choices?.[0]) {
          setMessages(prev => [...prev, data.choices[0].message])
        } else {
          setMessages(prev => [...prev, { role: "assistant", content: `❌ 未知响应: ${JSON.stringify(data)}`, error: true }])
        }
      } else {
        const res = await fetch(`${API_BASE}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...getAuthHeader() },
          body: JSON.stringify({ model, messages: [...messages, userMsg], stream: true })
        })

        if (!res.ok) {
          const errText = await res.text()
          setMessages(prev => [...prev, { role: "assistant", content: `❌ HTTP ${res.status}: ${errText}`, error: true }])
          return
        }

        if (!res.body) throw new Error("No response body")

        setMessages(prev => [...prev, { role: "assistant", content: "" }])
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let hasContent = false

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          const chunk = decoder.decode(value, { stream: true })
          for (const rawLine of chunk.split("\n")) {
            const line = rawLine.trim()
            if (!line || line.startsWith(":") || line === "data: [DONE]") continue
            if (line.startsWith("data: ")) {
              try {
                const data = JSON.parse(line.slice(6))
                if (data.error) {
                  setMessages(prev => {
                    const msgs = [...prev]
                    msgs[msgs.length - 1] = { role: "assistant", content: `❌ ${data.error}`, error: true }
                    return msgs
                  })
                  hasContent = true
                  break
                }
                const content: string = data.choices?.[0]?.delta?.content ?? ""
                if (content) {
                  hasContent = true
                  setMessages(prev => {
                    const msgs = [...prev]
                    const last = msgs[msgs.length - 1]
                    msgs[msgs.length - 1] = { ...last, content: last.content + content }
                    return msgs
                  })
                }
              } catch (_) { /* skip */ }
            }
          }
        }

        if (!hasContent) {
          setMessages(prev => {
            const msgs = [...prev]
            msgs[msgs.length - 1] = { role: "assistant", content: "❌ 响应为空（账号可能未激活或无可用账号）", error: true }
            return msgs
          })
        }
      }
    } catch (err: any) {
      toast.error(`网络错误: ${err.message}`)
      setMessages(prev => [...prev, { role: "assistant", content: `❌ 网络错误: ${err.message}`, error: true }])
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col h-[calc(100vh-10rem)] space-y-4 max-w-5xl mx-auto">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">接口测试</h2>
          <p className="text-muted-foreground">在此测试您的 API 分发是否正常工作。</p>
        </div>
        <div className="flex gap-4 items-center">
          <div className="flex flex-col gap-1 text-sm bg-card border px-3 py-2 rounded-md min-w-[20rem]">
            <div className="flex items-center gap-2">
              <span className="font-medium text-muted-foreground">模型:</span>
              <select value={model} onChange={e => setModel(e.target.value)} className="bg-transparent font-mono outline-none min-w-[16rem]">
                {["网页返回模型", "Qwen 兼容别名", "更多 Qwen 目标模型"].map(group => {
                  const options = modelOptions.filter(item => item.group === group)
                  if (options.length === 0) return null
                  return (
                    <optgroup key={group} label={group}>
                      {options.map(option => (
                        <option key={`${group}:${option.value}`} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </optgroup>
                  )
                })}
              </select>
              <Button variant="ghost" size="sm" onClick={() => fetchModelOptions(false)}>
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
            <span className="text-xs text-muted-foreground">{modelSummary}</span>
          </div>
          <div
            className="flex items-center gap-2 text-sm bg-card border px-3 py-1.5 rounded-md cursor-pointer"
            onClick={() => setStream(!stream)}
          >
            <input type="checkbox" checked={stream} onChange={() => {}} className="cursor-pointer" />
            <span className="font-medium">流式传输 (Stream)</span>
          </div>
          <Button variant="outline" onClick={() => setMessages([])}>
            <RefreshCw className="mr-2 h-4 w-4" /> 清空对话
          </Button>
        </div>
      </div>

      <div className="flex-1 rounded-xl border bg-card overflow-hidden flex flex-col shadow-sm">
        <div className="flex-1 overflow-y-auto p-6 space-y-6 flex flex-col">
          {messages.length === 0 && (
            <div className="h-full flex flex-col items-center justify-center text-muted-foreground space-y-4">
              <Bot className="h-12 w-12 text-muted-foreground/30" />
              <p className="text-sm">发送一条消息以开始测试，系统将通过 /v1/chat/completions 进行调用。</p>
            </div>
          )}
          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[80%] rounded-xl px-4 py-3 text-sm shadow-sm
                ${msg.role === "user"
                  ? "bg-primary text-primary-foreground"
                  : msg.error
                    ? "bg-red-500/10 border border-red-500/30 text-red-400"
                    : "bg-muted/30 border text-foreground"}`}>
                {msg.role === "assistant" && !msg.content && loading ? (
                  <span className="animate-pulse flex items-center gap-2 text-muted-foreground">
                    <Bot className="h-4 w-4" /> 思考中...
                  </span>
                ) : msg.role === "assistant" && !msg.error ? (
                  <MessageContent content={msg.content} />
                ) : (
                  <div className="whitespace-pre-wrap leading-relaxed">{msg.content}</div>
                )}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        <div className="p-4 border-t bg-muted/30 flex gap-3 items-center">
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleSend()}
            className="flex h-12 w-full rounded-md border border-input bg-background px-4 py-2 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            placeholder="输入测试消息..."
            disabled={loading}
          />
          <Button onClick={handleSend} disabled={loading || !input.trim()} className="h-12 px-6">
            {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </div>
  )
}

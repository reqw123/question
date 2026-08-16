import { useCallback, useEffect, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { Eye, EyeOff, MousePointer2, RefreshCw, Wand2 } from 'lucide-react'
import { cn } from '../../../lib/utils'
import {
  getPetStatus,
  hidePet,
  resetPetPosition,
  showPet,
  toggleInteractive,
  triggerRandomMotion,
  type PetStatus,
} from '../../../lib/petControl'

const POLL_INTERVAL_MS = 4000

type Connection = 'checking' | 'online' | 'offline'

function useLivePetStatus() {
  const [connection, setConnection] = useState<Connection>('checking')
  const [status, setStatus] = useState<PetStatus | null>(null)

  const refresh = useCallback(async () => {
    const next = await getPetStatus()
    setStatus(next)
    setConnection(next ? 'online' : 'offline')
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [refresh])

  return { connection, status, refresh }
}

// 互動模式安全網倒數：桌寵視窗會蓋滿整個螢幕、吃掉滑鼠事件，切成互動模式後若沒人
// 手動再切一次，桌寵那邊會在逾時後自動跳回穿透模式（見 desktop-pet/main.js 的
// toggleInteractiveFromWeb）。這裡每 500ms 在本地重算一次剩餘秒數，純粹是為了讓使用者
// 看得到倒數在跑，不需要因此加快輪詢頻率去問伺服器。
function useCountdown(deadline: number | null) {
  const [remainingMs, setRemainingMs] = useState<number | null>(null)

  useEffect(() => {
    if (deadline == null) {
      setRemainingMs(null)
      return
    }
    const tick = () => setRemainingMs(Math.max(0, deadline - Date.now()))
    tick()
    const id = setInterval(tick, 500)
    return () => clearInterval(id)
  }, [deadline])

  return remainingMs
}

type ActionButtonProps = {
  label: string
  icon: typeof Eye
  onClick: () => Promise<void>
  disabled: boolean
}

function ActionButton({ label, icon: Icon, onClick, disabled }: ActionButtonProps) {
  const [pending, setPending] = useState(false)

  return (
    <button
      type="button"
      disabled={disabled || pending}
      onClick={async () => {
        setPending(true)
        try {
          await onClick()
        } finally {
          setPending(false)
        }
      }}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg border border-stone-300 px-4 py-3',
        'text-sm font-semibold text-stone-900 transition-colors hover:bg-stone-100',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent',
        'dark:border-stone-700 dark:text-white dark:hover:bg-stone-900',
      )}
    >
      <Icon className="size-4" aria-hidden="true" />
      {pending ? '執行中…' : label}
    </button>
  )
}

export function ControlPanel() {
  const reduceMotion = useReducedMotion()
  const { connection, status, refresh } = useLivePetStatus()
  const revertRemainingMs = useCountdown(status?.interactiveAutoRevertAt ?? null)

  const withRefresh = (action: () => Promise<PetStatus | null>) => async () => {
    await action()
    await refresh()
  }

  return (
    <section id="control-panel" aria-labelledby="control-panel-heading" className="mx-auto max-w-3xl px-4 py-16">
      <div
        className={cn(
          'rounded-2xl border border-violet-200/60 bg-white p-6 sm:p-8',
          'dark:border-violet-900/40 dark:bg-stone-900',
        )}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="control-panel-heading" className="text-xl font-bold text-stone-900 dark:text-white">
            本機控制面板
          </h2>

          <p aria-live="polite" className="flex items-center gap-2 text-sm text-stone-500 dark:text-stone-400">
            <motion.span
              aria-hidden="true"
              className={cn(
                'size-2 rounded-full',
                connection === 'online' && 'bg-emerald-500',
                connection === 'offline' && 'bg-stone-400',
                connection === 'checking' && 'bg-amber-400',
              )}
              animate={connection === 'online' && !reduceMotion ? { opacity: [1, 0.4, 1] } : undefined}
              transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
            />
            {connection === 'online' && '桌寵連線中'}
            {connection === 'offline' && '尚未偵測到桌寵'}
            {connection === 'checking' && '偵測中…'}
          </p>
        </div>

        {connection === 'offline' && (
          <p className="mt-4 rounded-lg bg-stone-50 px-4 py-3 text-sm text-stone-600 dark:bg-stone-800 dark:text-stone-400">
            請先在本機的 <code className="rounded bg-stone-200 px-1 py-0.5 dark:bg-stone-700">desktop-pet/</code>{' '}
            資料夾執行 <code className="rounded bg-stone-200 px-1 py-0.5 dark:bg-stone-700">npm start</code>
            ，這個面板才能遙控牠——控制伺服器只接受同一台電腦的連線。
          </p>
        )}

        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <ActionButton
            label={status?.visible ? '讓牠躲起來' : '讓牠出現'}
            icon={status?.visible ? EyeOff : Eye}
            disabled={connection !== 'online'}
            onClick={withRefresh(status?.visible ? hidePet : showPet)}
          />
          <ActionButton
            label={status?.clickThrough ? '切成互動模式' : '切成穿透模式'}
            icon={MousePointer2}
            disabled={connection !== 'online'}
            onClick={withRefresh(toggleInteractive)}
          />
          <ActionButton
            label="隨機動作"
            icon={Wand2}
            disabled={connection !== 'online'}
            onClick={withRefresh(triggerRandomMotion)}
          />
          <ActionButton
            label="還原位置"
            icon={RefreshCw}
            disabled={connection !== 'online'}
            onClick={withRefresh(resetPetPosition)}
          />
        </div>

        {revertRemainingMs != null && (
          <p aria-live="polite" className="mt-4 text-sm text-violet-700 dark:text-violet-400">
            互動模式中——桌寵會蓋住整個螢幕、按鈕可能點不到，
            {Math.ceil(revertRemainingMs / 1000)} 秒後會自動切回穿透模式（也可以直接按 F9）。
          </p>
        )}
      </div>
    </section>
  )
}

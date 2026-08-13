import type { MouseEvent } from 'react'
import { motion, useMotionValue, useReducedMotion, useTransform } from 'motion/react'
import { MessageCircle, MousePointer2, Move, RefreshCw, Users, Wand2 } from 'lucide-react'
import { cn } from '../../../lib/utils'

type Feature = {
  title: string
  description: string
  icon: typeof MousePointer2
}

const features: Feature[] = [
  {
    title: '點擊穿透 / 互動模式',
    description: '預設安靜待在角落、滑鼠事件直接穿透，按 F9 隨時切成可拖曳、可點按鈕的互動模式。',
    icon: MousePointer2,
  },
  {
    title: '角色收藏庫',
    description: '系統匣選單直接挑角色一、角色二，套用後立即換裝，不用改設定檔。',
    icon: Users,
  },
  {
    title: '閒置動作＋語音閒聊',
    description: '不用點擊，牠會自動輪流做動作、切換表情，偶爾冒出對話泡泡和小聲音效。',
    icon: MessageCircle,
  },
  {
    title: '一鍵動作測試',
    description: '系統匣選單就能手動觸發角色的內建動作，不用打開開發者工具慢慢測。',
    icon: Wand2,
  },
  {
    title: '對角線交叉飛行',
    description: '想看牠耍寶就開特技模式，角色會在畫面上來回飛行，再點一次收工。',
    icon: Move,
  },
  {
    title: '一鍵清除快取重開',
    description: '角色動作偶爾卡住時，系統匣選單一鍵清乾淨本機狀態再重開，不用自己找資料夾。',
    icon: RefreshCw,
  },
]

// **2026-08-11 加上 3D 傾斜 hover**：跟 FeatureSpotlight.tsx 同一套手法（滑鼠位置算
// rotateX/rotateY），六宮格這邊角度故意收小（±6deg，Spotlight 那邊是 ±12deg）——小卡片
// 本來面積就小，角度太大滑鼠稍微移動就會轉一大圈，反而顯得抖動廉價，不是「精緻」。
// 拆成獨立元件是因為 hook（useMotionValue/useTransform）不能在 .map() 迴圈裡直接呼叫，
// 每張卡片需要各自獨立的一組傾斜狀態，不能共用父層的一組。
function FeatureCard({ feature, index }: { feature: Feature; index: number }) {
  const reduceMotion = useReducedMotion()
  const x = useMotionValue(0)
  const y = useMotionValue(0)
  const rotateX = useTransform(y, [-60, 60], [6, -6])
  const rotateY = useTransform(x, [-100, 100], [-6, 6])

  function handleMouseMove(e: MouseEvent<HTMLLIElement>) {
    if (reduceMotion) return
    const rect = e.currentTarget.getBoundingClientRect()
    x.set(e.clientX - rect.left - rect.width / 2)
    y.set(e.clientY - rect.top - rect.height / 2)
  }

  function handleMouseLeave() {
    x.set(0)
    y.set(0)
  }

  return (
    <motion.li
      className={cn(
        'group relative overflow-hidden rounded-2xl border border-stone-200 bg-white p-6',
        'transition-colors hover:border-violet-300',
        'dark:border-stone-800 dark:bg-stone-900 dark:hover:border-violet-700',
      )}
      style={{ perspective: 800 }}
      initial={reduceMotion ? undefined : { opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-80px' }}
      transition={{ duration: 0.4, delay: reduceMotion ? 0 : index * 0.06 }}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      <motion.div
        style={reduceMotion ? undefined : { rotateX, rotateY, transformStyle: 'preserve-3d' }}
        transition={{ type: 'spring', stiffness: 220, damping: 18 }}
      >
        <div
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute -top-10 -right-10 size-32 rounded-full bg-violet-200/40 blur-2xl',
            'opacity-0 transition-opacity duration-300 group-hover:opacity-100',
            'dark:bg-violet-700/20',
          )}
        />
        <span className="relative inline-flex size-11 items-center justify-center rounded-xl bg-violet-50 text-violet-600 dark:bg-violet-950 dark:text-violet-400">
          <feature.icon className="size-5" aria-hidden="true" />
        </span>
        <h3 className="relative mt-4 text-base font-semibold text-stone-900 dark:text-white">
          {feature.title}
        </h3>
        <p className="relative mt-2 text-sm text-stone-500 dark:text-stone-400">{feature.description}</p>
      </motion.div>
    </motion.li>
  )
}

export function Features() {
  return (
    <section id="features" aria-labelledby="features-heading" className="mx-auto max-w-6xl px-4 py-16">
      <div className="mx-auto max-w-xl text-center">
        <h2
          id="features-heading"
          className="text-3xl font-bold tracking-tight text-stone-900 md:text-4xl dark:text-white"
        >
          牠能陪你做這些事
        </h2>
        <p className="mt-3 text-stone-500 dark:text-stone-400">
          小巧但功能齊全，都是實際做出來、測過的功能，不是畫大餅。
        </p>
      </div>

      <ul className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {features.map((feature, index) => (
          <FeatureCard key={feature.title} feature={feature} index={index} />
        ))}
      </ul>
    </section>
  )
}

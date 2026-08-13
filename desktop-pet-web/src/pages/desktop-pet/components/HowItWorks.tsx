import { motion, useReducedMotion } from 'motion/react'
import { Download, PlayCircle, ToggleLeft, Wand2 } from 'lucide-react'
import { cn } from '../../../lib/utils'

type Step = {
  title: string
  description: string
  icon: typeof Download
}

const steps: Step[] = [
  {
    title: '安裝依賴',
    description: '在專案資料夾跑一次 npm install，把需要的套件裝好。',
    icon: Download,
  },
  {
    title: '啟動桌寵',
    description: '執行 npm start，牠就會出現在桌面上，預設是點擊穿透、安靜待著。',
    icon: PlayCircle,
  },
  {
    title: '切換互動模式',
    description: '按 F9 切成互動模式，就能拖曳角色、點左下角按鈕；F8 可以隨時還原位置。',
    icon: ToggleLeft,
  },
  {
    title: '客製化玩法',
    description: '系統匣右鍵選單能換角色、手動觸發動作、開對角線飛行特技。',
    icon: Wand2,
  },
]

export function HowItWorks() {
  const reduceMotion = useReducedMotion()

  return (
    <section id="how-it-works" aria-labelledby="how-it-works-heading" className="mx-auto max-w-6xl px-4 py-16">
      <div className="mx-auto max-w-xl text-center">
        <h2
          id="how-it-works-heading"
          className="text-3xl font-bold tracking-tight text-stone-900 md:text-4xl dark:text-white"
        >
          四步驟讓桌寵陪著你
        </h2>
        <p className="mt-3 text-stone-500 dark:text-stone-400">從安裝到玩出花樣，都是滑鼠加幾個快捷鍵就能搞定。</p>
      </div>

      <ol className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {steps.map((step, index) => (
          <motion.li
            key={step.title}
            className={cn(
              'relative flex flex-col items-start rounded-2xl border border-stone-200 bg-white p-6',
              'dark:border-stone-800 dark:bg-stone-900',
            )}
            initial={reduceMotion ? undefined : { opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.4, delay: reduceMotion ? 0 : index * 0.08 }}
          >
            <span className="text-xs font-semibold text-violet-700 dark:text-violet-400">STEP {index + 1}</span>
            <span className="mt-3 inline-flex size-11 items-center justify-center rounded-xl bg-violet-50 text-violet-600 dark:bg-violet-950 dark:text-violet-400">
              <step.icon className="size-5" aria-hidden="true" />
            </span>
            <h3 className="mt-4 text-base font-semibold text-stone-900 dark:text-white">{step.title}</h3>
            <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">{step.description}</p>
          </motion.li>
        ))}
      </ol>
    </section>
  )
}

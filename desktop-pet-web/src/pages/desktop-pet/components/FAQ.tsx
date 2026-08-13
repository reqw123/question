import { useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { ChevronDown } from 'lucide-react'
import { cn } from '../../../lib/utils'

type FaqItem = {
  question: string
  answer: string
}

const faqs: FaqItem[] = [
  {
    question: '為什麼點不到我的桌寵？',
    answer:
      '預設是「點擊穿透」模式，滑鼠事件會直接穿透到桌面，這是正常現象。先按 F9 切換成互動模式，就能拖曳角色、點左下角按鈕了。',
  },
  {
    question: '角色動作忽然沒反應怎麼辦？',
    answer:
      '系統匣選單裡有「清除本機快取並重開」，一鍵清掉卡住的本機狀態再重啟，可以解決大部分動作測試失靈的問題。',
  },
  {
    question: '可以換成別的角色嗎？',
    answer:
      '可以，系統匣右鍵選單裡的「角色一」「角色二」能從收藏庫挑選，選好後記得點「確定套用」才會真的換裝。',
  },
  {
    question: '會很吃電腦資源嗎？',
    answer:
      '這是還在持續調整的個人原型，以 Electron 為基礎，效能仍在優化中，建議在效能較充裕的機器上使用。',
  },
  {
    question: '支援 Mac / Linux 嗎？',
    answer: '目前主要以 Windows 環境開發與測試，其他平台還沒有完整驗證過。',
  },
]

function FaqRow({
  item,
  index,
  isOpen,
  onToggle,
}: {
  item: FaqItem
  index: number
  isOpen: boolean
  onToggle: () => void
}) {
  const reduceMotion = useReducedMotion()
  const panelId = `faq-panel-${index}`

  return (
    <div className="border-b border-stone-200 py-4 dark:border-stone-800">
      <h3>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={isOpen}
          aria-controls={panelId}
          className={cn(
            'flex w-full items-center justify-between gap-4 text-left text-sm font-semibold text-stone-900 dark:text-white',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 rounded-md',
          )}
        >
          {item.question}
          <ChevronDown
            className={cn('size-4 shrink-0 text-stone-400 transition-transform', isOpen && 'rotate-180')}
            aria-hidden="true"
          />
        </button>
      </h3>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            id={panelId}
            role="region"
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.2 }}
            className="overflow-hidden"
          >
            <p className="pt-3 text-sm text-stone-500 dark:text-stone-400">{item.answer}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export function FAQ() {
  const [openIndex, setOpenIndex] = useState<number | null>(0)

  return (
    <section aria-labelledby="faq-heading" className="mx-auto max-w-3xl px-4 py-16">
      <div className="mx-auto max-w-xl text-center">
        <h2 id="faq-heading" className="text-3xl font-bold tracking-tight text-stone-900 md:text-4xl dark:text-white">
          常見問題
        </h2>
        <p className="mt-3 text-stone-500 dark:text-stone-400">還有其他問題？歡迎透過下方表單與我們聯絡。</p>
      </div>

      <div className="mt-10">
        {faqs.map((item, index) => (
          <FaqRow
            key={item.question}
            item={item}
            index={index}
            isOpen={openIndex === index}
            onToggle={() => setOpenIndex((current) => (current === index ? null : index))}
          />
        ))}
      </div>
    </section>
  )
}

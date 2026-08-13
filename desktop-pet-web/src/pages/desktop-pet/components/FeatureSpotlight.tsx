import { useId, type MouseEvent, type ReactNode, type Ref } from 'react'
import { motion, useMotionValue, useReducedMotion, useTransform } from 'motion/react'
import { ArrowRight, type LucideIcon } from 'lucide-react'
import { cn } from '../../../lib/utils'

// 從 21st.dev 找的「Animated Feature Spotlight 3D」改寫進來（原版：
// https://21st.dev/@ruixen.ui/components/animated-feature-spotlight3d）。原版是
// shadcn/ui 元件，用 framer-motion（這裡改用專案本來就有的 motion/react，同一套 API，
// 只是套件名稱不同）、shadcn 的 CSS 變數主題（bg-background/text-foreground）跟
// @radix-ui/react-slot 做的 <Button>——這幾個依賴這個專案都沒有，改成專案既有的
// Tailwind 色票（stone/violet/pink，跟 Hero.tsx／Features.tsx 同一套）跟 Hero.tsx
// 那顆漸層按鈕的寫法，不多裝新套件。
//
// **2026-08-11 改成可重複使用的參數化元件**：一開始只有「閒置動作＋語音閒聊」一組寫死
// 的內容，這次要多展示兩個功能（角色收藏庫、對角線交叉飛行），把文字/圖示/方向都抽成
// props，三個 <FeatureSpotlight> 各自傳不同內容，不是複製貼上三份幾乎一樣的檔案。
// visualIcon／accessoryIcon 刻意直接沿用 Features.tsx 六宮格同一個功能對應的 lucide
// icon（角色收藏庫＝Users、對角線交叉飛行＝Move），讓使用者看得出「這個大版面是六宮格
// 裡哪一項的放大展示」，不是另外生一套不相干的圖示語彙。
export type FeatureSpotlightProps = {
  badgeIcon: LucideIcon
  badgeText: string
  heading: ReactNode
  description: string
  ctaHref?: string
  ctaText?: string
  visualIcon: LucideIcon
  accessoryIcon: LucideIcon
  accessoryLabel: string
  accessorySub: string
  /** true 時視覺面板放左邊、文字放右邊（桌面版），手機仍固定文字在上，維持閱讀順序。 */
  reverse?: boolean
  /** 掛在視覺面板（右下角那個漸層方塊）本身的 ref，讓外面的呼叫端能量到這塊面板目前
      的畫面位置——例如 HeroLive2DStage 的 flyIn() 要知道角色該飛到哪裡，見
      DesktopPetPage.tsx「閒置動作＋語音閒聊」那個 spotlight 的用法。 */
  visualPanelRef?: Ref<HTMLDivElement>
  /** 疊在視覺面板右下角的額外互動元件（例如觸發 flyIn 的按鈕），跟主要的 CTA 按鈕
      （在文字欄位裡）分開，不佔用文字欄位版面。刻意放右下角而不是外層卡片的角落——
      使用者要求按鈕要在「這個區塊的空白處（視覺面板）右下角」，不是整張卡片的角落。 */
  cornerAction?: ReactNode
}

export function FeatureSpotlight({
  badgeIcon: BadgeIcon,
  badgeText,
  heading,
  description,
  ctaHref = '#how-it-works',
  ctaText = '了解怎麼開始',
  visualIcon: VisualIcon,
  accessoryIcon: AccessoryIcon,
  accessoryLabel,
  accessorySub,
  reverse = false,
  visualPanelRef,
  cornerAction,
}: FeatureSpotlightProps) {
  const headingId = useId()
  const reduceMotion = useReducedMotion()
  const x = useMotionValue(0)
  const y = useMotionValue(0)
  const rotateX = useTransform(y, [-100, 100], [12, -12])
  const rotateY = useTransform(x, [-100, 100], [-12, 12])

  function handleMouseMove(e: MouseEvent<HTMLDivElement>) {
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
    <section aria-labelledby={headingId} className="mx-auto max-w-6xl px-4 py-8">
      <div
        className={cn(
          'relative grid grid-cols-1 items-center gap-12 overflow-hidden rounded-3xl border border-violet-200/60 bg-white p-8 shadow-xl shadow-violet-500/10 md:grid-cols-2 md:p-12',
          'dark:border-violet-900/40 dark:bg-stone-900',
        )}
      >
        <motion.div
          initial={reduceMotion ? undefined : { opacity: 0, y: -16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.5 }}
          className={cn(
            'flex flex-col items-center gap-5 text-center md:items-start md:text-left',
            reverse && 'md:order-2',
          )}
        >
          <span className="inline-flex items-center gap-1.5 rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-xs font-medium text-violet-800 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-300">
            <BadgeIcon className="size-3.5" aria-hidden="true" />
            {badgeText}
          </span>
          <h2
            id={headingId}
            className="text-3xl font-bold tracking-tight text-stone-900 md:text-4xl dark:text-white"
          >
            {heading}
          </h2>
          <p className="max-w-md text-lg leading-relaxed text-stone-600 dark:text-stone-400">
            {description}
          </p>
          <a
            href={ctaHref}
            className={cn(
              'inline-flex items-center gap-2 rounded-lg bg-linear-to-r from-violet-500 to-pink-500 px-6 py-3',
              'text-sm font-semibold text-white shadow-lg shadow-violet-500/30 transition-transform hover:scale-[1.02]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2',
            )}
          >
            {ctaText}
            <ArrowRight className="size-4" aria-hidden="true" />
          </a>
        </motion.div>

        <div
          className={cn(
            'relative flex min-h-[260px] w-full items-center justify-center md:min-h-[320px]',
            reverse && 'md:order-1',
          )}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          style={{ perspective: 1000 }}
        >
          <motion.div
            ref={visualPanelRef}
            style={reduceMotion ? undefined : { rotateX, rotateY, transformStyle: 'preserve-3d' }}
            transition={{ type: 'spring', stiffness: 200, damping: 15 }}
            className={cn(
              'relative flex aspect-square w-full max-w-xs items-center justify-center rounded-[2.5rem]',
              'bg-linear-to-br from-violet-100 via-pink-50 to-pink-100 shadow-2xl shadow-violet-500/20',
              'dark:from-violet-950 dark:via-stone-900 dark:to-pink-950',
            )}
          >
            <VisualIcon className="size-20 text-violet-400 dark:text-violet-500" aria-hidden="true" />
            {/* 跟 Hero.tsx 同一個「閒聊中」對話泡泡視覺語言，這裡放大當作這個區塊的
                主視覺配件，內容依 accessoryIcon/Label/Sub 換成對應這個功能的提示。 */}
            <motion.div
              className={cn(
                'absolute -bottom-5 -left-5 flex items-center gap-2 rounded-xl border border-stone-200 bg-white px-4 py-3 shadow-lg',
                'dark:border-stone-800 dark:bg-stone-900',
              )}
              style={{ transform: 'translateZ(60px)' }}
              animate={reduceMotion ? undefined : { y: [0, 6, 0] }}
              transition={{ duration: 5, repeat: Infinity, ease: 'easeInOut' }}
            >
              <AccessoryIcon className="size-5 text-pink-500" aria-hidden="true" />
              <div>
                <p className="text-xs text-stone-500 dark:text-stone-400">{accessoryLabel}</p>
                <p className="text-sm font-bold text-stone-900 dark:text-white">{accessorySub}</p>
              </div>
            </motion.div>

            {cornerAction && (
              <div className="absolute -right-5 -bottom-5 z-10" style={{ transform: 'translateZ(60px)' }}>
                {cornerAction}
              </div>
            )}
          </motion.div>
        </div>
      </div>
    </section>
  )
}

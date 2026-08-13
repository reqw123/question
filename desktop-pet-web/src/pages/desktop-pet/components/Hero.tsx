import { useState, type Ref } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { ArrowRight, MessageCircle, MousePointer2, Sparkles } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { HeroLive2DStage, type ActiveModelHandle, type HeroLive2DStageHandle } from './HeroLive2DStage'
import { GestureDragControl } from './gesture-drag/GestureDragControl'
import { MAX_ESCAPED_MODELS } from '../config'

// **2026-08-11「液態極光」改版**：原本兩顆模糊圓點只有位置漂移，這次加了第三顆
// （紫粉之間搭一顆桃紅，讓三色更像連續的極光色帶而不是兩塊各自獨立的光暈）跟
// borderRadius 有機變形（四個角的圓角比例分別animate，讓形狀本身也在流動，不只是
// 位置在飄）。靈感來自 21st.dev 的「LiquidAurora」，但那個元件抓下來的原始碼只有
// 三個空 div、實際的 CSS/keyframes 沒有包在回傳結果裡（只有 registry 裡沒有這個檔案），
// 沒有東西可以照抄，這裡是照同一個概念（純 CSS/transform 的極光形狀動畫，不用 WebGL）
// 自己刻的等效版本——這個專案這幾輪一直在避免幫首屏一定會看到的東西加 WebGL/canvas
// 成本（3D 展示區塊都特地做了「捲到才載入」），Hero 背景是一進頁面就看到、沒辦法延遲
// 載入的東西，維持純 CSS transform／opacity／border-radius（GPU 合成、不吃額外算圖
// 成本）是刻意的選擇，不是漏做了什麼。
function GlowBackground() {
  const reduceMotion = useReducedMotion()

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      <div
        className={cn(
          'absolute inset-0 opacity-[0.4] dark:opacity-[0.15]',
          'bg-[radial-gradient(circle,var(--color-violet-400)_1px,transparent_1px)]',
          '[background-size:28px_28px]',
          '[mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,black_40%,transparent_90%)]',
        )}
      />

      <motion.div
        className="absolute -top-32 left-1/4 size-[26rem] bg-violet-300/40 blur-3xl dark:bg-violet-500/25"
        animate={
          reduceMotion
            ? undefined
            : {
                x: [0, 40, -20, 0],
                y: [0, -20, 30, 0],
                borderRadius: ['42% 58% 65% 35% / 45% 40% 60% 55%', '65% 35% 40% 60% / 55% 65% 35% 45%', '42% 58% 65% 35% / 45% 40% 60% 55%'],
              }
        }
        transition={{ duration: 18, repeat: Infinity, ease: 'easeInOut' }}
        style={reduceMotion ? { borderRadius: '50%' } : undefined}
      />
      <motion.div
        className="absolute top-16 left-1/2 size-[19rem] -translate-x-1/2 bg-fuchsia-300/30 blur-3xl dark:bg-fuchsia-600/20"
        animate={
          reduceMotion
            ? undefined
            : {
                x: [0, 25, -35, 0],
                y: [0, 25, -10, 0],
                borderRadius: ['55% 45% 35% 65% / 40% 55% 45% 60%', '35% 65% 55% 45% / 60% 40% 55% 45%', '55% 45% 35% 65% / 40% 55% 45% 60%'],
              }
        }
        transition={{ duration: 20, repeat: Infinity, ease: 'easeInOut' }}
        style={reduceMotion ? { borderRadius: '50%' } : undefined}
      />
      <motion.div
        className="absolute top-0 right-1/4 size-[22rem] bg-pink-300/30 blur-3xl dark:bg-pink-600/20"
        animate={
          reduceMotion
            ? undefined
            : {
                x: [0, -30, 20, 0],
                y: [0, 30, -10, 0],
                borderRadius: ['65% 35% 45% 55% / 55% 45% 65% 35%', '45% 55% 65% 35% / 35% 65% 45% 55%', '65% 35% 45% 55% / 55% 45% 65% 35%'],
              }
        }
        transition={{ duration: 22, repeat: Infinity, ease: 'easeInOut' }}
        style={reduceMotion ? { borderRadius: '50%' } : undefined}
      />
    </div>
  )
}

function GradientHeading() {
  const reduceMotion = useReducedMotion()

  return (
    <motion.h1
      className={cn(
        'bg-clip-text text-4xl font-extrabold tracking-tight text-transparent sm:text-5xl lg:text-6xl',
        'bg-[linear-gradient(90deg,var(--color-violet-600),var(--color-pink-600),var(--color-violet-600))]',
        'dark:bg-[linear-gradient(90deg,var(--color-violet-400),var(--color-pink-400),var(--color-violet-400))]',
      )}
      style={{ backgroundSize: '200% auto' }}
      animate={reduceMotion ? undefined : { backgroundPosition: ['0% center', '200% center'] }}
      transition={{ duration: 8, repeat: Infinity, ease: 'linear' }}
    >
      有牠在，桌面就不只是桌面
    </motion.h1>
  )
}

export function Hero({
  stageRef,
  onFlyInStateChange,
}: {
  // HeroLive2DStageHandle 的 ref，交給 DesktopPetPage.tsx 保管——「叫大家飛出來」的
  // 觸發按鈕搬到頁面下方的 Spotlight 卡片裡了（不在 Hero 這個元件的版面範圍內），
  // Hero 自己不再需要拿著這個 ref，純粹轉手給 HeroLive2DStage。
  stageRef?: Ref<HeroLive2DStageHandle>
  onFlyInStateChange?: (flying: boolean) => void
}) {
  const reduceMotion = useReducedMotion()
  // HeroLive2DStage 目前顯示中模型的 handle，只用來餵給 GestureDragControl 這個平行
  // 元件——Hero 只是轉手，不自己讀寫 handle 內容，見 docs/specs/0010。
  const [activeHandle, setActiveHandle] = useState<ActiveModelHandle | null>(null)
  // 蓋住整個 Hero 區塊的無裁切容器：真正承載 PIXI <canvas> 的地方（見
  // HeroLive2DStage.tsx），也是手勢拖曳準心疊圖的 portal target。pointer-events-none，
  // z-10 疊在文字/按鈕上面，被拖出去的角色才看得到蓋在標題上，點擊觸發技能動作走的是
  // HeroLive2DStage 自己那顆對齊卡片外框的透明 <button>，不需要這層開放 pointer-events。
  // Hero 這個 <section> 本身有 overflow-hidden，模型平常跑不出這個區塊；唯一的例外是
  // flyIn() 飛到頁面下方 Spotlight 卡片時，會暫時把這個容器蓋成 position:fixed 蓋滿
  // viewport（見 HeroLive2DStage.tsx flyInImpl 的說明），飛完會自動還原成這裡的
  // className，不用 Hero 自己處理。
  const [canvasHostEl, setCanvasHostEl] = useState<HTMLDivElement | null>(null)

  return (
    // **沒有 isolate**：這裡曾經跟 overflow-hidden 一起加了 isolate（常見的防禦性
    // Tailwind 搭配），但 isolation:isolate 會讓這個 <section> 變成一個獨立的堆疊
    // 情境（stacking context）——裡面的 canvasHost 就算飛行時把自己蓋成
    // position:fixed z-index:50，也只在 Hero 自己這個堆疊情境裡蓋得住東西，
    // 一出了 Hero 的範圍（例如飛到頁面下方的 Spotlight 卡片），會被後面文件順序在
    // Hero 之後的區塊整個蓋過去、變成完全看不見（flyIn 剛做出來時真的踩到這個坑，
    // 角色位置/visible 都是對的，畫面上就是沒東西）。拿掉 isolate 讓 canvasHost 的
    // position:fixed 能真的參與到最外層（document 根）的堆疊順序，z-index:50 才會
    // 是全頁面等級的「蓋在最上面」，不是只在 Hero 內部有效。Hero 自己內部的圖層順序
    // （canvasHost z-10 蓋在文字上面、GlowBackground 在最底層）不靠 isolate 也一樣
    // 成立，純粹是 relative + overflow-hidden + 各自的 z-index 就夠。
    <section className="relative overflow-hidden">
      <GlowBackground />

      <div className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-12 px-4 py-24 lg:grid-cols-2 lg:py-32">
        <div className="text-center lg:text-left">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-xs font-medium text-violet-800 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-300">
            <Sparkles className="size-3.5" aria-hidden="true" />
            Live2D 桌面掛件・個人原型作品
          </span>

          <div className="mt-6">
            <GradientHeading />
          </div>

          <p className="mx-auto mt-4 max-w-xl text-lg text-stone-600 lg:mx-0 dark:text-stone-400">
            一隻可以拖著走、會閒聊、會耍萌的透明桌面小夥伴。預設點擊穿透、安靜待在角落，切到互動模式就能摸摸牠、看牠玩幾招。這是還在慢慢長大的個人原型，不是商業產品。
          </p>

          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row lg:justify-start">
            <motion.a
              href="#how-it-works"
              whileHover={
                reduceMotion ? undefined : { scale: 1.04, boxShadow: '0 0 32px 4px rgba(147,51,234,0.35)' }
              }
              whileTap={reduceMotion ? undefined : { scale: 0.97 }}
              transition={{ type: 'spring', stiffness: 400, damping: 20 }}
              className={cn(
                'inline-flex items-center gap-2 rounded-lg bg-linear-to-r from-violet-500 to-pink-500 px-6 py-3',
                'text-sm font-semibold text-white shadow-lg shadow-violet-500/30',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2',
              )}
            >
              了解怎麼開始
              <ArrowRight className="size-4" aria-hidden="true" />
            </motion.a>

            <a
              href="#features"
              className={cn(
                'inline-flex items-center gap-2 rounded-lg border border-stone-300 px-6 py-3',
                'text-sm font-semibold text-stone-900 transition-colors hover:bg-stone-100',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2',
                'dark:border-stone-700 dark:text-white dark:hover:bg-stone-900',
              )}
            >
              <MousePointer2 className="size-4" aria-hidden="true" />
              看看牠能幹嘛
            </a>
          </div>
        </div>

        <div className="mx-auto w-full max-w-sm lg:max-w-md">
          <motion.div
            className="relative"
            animate={reduceMotion ? undefined : { y: [0, -14, 0] }}
            transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut' }}
          >
            <HeroLive2DStage
              ref={stageRef}
              onActiveModelChange={setActiveHandle}
              onFlyInStateChange={onFlyInStateChange}
              canvasHost={canvasHostEl}
              maxEscapedModels={MAX_ESCAPED_MODELS}
              className={cn(
                'aspect-square rounded-[2.5rem] border border-violet-200/60 bg-linear-to-br from-violet-100 via-pink-50 to-pink-100 shadow-2xl shadow-violet-500/20',
                'dark:border-violet-900/40 dark:from-violet-950 dark:via-stone-900 dark:to-pink-950',
              )}
            />

            <motion.div
              className="absolute -bottom-4 -left-4 flex items-center gap-2 rounded-xl border border-stone-200 bg-white px-4 py-3 shadow-lg dark:border-stone-800 dark:bg-stone-900"
              animate={reduceMotion ? undefined : { y: [0, 6, 0] }}
              transition={{ duration: 5, repeat: Infinity, ease: 'easeInOut', delay: 0.5 }}
            >
              <MessageCircle className="size-5 text-pink-500" aria-hidden="true" />
              <div>
                <p className="text-xs text-stone-500 dark:text-stone-400">閒聊中</p>
                <p className="text-sm font-bold text-stone-900 dark:text-white">按 F9 摸摸牠</p>
              </div>
            </motion.div>
          </motion.div>

          <GestureDragControl handle={activeHandle} canvasHost={canvasHostEl} />
        </div>
      </div>

      <div ref={setCanvasHostEl} className="pointer-events-none absolute inset-0 z-10" aria-hidden="true" />
    </section>
  )
}

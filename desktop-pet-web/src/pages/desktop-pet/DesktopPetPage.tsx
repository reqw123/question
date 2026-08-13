import { useRef, useState } from 'react'
import { MessageCircle, Move, Sparkles, Users } from 'lucide-react'
import { cn } from '../../lib/utils'
import { Hero } from './components/Hero'
import { ControlPanel } from './components/ControlPanel'
import { Features } from './components/Features'
import { FeatureSpotlight } from './components/FeatureSpotlight'
import { Aatrox3DShowcase } from './components/Aatrox3DShowcase'
import { HowItWorks } from './components/HowItWorks'
import { FAQ } from './components/FAQ'
import { CTA } from './components/CTA'
import type { HeroLive2DStageHandle } from './components/HeroLive2DStage'

export function DesktopPetPage() {
  // 「叫大家飛出來」：按鈕在下面「閒置動作＋語音閒聊」Spotlight 卡片的視覺面板右下角
  // （使用者要求），實際飛行的角色／畫布在 Hero 區塊（見 HeroLive2DStage.tsx）——
  // 這兩個元件在頁面上隔得很遠，這個 ref／flyTargetRef 是唯一的橋接點，只有這一層
  // （DesktopPetPage）同時認識兩邊，順理成章放在這裡管理，不下放到任何一個子元件。
  const stageRef = useRef<HeroLive2DStageHandle>(null)
  const flyTargetRef = useRef<HTMLDivElement>(null)
  const [flying, setFlying] = useState(false)

  return (
    <main className="min-h-svh bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
      <Hero stageRef={stageRef} onFlyInStateChange={setFlying} />
      <ControlPanel />
      <Features />

      {/* 三個 FeatureSpotlight，各自放大展示 Features.tsx 六宮格裡的一項——badgeIcon／
          visualIcon 刻意沿用該項目在六宮格用的同一個 lucide icon（角色收藏庫＝Users、
          對角線交叉飛行＝Move），reverse 交替 false/true/false 做出左右錯落的節奏，
          不是三個都同一個方向、看起來像複製貼上。 */}
      <FeatureSpotlight
        badgeIcon={MessageCircle}
        badgeText="閒置動作＋語音閒聊"
        heading={
          <>
            不用點牠，<span className="text-pink-500">她自己會動</span>
          </>
        }
        description="安靜待在角落時牠不是靜止的——會自動輪流做動作、切換表情，偶爾冒出對話泡泡和小聲音效，像真的有人待在你桌面一角，不用你主動理牠也會有反應。"
        visualIcon={Sparkles}
        accessoryIcon={MessageCircle}
        accessoryLabel="閒聊中"
        accessorySub="按 F9 摸摸牠"
        visualPanelRef={flyTargetRef}
        cornerAction={
          <button
            type="button"
            onClick={() => stageRef.current?.flyIn(flyTargetRef.current)}
            disabled={flying}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border border-violet-200 bg-white/90 px-3.5 py-2',
              'text-xs font-medium text-violet-700 shadow-lg backdrop-blur-sm transition-colors hover:bg-violet-50',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2',
              'disabled:cursor-not-allowed disabled:opacity-60',
              'dark:border-violet-800 dark:bg-stone-900/90 dark:text-violet-300 dark:hover:bg-stone-800',
            )}
          >
            <Users className="size-3.5" aria-hidden="true" />
            {flying ? '角色們正在飛…' : '叫大家飛出來'}
          </button>
        }
      />

      <FeatureSpotlight
        reverse
        badgeIcon={Users}
        badgeText="角色收藏庫"
        heading={
          <>
            想換誰，<span className="text-pink-500">系統匣點兩下</span>就好
          </>
        }
        description="系統匣選單直接挑角色一、角色二，套用後立即換裝，不用改設定檔、不用重開機——上面 Hero 區塊那組角色輪播（Live2D、Spine 骨骼動畫，一路到真正的 3D 模型）也是同一套「隨時可以換一個看看」的精神。"
        visualIcon={Users}
        accessoryIcon={Sparkles}
        accessoryLabel="角色收藏庫"
        accessorySub="7 位角色隨你挑"
      />

      <FeatureSpotlight
        badgeIcon={Move}
        badgeText="特技模式"
        heading={
          <>
            不只是待機，<span className="text-pink-500">她也會耍寶</span>
          </>
        }
        description="想看牠耍寶就開特技模式，角色會在畫面上來回飛行，像在跟你玩鬧一樣，再點一次收工，隨時開關不留痕跡。"
        visualIcon={Move}
        accessoryIcon={Sparkles}
        accessoryLabel="特技模式"
        accessorySub="再點一次收工"
      />

      <Aatrox3DShowcase />
      <HowItWorks />
      <FAQ />
      <CTA />
    </main>
  )
}

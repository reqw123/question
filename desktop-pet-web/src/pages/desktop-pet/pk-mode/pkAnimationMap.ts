// 手勢 PK 對戰模式的角色動作對照表。查證過 aatrox-crimson-moon.glb／
// 菁英計畫_魔鬥凱薩.glb 兩份模型實際的動畫 clip 名稱（見 docs/specs/0013「動畫對照表」）
// ——兩邊都有 Attack1/Attack2/Death/Respawn 等同名 clip，但防禦動畫不對稱（Mordekaiser
// 有明確的護盾動畫，Aatrox 沒有對應物），所以各自定義一份，不共用同一個字串常數。

import type { PlayerSlot } from './pkProtocol'

export type PkCharacterAnimations = {
  displayName: string
  modelUrl: string
  idle: string
  attack: string
  defense: string
  death: string
}

export const PK_ANIMATION_MAP: Record<PlayerSlot, PkCharacterAnimations> = {
  player1: {
    // Aatrox——沿用 Aatrox3DShowcase.tsx 既有的 DEFAULT_ANIMATION／ATTACK_CLIP_NAME，
    // 沒有真正的護盾/格擋動畫，用蓄力戒備姿勢代打，最接近「防禦」的語感。
    displayName: 'Aatrox',
    modelUrl: '/characters/models/亞托克斯_腥紅之月/aatrox-crimson-moon.glb',
    idle: 'Idle_in_sheath',
    attack: 'Attack2',
    defense: 'Channel_Wndup',
    death: 'Death',
  },
  player2: {
    // Mordekaiser——Battle_Idle 比純 Idle.anm 更有「在對戰」的語感；防禦動畫是他本來
    // 就有的護盾技能動畫，語意上完全對應，不是代打。
    displayName: 'Mordekaiser',
    modelUrl: '/characters/models/菁英計畫_魔鬥凱薩.glb',
    idle: 'Battle_Idle',
    attack: 'Attack2',
    defense: 'Spell2_Consume_Shield.anm',
    death: 'Death',
  },
}

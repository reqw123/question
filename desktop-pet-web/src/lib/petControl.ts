const BASE_URL = 'http://127.0.0.1:47821'

export type PetStatus = {
  visible: boolean
  clickThrough: boolean
  isFlying: boolean
  /** 切成互動模式後，若逾時沒人再手動切一次會自動跳回穿透模式的時間點（epoch ms），沒有安全網倒數時是 null */
  interactiveAutoRevertAt: number | null
}

async function call(path: string, method: 'GET' | 'POST'): Promise<PetStatus | null> {
  try {
    const res = await fetch(`${BASE_URL}${path}`, { method })
    if (!res.ok) return null
    const data = await res.json()
    return data.ok ? (data as PetStatus & { ok: true }) : null
  } catch {
    // fetch 失敗最常見的原因是桌寵 App 根本沒在跑（沒有 npm start），
    // 對呼叫端來說跟「連線被拒絕」沒有本質差異，都當成「離線」處理即可。
    return null
  }
}

export const getPetStatus = () => call('/status', 'GET')
export const showPet = () => call('/show', 'POST')
export const hidePet = () => call('/hide', 'POST')
export const toggleInteractive = () => call('/toggle-interactive', 'POST')
export const triggerRandomMotion = () => call('/motion', 'POST')
export const resetPetPosition = () => call('/reset-position', 'POST')

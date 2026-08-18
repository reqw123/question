import { describe, expect, it } from 'vitest'
import { buildJoinUrl } from './pkJoinUrl'

describe('buildJoinUrl', () => {
  it('hostname 已經是區網 IP 時直接沿用，不需要 lanIp', () => {
    const url = buildJoinUrl({ protocol: 'http:', hostname: '192.168.0.171', port: '5173', lanIp: '' })
    expect(url).toBe('http://192.168.0.171:5173/pk')
  })

  it('hostname 是 localhost 又沒有 lanIp 時回傳 null（還不能顯示網址）', () => {
    const url = buildJoinUrl({ protocol: 'http:', hostname: 'localhost', port: '5173', lanIp: '' })
    expect(url).toBeNull()
  })

  it('hostname 是 localhost 時用 lanIp 替換', () => {
    const url = buildJoinUrl({ protocol: 'http:', hostname: 'localhost', port: '5173', lanIp: '192.168.0.171' })
    expect(url).toBe('http://192.168.0.171:5173/pk')
  })

  it('hostname 是 127.0.0.1 時也用 lanIp 替換', () => {
    const url = buildJoinUrl({ protocol: 'http:', hostname: '127.0.0.1', port: '5173', lanIp: '10.0.0.5' })
    expect(url).toBe('http://10.0.0.5:5173/pk')
  })

  it('lanIp 前後有空白會被 trim', () => {
    const url = buildJoinUrl({ protocol: 'http:', hostname: 'localhost', port: '5173', lanIp: '  192.168.0.171  ' })
    expect(url).toBe('http://192.168.0.171:5173/pk')
  })

  it('沒有 port（例如走 80/443）時網址不帶冒號', () => {
    const url = buildJoinUrl({ protocol: 'https:', hostname: 'example.com', port: '', lanIp: '' })
    expect(url).toBe('https://example.com/pk')
  })
})

import { describe, expect, it } from 'vitest'
import { pkMqttUrl } from './pkMqttUrl'

describe('pkMqttUrl', () => {
  it('http 走區網直連 ws://IP:port', () => {
    expect(pkMqttUrl('192.168.0.171', 'http:', 9001)).toBe('ws://192.168.0.171:9001')
  })

  it('https 走 Caddy 反代 wss://host/mqtt', () => {
    expect(pkMqttUrl('example.com', 'https:', 9001)).toBe('wss://example.com/mqtt')
  })
})

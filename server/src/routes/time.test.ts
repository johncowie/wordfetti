import { describe, it, expect } from 'vitest'
import request from 'supertest'
import express from 'express'
import { createTimeRouter } from './time.js'

const app = express()
app.use('/api/time', createTimeRouter())

describe('GET /api/time', () => {
  it('returns a JSON body with a numeric integer now field close to the current time', async () => {
    const before = Date.now()
    const res = await request(app).get('/api/time')
    const after = Date.now()
    expect(res.status).toBe(200)
    expect(typeof res.body.now).toBe('number')
    expect(Number.isInteger(res.body.now)).toBe(true)
    expect(res.body.now).toBeGreaterThanOrEqual(before)
    expect(res.body.now).toBeLessThanOrEqual(after)
  })

  it('sets Cache-Control: no-store', async () => {
    const res = await request(app).get('/api/time')
    expect(res.headers['cache-control']).toBe('no-store')
  })
})

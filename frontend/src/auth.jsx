import React, { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { apiFetch, login as apiLogin, logout as apiLogout, registerTokenUpdater, getBalance as apiGetBalance, topupBalance as apiTopupBalance, payBooking as apiPayBooking } from './api'

const AuthCtx = createContext(null)

export function AuthProvider({ children }) {
  const [token, setToken] = useState(localStorage.getItem('dl_token') || '')
  const [me, setMe] = useState(null)
  const [balanceInfo, setBalanceInfo] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    registerTokenUpdater(setToken)
  }, [])


  async function loadBalance(tk) {
    try {
      if (!tk) { setBalanceInfo(null); return }
      const b = await apiGetBalance(tk)
      setBalanceInfo(b || null)
    } catch {
      setBalanceInfo(null)
    }
  }

  async function refreshBalance(tk = token) {
    await loadBalance(tk)
  }

  async function topup(amount) {
    if (!token) throw new Error('not authenticated')
    const b = await apiTopupBalance(token, Number(amount || 0))
    setBalanceInfo(b || null)
    return b
  }

  async function payBooking(bookingId) {
    if (!token) throw new Error('not authenticated')
    const out = await apiPayBooking(token, Number(bookingId))
    await loadBalance(token)
    return out
  }


  useEffect(() => {
    let mounted = true
    async function load() {
      try {
        if (!token) {
          if (mounted) { setMe(null); setBalanceInfo(null); setLoading(false) }
          return
        }
        const data = await apiFetch('/api/me', { token })
        if (mounted) setMe(data)
        if (mounted) await loadBalance(token)
      } catch {
        if (mounted) {
          setMe(null)
          setBalanceInfo(null)
          setToken('')
          localStorage.removeItem('dl_token')
        }
      } finally {
        if (mounted) setLoading(false)
      }
    }
    load()
    return () => { mounted = false }
  }, [token])

  const value = useMemo(() => ({
    token,
    me,
    balanceInfo,
    loading,
    refreshBalance,
    topup,
    payBooking,
    async login(email, password) {
      const data = await apiLogin(email, password)
      if (data?.access_token) {
        setToken(data.access_token)
        localStorage.setItem('dl_token', data.access_token)
      }
      if (data?.me) setMe(data.me)
      if (data?.access_token) await loadBalance(data.access_token)
      return data
    },
    async logout() {
      await apiLogout(token)
      setMe(null)
      setBalanceInfo(null)
      setToken('')
      localStorage.removeItem('dl_token')
    },
    async register({ email, password, role }) {
      const data = await apiFetch('/api/auth/register', { method: 'POST', body: { email, password, role } })
      if (data?.access_token) {
        setToken(data.access_token)
        localStorage.setItem('dl_token', data.access_token)
      }
      if (data?.me) setMe(data.me)
      if (data?.access_token) await loadBalance(data.access_token)
      return data
    },
    setMe
  }), [token, me, balanceInfo, loading])

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthCtx)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}

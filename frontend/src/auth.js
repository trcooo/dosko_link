import React, { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { apiFetch, login as apiLogin } from './api'

const AuthCtx = createContext(null)

export function AuthProvider({ children }) {
  const [token, setToken] = useState(localStorage.getItem('dl_token') || '')
  const [me, setMe] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let mounted = true
    async function load() {
      try {
        if (!token) {
          if (mounted) { setMe(null); setLoading(false) }
          return
        }
        const data = await apiFetch('/api/me', { token })
        if (mounted) setMe(data)
      } catch {
        if (mounted) { setMe(null); setToken(''); localStorage.removeItem('dl_token') }
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
    loading,
    async login(email, password) {
      const data = await apiLogin(email, password)
      setToken(data.access_token)
      localStorage.setItem('dl_token', data.access_token)
      return data
    },
    logout() {
      setToken('')
      setMe(null)
      localStorage.removeItem('dl_token')
    },
    async register({ email, password, role }) {
      const data = await apiFetch('/api/auth/register', { method: 'POST', body: { email, password, role } })
      setToken(data.access_token)
      localStorage.setItem('dl_token', data.access_token)
      return data
    }
  }), [token, me, loading])

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthCtx)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}

import React, { useEffect, useState } from 'react'
import { Link, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './auth.jsx'

import Home from './pages/Home'
import Login from './pages/Login'
import Register from './pages/Register'
import TutorProfile from './pages/TutorProfile'
import Dashboard from './pages/Dashboard'
import Room from './pages/Room'
import Learning from './pages/Learning'
import Admin from './pages/Admin'
import Wallet from './pages/Wallet'

function NavBar() {
  const { me, logout, balanceInfo } = useAuth()
  const nav = useNavigate()
  const location = useLocation()
  const [mobileOpen, setMobileOpen] = useState(false)

  const bal = Number(balanceInfo?.balance || 0)
  const earn = Number(balanceInfo?.earnings || 0)

  useEffect(() => {
    setMobileOpen(false)
  }, [location.pathname])

  const closeMenu = () => setMobileOpen(false)

  return (
    <div className="nav">
      <div className="navInner">
        <Link to="/" className="brand" aria-label="DoskoLink — главная" onClick={closeMenu}>
          <img className="brandLogo" src="/doskolink-logo.png" alt="DoskoLink" />
          <div className="brandMeta">
            <div className="small">Платформа для репетиторов</div>
          </div>
        </Link>

        <button
          className="navToggle"
          type="button"
          aria-label={mobileOpen ? 'Закрыть меню' : 'Открыть меню'}
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen((v) => !v)}
        >
          <span />
          <span />
          <span />
        </button>

        <div className={`navLinks ${mobileOpen ? 'open' : ''}`}>
          <Link className="btn btnGhost" to="/" onClick={closeMenu}>{me?.role === 'tutor' ? 'Маркетплейс' : 'Поиск'}</Link>
          {me && me.role !== 'admin' && <Link className="btn btnGhost" to="/dashboard" onClick={closeMenu}>{me.role === 'tutor' ? 'Кабинет репетитора' : 'Кабинет ученика'}</Link>}
          {me && me.role === 'admin' && <Link className="btn btnGhost" to="/admin" onClick={closeMenu}>Админ-панель</Link>}
          {me && me.role !== 'admin' && <Link className="btn btnGhost" to="/learning" onClick={closeMenu}>{me.role === 'tutor' ? 'Ученики / обучение' : 'Учёба'}</Link>}
          {me && me.role !== 'admin' && (
            <Link className="btn btnGhost" to="/wallet" onClick={closeMenu}>
              {me.role === 'tutor' ? 'Доходы' : 'Баланс'}
              <span className="pill" style={{ marginLeft: 8 }}>{bal} ₽</span>
              {me.role === 'tutor' ? <span className="pill" style={{ marginLeft: 6, opacity: .85 }}>+{earn} ₽</span> : null}
            </Link>
          )}
          {!me ? (
            <>
              <Link className="btn" to="/login" onClick={closeMenu}>Войти</Link>
              <Link className="btn btnPrimary" to="/register" onClick={closeMenu}>Регистрация</Link>
            </>
          ) : (
            <>
              <div className="small navIdentity">{me.email} • {me.role}</div>
              <button className="btn" onClick={() => { closeMenu(); logout(); nav('/') }}>Выйти</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <NavBar />
      <div className="container">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/tutor/:id" element={<TutorProfile />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/learning" element={<Learning />} />
          <Route path="/wallet" element={<Wallet />} />
          <Route path="/room/:roomId" element={<Room />} />
          <Route path="/admin" element={<Admin />} />
        </Routes>
      </div>
    </AuthProvider>
  )
}

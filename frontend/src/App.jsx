import React from 'react'
import { Link, Route, Routes, useNavigate } from 'react-router-dom'
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

  const bal = Number(balanceInfo?.balance || 0)
  const earn = Number(balanceInfo?.earnings || 0)

  return (
    <div className="nav">
      <div className="navInner">
        <Link to="/" className="brand" aria-label="DoskoLink — главная">
          <img className="brandLogo" src="/doskolink-logo.png" alt="DoskoLink" />
          <div className="brandMeta">
            <div className="small">Платформа для репетиторов</div>
          </div>
        </Link>

        <div className="navLinks">
          <Link className="btn btnGhost" to="/">{me?.role === 'tutor' ? 'Маркетплейс' : 'Поиск'}</Link>
          {me && me.role !== 'admin' && <Link className="btn btnGhost" to="/dashboard">{me.role === 'tutor' ? 'Кабинет репетитора' : 'Кабинет ученика'}</Link>}
          {me && me.role === 'admin' && <Link className="btn btnGhost" to="/admin">Админ-панель</Link>}
          {me && me.role !== 'admin' && <Link className="btn btnGhost" to="/learning">{me.role === 'tutor' ? 'Ученики / обучение' : 'Учёба'}</Link>}
          {me && me.role !== 'admin' && (
            <Link className="btn btnGhost" to="/wallet">
              {me.role === 'tutor' ? 'Доходы' : 'Баланс'}
              <span className="pill" style={{ marginLeft: 8 }}>{bal} ₽</span>
              {me.role === 'tutor' ? <span className="pill" style={{ marginLeft: 6, opacity: .85 }}>+{earn} ₽</span> : null}
            </Link>
          )}
          {!me ? (
            <>
              <Link className="btn" to="/login">Войти</Link>
              <Link className="btn btnPrimary" to="/register">Регистрация</Link>
            </>
          ) : (
            <>
              <div className="small">{me.email} • {me.role}</div>
              <button className="btn" onClick={() => { logout(); nav('/') }}>Выйти</button>
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

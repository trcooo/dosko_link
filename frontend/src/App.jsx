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

function NavBar() {
  const { me, logout } = useAuth()
  const nav = useNavigate()

  return (
    <div className="nav">
      <div className="navInner">
        <Link to="/" className="brand">
          <div className="badge">DL</div>
          <div>
            <div>ДоскоЛинк</div>
            <div className="small">MVP без оплат</div>
          </div>
        </Link>

        <div className="navLinks">
          <Link className="btn btnGhost" to="/">Поиск</Link>
          {me && <Link className="btn btnGhost" to="/dashboard">Кабинет</Link>}
          {me && <Link className="btn btnGhost" to="/learning">Учёба</Link>}
          {me && me.role === 'admin' && <Link className="btn btnGhost" to="/admin">Админ</Link>}
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
          <Route path="/room/:roomId" element={<Room />} />
          <Route path="/admin" element={<Admin />} />
        </Routes>
      </div>
    </AuthProvider>
  )
}
